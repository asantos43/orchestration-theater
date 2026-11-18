// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  QuotaReadingSchema,
  Transient,
  type ProfileRef,
  type QuotaReading,
} from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexQuotaProbe, type CodexQuotaProbeOptions } from './quota-probe.js';
import { LIMIT_REACHED_WINDOW } from './rate-limits.js';
import { FAKE_RESET_5H, FAKE_RESET_7D, writeFakeAppServer } from './testing/fake-app-server.js';
import { NodeProcessLauncher, treeAlive } from './testing/node-process-launcher.js';

const REF: ProfileRef = { client: 'codex', profile: 'work' };
const NOW = 1_800_000_000_000;

let root: string;
let launcher: NodeProcessLauncher;
let server: { cmd: string; args: readonly string[] };
let log: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ot-codex-quota-'));
  launcher = new NodeProcessLauncher();
  server = await writeFakeAppServer(join(root, 'bin'));
  log = join(root, 'requests.log');
  await mkdir(profileDir(), { recursive: true });
});

afterEach(async () => {
  await launcher.killAll();
  await rm(root, { recursive: true, force: true });
});

function profileDir(): string {
  return join(root, 'profiles', 'work');
}

function build(
  scenario: string,
  extra: Partial<CodexQuotaProbeOptions> = {},
  env: Record<string, string> = {},
): CodexQuotaProbe {
  return new CodexQuotaProbe({
    launcher,
    baseEnv: { FAKE_APP_SCENARIO: scenario, FAKE_LOG: log, ...env },
    profileDir: () => profileDir(),
    command: server,
    timeoutMs: 5_000,
    now: () => NOW,
    ...extra,
  });
}

