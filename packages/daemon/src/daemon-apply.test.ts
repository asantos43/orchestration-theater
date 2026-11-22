// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { ApiHealthSchema, ApiUpdateStatusSchema } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle, type UpdatesOptions } from './daemon.js';
import { makeRepo, until } from './execution/attempt-fixture.js';
import type { AttemptSpec } from './execution/attempt-runner.js';
import { createSilentLogger } from './logger.js';
import { dataPaths } from './paths.js';
import {
  editingTransport,
  editsPrompt,
  makeTempDataDir,
  NO_CLIENTS,
  TEST_POLICY,
  TEST_PROFILE,
} from './test-helpers.js';
import { readJournal } from './updates/apply/journal.js';
import { layoutOf } from './updates/apply/layout.js';
import {
  buildRelease,
  FakeOrigin,
  makeKeys,
  TEST_ORIGIN,
  type TestKeys,
} from './updates/release-fixture.js';

/**
 * Applying an update in a daemon that is running (Phase 10, P8): `GET /v1/health`,
 * `POST /v1/updates/apply`, and the `park` moment, where the clean stop leaves the running attempt
 * `awaiting_resume` and the daemon that comes back resumes it by `session/load`. The applier is not
 * started: the daemon is given a fake `launch`, so no executable is replaced and no process starts.
 */

const TEST_TIMEOUT_MS = 60_000;
const NEW_BODY = Buffer.from('#!/bin/sh\necho ok\n# new\n');
const SAME_SCHEMAS = { schemas: { store: 10, telemetry: 3 } };

afterAll(disposeTestGitIsolation);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  readonly dir: string;
  readonly installDir: string;
  readonly exe: string;
  readonly keys: TestKeys;
  readonly updates: UpdatesOptions;
  readonly launched: string[][];
}

async function fixture(): Promise<Fixture> {
  const tmp = await makeTempDataDir();
  cleanups.push(() => tmp.dispose());
  const installDir = await mkdtemp(join(tmpdir(), 'ot-daemon-apply-'));
  cleanups.push(() => rm(installDir, { recursive: true, force: true }));
  const exe = join(installDir, 'ot');
  await mkdir(installDir, { recursive: true });
  await writeFile(exe, '#!/bin/sh\necho ok\n');
  await chmod(exe, 0o755);
  const keys = makeKeys();
  const origin = new FakeOrigin();
  origin.publish(
    TEST_ORIGIN,
    buildRelease(keys, { version: '0.6.0', exe: NEW_BODY, manifest: SAME_SCHEMAS }),
  );
  const launched: string[][] = [];
  return {
    dir: tmp.dir,
    installDir,
    exe,
    keys,
    launched,
    updates: {
      installKind: 'own',
      platform: 'linux-x64',
      exe,
      publicKey: keys.publicPem,
      fetch: origin.fetch,
      launch: (layout, applierExe) => {
        launched.push([layout.exe, applierExe]);
        return Promise.resolve();
      },
      idlePollMs: 20,
      reportPollMs: 50,
    },
  };
}

const CONFIG = (extra: string): string => `
backup:
  when: manual
limits:
  demand_timeout: 10m
resume:
  checkpoint_edit_batch: 2
  checkpoint_every: 5m
  stuck:
    no_event_for: 1h
  transient_backoff: [1s]
updates:
  source: url
  url: ${TEST_ORIGIN}
  check_interval: off
${extra}`;

