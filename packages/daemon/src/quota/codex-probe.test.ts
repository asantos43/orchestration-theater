// SPDX-License-Identifier: MPL-2.0
import { CodexQuotaProbe } from '@otheater/adapter-client-codex';
import {
  PROCESS_LAUNCHER_PORT_VERSION,
  type AdapterImplements,
  type LaunchedProcess,
  type LauncherCapabilities,
  type LaunchOptions,
  type ProcessLauncher,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { QuotaService } from './service.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK = 'codex/work';

type Answer = (method: string, id: number) => object | undefined;

/**
 * A `ProcessLauncher` whose processes speak the app-server protocol in memory: each line of the
 * standard input is a request the script answers, so the probe and the service run end to end with no
 * client, no account and no file.
 */
class ScriptedLauncher implements ProcessLauncher {
  readonly id = 'scripted';
  readonly implements: AdapterImplements = {
    port: 'ProcessLauncher',
    range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
  };
  readonly launched: LaunchOptions[] = [];
  readonly killed: number[] = [];

  constructor(readonly answer: Answer) {}

  capabilities(): LauncherCapabilities {
    return { treeKill: 'process-group', memoryLimit: false, suspendedStart: false };
  }

  launch(options: LaunchOptions): Promise<LaunchedProcess> {
    this.launched.push(options);
    const pid = 5000 + this.launched.length;
    const encoder = new TextEncoder();
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let end!: () => void;
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        out = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        end = () => {
          try {
            out.close();
            controller.close();
          } catch {
            // Already closed.
          }
        };
      },
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const done = end;
      end = () => {
        done();
        resolve({ code: null, signal: 'SIGKILL' });
      };
    });
    let pending = '';
    const stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        pending += new TextDecoder().decode(chunk);
        for (;;) {
          const at = pending.indexOf('\n');
          if (at < 0) return;
          const message = JSON.parse(pending.slice(0, at)) as { id?: number; method: string };
          pending = pending.slice(at + 1);
          if (message.id === undefined) continue;
          const reply = this.answer(message.method, message.id);
          if (reply !== undefined) {
            out.enqueue(encoder.encode(`${JSON.stringify({ jsonrpc: '2.0', ...reply })}\n`));
          }
        }
      },
    });
    return Promise.resolve({
      pid,
      stdin,
      stdout,
      stderr,
      exited,
      killTree: () => {
        this.killed.push(pid);
        end();
        return Promise.resolve({ found: 1, forced: false, remaining: [] });
      },
    });
  }
}

const window = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({
  usedPercent,
  windowDurationMins,
  resetsAt,
});

const loggedIn =
  (primary: number, secondary: number): Answer =>
  (method, id) =>
    method === 'account/rateLimits/read'
      ? {
          id,
          result: {
            rateLimits: {
              primary: window(primary, 300, (T0 + 120 * MIN) / 1000),
              secondary: window(secondary, 10080, (T0 + 5000 * MIN) / 1000),
              planType: 'plus',
              rateLimitReachedType: null,
            },
          },
        }
      : { id, result: {} };

const loggedOut: Answer = (method, id) =>
  method === 'account/rateLimits/read'
    ? { id, error: { code: -32000, message: 'Authentication required' } }
    : { id, result: {} };

function build(answer: Answer) {
  const clock = new FakeClock(T0);
  const launcher = new ScriptedLauncher(answer);
  const probe = new CodexQuotaProbe({
    launcher,
    baseEnv: {},
    profileDir: (ref) => `/data/profiles/${ref.client}/${ref.profile}`,
    timeoutMs: 2_000,
    now: () => clock.now(),
  });
  const service = new QuotaService({
    store: new InMemoryStore({ clock }),
    clock,
    settings: { nearLimitAt: 0.8, staleAfterMs: 10 * MIN, delivery: 'poll', pollEveryMs: 5 * MIN },
    logger: createSilentLogger(),
  });
  service.addProbe('codex', probe);
  started.push(service);
  return { clock, launcher, service };
}

const started: QuotaService[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((service) => service.stop()));
});

describe('the Codex quota probe under the QuotaService', () => {
  it('makes a profile with a login ok, with the windows and their resets', async () => {
    const { service, launcher } = build(loggedIn(10, 30));

    const status = await service.refresh(WORK);

    expect(status.state).toBe('ok');
    expect(status.windows.map((one) => one.window)).toEqual(['5h', '7d']);
    expect(status.windows[0]).toMatchObject({ usedPercent: 10, resetsAt: T0 + 120 * MIN });
    expect(await service.canUse(WORK)).toBe(true);
    expect(launcher.launched).toHaveLength(1);
    expect(launcher.killed).toHaveLength(1);
    expect(launcher.launched[0]).toMatchObject({
      cmd: 'codex',
      args: ['app-server'],
      cwd: '/data/profiles/codex/work',
      env: { CODEX_HOME: '/data/profiles/codex/work' },
    });
  });

  it('makes a profile at 100% exhausted until the reset the client reports', async () => {
    const { service } = build(loggedIn(100, 30));

    const status = await service.refresh(WORK);

    expect(status.state).toBe('exhausted');
    expect(status.untilReset).toBe(T0 + 120 * MIN);
    expect(await service.canUse(WORK)).toBe(false);
  });

  it('keeps a profile with no login unknown, never exhausted, and ends the process', async () => {
    const { service, launcher } = build(loggedOut);

    const status = await service.refresh(WORK);

    expect(status.state).toBe('unknown');
    expect(status.state).not.toBe('exhausted');
    expect(await service.canUse(WORK)).toBe(false);
    expect(launcher.killed).toHaveLength(1);
  });

  it('lets a reading age into unknown when the next read finds no login', async () => {
    let answer: Answer = loggedIn(10, 30);
    const { service, clock } = build((method, id) => answer(method, id));
    expect((await service.refresh(WORK)).state).toBe('ok');

    answer = loggedOut;
    await clock.advance(11 * MIN);

    expect((await service.refresh(WORK)).state).toBe('unknown');
  });
});