async function requests(): Promise<string[]> {
  try {
    return (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

async function until(done: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('condition not met in time');
}

describe('CodexQuotaProbe.read', () => {
  it('turns the rate limits of the app-server into windows with resetsAt and planType', async () => {
    const reading = await build('ok').read(REF);

    expect(reading).toEqual({
      observedAt: NOW,
      windows: [
        { window: '5h', usedPercent: 12, resetsAt: FAKE_RESET_5H * 1000 },
        { window: '7d', usedPercent: 40, resetsAt: FAKE_RESET_7D * 1000 },
      ],
      planType: 'plus',
    });
    expect(() => QuotaReadingSchema.parse(reading)).not.toThrow();
  });

  it('runs the app-server inside the profile, asks only for the rate limits and leaves no process', async () => {
    await build('ok').read(REF);

    expect(await requests()).toEqual([
      `CODEX_HOME=${profileDir()}`,
      `CWD=${await realCwd()}`,
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('keeps a profile without login unknown: AdapterUnavailable, never a reading', async () => {
    const probe = build('noauth');

    await expect(probe.read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
    await expect(probe.read(REF)).rejects.toThrow(/no login/u);
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('reads an app-server that says "Authentication required" and exits as no login too', async () => {
    await expect(build('noauth-exit').read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('ends the whole tree when the app-server does not answer in time', async () => {
    const pidFile = join(root, 'child.pid');
    const probe = build('hang', { timeoutMs: 400 }, { FAKE_CHILD_PID_FILE: pidFile });

    await expect(probe.read(REF)).rejects.toBeInstanceOf(Transient);

    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(Number.isInteger(childPid)).toBe(true);
    await until(() => !treeAlive(childPid));
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('rejects with AdapterUnavailable when the command does not exist', async () => {
    const probe = build('ok', { command: { cmd: join(root, 'no-such-codex'), args: [] } });

    await expect(probe.read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('ignores lines that are not protocol', async () => {
    const reading = await build('garbage').read(REF);

    expect(reading.windows.map((one) => one.window)).toEqual(['5h', '7d']);
  });

  it('turns a reached limit with no window at 100% into the window limit_reached', async () => {
    const reading = await build('reached').read(REF);

    expect(reading.windows).toEqual([{ window: LIMIT_REACHED_WINDOW, usedPercent: 100 }]);
    expect(reading.planType).toBe('plus');
  });

  it('does not make a reading of an account with no window', async () => {
    await expect(build('empty').read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
    await expect(build('shape').read(REF)).rejects.toBeInstanceOf(Transient);
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('refuses a profile it was not given a directory for', async () => {
    const probe = build('ok', {
      profileDir: (ref) => {
        throw new AdapterUnavailable(`no directory for ${ref.profile}`);
      },
    });

    await expect(probe.read(REF)).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(launcher.pids).toHaveLength(0);
  });

  it('prepares the profile before it starts the app-server', async () => {
    const order: string[] = [];
    const probe = build('ok', {
      prepare: (ref, dir) => {
        order.push(`prepare ${ref.profile} ${dir}`);
        return Promise.resolve();
      },
    });

    await probe.read(REF);

    expect(order).toEqual([`prepare work ${profileDir()}`]);
  });

  it('does not depend on a credential file: one that cannot be read changes nothing', async () => {
    const canary = join(profileDir(), 'credential-canary.json');
    await writeFile(canary, '{"canary":true}', { mode: 0o000 });

    const reading = await build('ok').read(REF);

    expect(reading.windows).toHaveLength(2);
  });
});

describe('CodexQuotaProbe.capabilities', () => {
  it('is a poll with no promised window by default', () => {
    expect(build('ok').capabilities()).toEqual({
      windows: [],
      delivery: 'poll',
      precision: 'approximate',
    });
  });

  it('is both with watch resident, and lists the windows it is given', () => {
    const probe = build('ok', { watch: 'resident', windows: ['5h', '7d'] });

    expect(probe.capabilities()).toEqual({
      windows: ['5h', '7d'],
      delivery: 'both',
      precision: 'approximate',
    });
    expect(probe.implements).toEqual({ port: 'QuotaProbe', range: `^${QUOTA_PROBE_PORT_VERSION}` });
  });

  it('refuses a watch mode and a timeout it does not know', () => {
    expect(() => build('ok', { watch: 'always' as 'off' })).toThrow(/not supported/u);
    expect(() => build('ok', { timeoutMs: 0 })).toThrow(/positive/u);
  });
});

describe('CodexQuotaProbe.watch', () => {
  it('starts nothing when the watch is off', async () => {
    const readings: QuotaReading[] = [];

    const sub = build('sparse').watch(REF, (reading) => readings.push(reading));
    await new Promise((resolve) => setTimeout(resolve, 150));
    sub.dispose();

    expect(readings).toEqual([]);
    expect(launcher.pids).toHaveLength(0);
  });

  it('delivers the read and then each updated notification merged into the last one', async () => {
    const readings: QuotaReading[] = [];
    const probe = build('sparse', { watch: 'resident' });

    const sub = probe.watch(REF, (reading) => readings.push(reading));
    await until(() => readings.length === 3);
    sub.dispose();

    expect(readings.map((one) => one.windows)).toEqual([
      [
        { window: '5h', usedPercent: 12, resetsAt: FAKE_RESET_5H * 1000 },
        { window: '7d', usedPercent: 40, resetsAt: FAKE_RESET_7D * 1000 },
      ],
      [
        { window: '5h', usedPercent: 55, resetsAt: (FAKE_RESET_5H + 60) * 1000 },
        { window: '7d', usedPercent: 40, resetsAt: FAKE_RESET_7D * 1000 },
      ],
      [
        { window: '5h', usedPercent: 55, resetsAt: (FAKE_RESET_5H + 60) * 1000 },
        { window: '7d', usedPercent: 41, resetsAt: FAKE_RESET_7D * 1000 },
      ],
    ]);
    // The plan was left out of the updates and stays the one the read gave.
    expect(readings.every((one) => one.planType === 'plus')).toBe(true);
    await until(() => launcher.aliveGroups() === 0);
  });

  it('leaves no process after dispose, even before the app-server answered', async () => {
    const probe = build('hang', { watch: 'resident' });

    const sub = probe.watch(REF, () => undefined);
    await until(async () => (await requests()).includes('initialize'));
    sub.dispose();

    await until(() => launcher.aliveGroups() === 0);
    sub.dispose();
  });

  it('leaves no process when disposed before the app-server started', async () => {
    const probe = build('ok', { watch: 'resident' });

    probe.watch(REF, () => undefined).dispose();

    await until(() => launcher.aliveGroups() === 0);
  });

  it('delivers nothing for a profile without login and leaves no process', async () => {
    const readings: QuotaReading[] = [];
    const probe = build('noauth', { watch: 'resident' });

    const sub = probe.watch(REF, (reading) => readings.push(reading));
    await until(() => launcher.pids.length === 1 && launcher.aliveGroups() === 0);
    sub.dispose();

    expect(readings).toEqual([]);
  });
});

/** The working directory the process reports is the real path of the profile directory. */
async function realCwd(): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(profileDir());
}