async function api(daemon: DaemonHandle, dir: string) {
  const token = (await readFile(dataPaths(dir).apiToken, 'utf8')).trim();
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: (path: string, auth = true) =>
      fetch(`${daemon.api.url}${path}`, { headers: auth ? headers : {} }),
    post: (path: string, body?: unknown) =>
      fetch(`${daemon.api.url}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

async function start(f: Fixture, extra: string): Promise<DaemonHandle> {
  const daemon = await startDaemon({
    dataDir: f.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(CONFIG(extra)),
    overrides: { clock: new FakeClock(), vault: new InMemorySecretVault() },
    logger: createSilentLogger(),
    version: '0.5.0',
    updates: f.updates,
  });
  cleanups.push(() => daemon.stop());
  return daemon;
}

describe('GET /v1/health', () => {
  it('answers 200 with the version and the pid of the daemon, and asks for the token', async () => {
    const f = await fixture();
    const daemon = await start(f, '  mode: notify\n');
    const { get } = await api(daemon, f.dir);
    const response = await get('/v1/health');
    expect(response.status).toBe(200);
    expect(ApiHealthSchema.parse(await response.json())).toEqual({
      status: 'ok',
      version: '0.5.0',
      pid: process.pid,
    });
    expect((await get('/v1/health', false)).status).toBe(401);
  });
});

describe('POST /v1/updates/apply', () => {
  it('is 409 when no version is ready, and 400 for a body that is not one', async () => {
    const f = await fixture();
    const daemon = await start(f, '  mode: check\n');
    const { post } = await api(daemon, f.dir);
    expect((await post('/v1/updates/apply', { how: 'park' })).status).toBe(409);
    expect((await post('/v1/updates/apply', { how: 'tomorrow' })).status).toBe(400);
    expect(f.launched).toEqual([]);
  });

  it('with park, answers the status at once, starts the applier and stops the daemon', async () => {
    const f = await fixture();
    const daemon = await start(f, '  mode: notify\n  apply_when: idle\n');
    const { get, post } = await api(daemon, f.dir);
    await vi.waitFor(async () => {
      const status = ApiUpdateStatusSchema.parse(await (await get('/v1/updates')).json());
      expect(status.ready).toBe('0.6.0');
      expect(status.apply).toMatchObject({ when: 'idle', rollback: 'auto', state: 'none' });
    });

    const response = await post('/v1/updates/apply', { how: 'park' });
    expect(response.status).toBe(200);
    expect(ApiUpdateStatusSchema.parse(await response.json()).apply.state).toBe('applying');

    await vi.waitFor(() => {
      expect(f.launched).toHaveLength(1);
    });
    expect(f.launched[0]?.[0]).toBe(f.exe);
    const layout = layoutOf(f.exe);
    await vi.waitFor(async () => {
      expect((await readJournal(layout.journal)).kind).toBe('ok');
    });
    const reading = await readJournal(layout.journal);
    expect(reading.kind === 'ok' && reading.journal).toMatchObject({
      from: '0.5.0',
      to: '0.6.0',
      step: 'waiting',
      oldPid: process.pid,
      dataDir: f.dir,
    });
    expect((await readFile(layout.stagingExe)).equals(NEW_BODY)).toBe(true);
    // The daemon shut down by itself: the API no longer answers.
    await vi.waitFor(async () => {
      await expect(get('/v1/health')).rejects.toThrow();
    });
  });

  it(
    'park: the running attempt is left awaiting_resume and the next daemon resumes it by session/load',
    async () => {
      const f = await fixture();
      const { repo, dispose } = await makeRepo();
      cleanups.push(dispose);
      const clock = new FakeClock();
      const launcher = new FakeProcessLauncher();
      const transport = new FakeSessionTransport();
      const open = async (): Promise<DaemonHandle> => {
        const daemon = await startDaemon({
          dataDir: f.dir,
          config: parseConfig(CONFIG('  mode: notify\n')),
          overrides: {
            clock,
            vault: new InMemorySecretVault(),
            launcher,
            transport: editingTransport(transport),
          },
          clients: (parts) => [
            new FakeClientAdapter({
              launcher: parts.launcher,
              baseEnv: {},
              adapterVersion: '1.0.0',
              command: { cmd: 'fake-client', args: [] },
            }),
          ],
          resolveAttempt: () => ({
            profile: TEST_PROFILE,
            executor: { model: 'fake-model' },
            policy: TEST_POLICY,
          }),
          logger: createSilentLogger(),
          version: '0.5.0',
          updates: f.updates,
        });
        cleanups.push(() => daemon.stop());
        return daemon;
      };
      const spec: AttemptSpec = {
        playId: 'play-1',
        demandId: 'park',
        attempt: 1,
        repo,
        base: 'main',
        profile: TEST_PROFILE,
        executor: { model: 'fake-model' },
        policy: TEST_POLICY,
        prompt: editsPrompt({ 'park.txt': 'p\n' }, '#script:hang'),
      };

      const first = await open();
      const runner = first.execution?.runner;
      if (runner === undefined) throw new Error('the daemon has no execution');
      const running = runner.run(spec);
      await until(async () => {
        const events = await first.store.events.readFrom(0, 10_000);
        return events.some((event) =>
          JSON.stringify(event.payload).includes('hanging until session/cancel'),
        );
      }, 'the attempt to hang');

      const { get, post } = await api(first, f.dir);
      await vi.waitFor(async () => {
        const status = ApiUpdateStatusSchema.parse(await (await get('/v1/updates')).json());
        expect(status.ready).toBe('0.6.0');
      });
      expect((await post('/v1/updates/apply', { how: 'park' })).status).toBe(200);

      // The clean stop is the "restart of the daemon" of 5.16: interrupted, not failed.
      const left = await running;
      expect(left).toMatchObject({ state: 'interrupted', cause: 'daemon_restart' });
      expect(f.launched).toHaveLength(1);
      // The daemon stops by itself (nothing here calls `stop`); the next one starts when it is done.
      await first.stopped;
      expect(launcher.running).toHaveLength(0);

      // The daemon that comes back (the new version, here the same code) resumes the same conversation.
      const next = await open();
      const record = await next.store.attempts.get(left.attemptId);
      expect(record?.sessionId).toBe(left.sessionId);
      const report = next.execution?.reconciled;
      expect(report?.resuming).toEqual([left.attemptId]);
      await until(() => transport.loaded.some((load) => load.sessionId === left.sessionId), 'load');
      expect(transport.loaded.map((load) => load.sessionId)).toContain(left.sessionId);
      // No attempt of the demand was spent by the swap.
      expect((await next.store.attempts.get(left.attemptId))?.resumes).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
