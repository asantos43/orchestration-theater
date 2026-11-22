// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdatesConfigSchema } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { RecordingSituations } from '../test-helpers.js';
import { UpdateChecker, type UpdateCheckerOptions } from './checker.js';
import {
  buildRelease,
  EXE_BYTES,
  FakeOrigin,
  GITHUB_LIST,
  GITHUB_STABLE,
  makeKeys,
  TEST_ORIGIN,
  type ReleaseSpec,
  type TestKeys,
} from './release-fixture.js';
import { createUpdateSource } from './source.js';
import { UpdateStaging } from './staging.js';
import { parsePublicKey } from './verify.js';

/**
 * The search for updates (P7 of Phase 10): the order of the checks, what a refusal leaves behind
 * (nothing on disk), what the events say, and what each mode does. The origin is in memory and the
 * keys are made here.
 */

const INSTALLED = '0.5.0';
const NEWER = '0.6.0';
const HOUR = 3_600_000;

interface Rig {
  readonly checker: UpdateChecker;
  readonly origin: FakeOrigin;
  readonly keys: TestKeys;
  readonly situations: RecordingSituations;
  readonly staging: UpdateStaging;
  readonly clock: FakeClock;
  readonly dir: string;
  /** The `daemon.update` events, in order. */
  updates(): Record<string, unknown>[];
  /** What is in the staging folder (the version folders and any leftover). */
  leftovers(): Promise<string[]>;
  exeAsked(): boolean;
}

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function rig(
  options: {
    settings?: Record<string, unknown>;
    release?: ReleaseSpec | false;
    keys?: TestKeys;
    signWith?: TestKeys;
    publicPem?: string;
    installKind?: UpdateCheckerOptions['installKind'];
    version?: string;
    tamper?: (bytes: Buffer) => Buffer;
  } = {},
): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-updates-'));
  dirs.push(dir);
  const keys = options.keys ?? makeKeys();
  const origin = new FakeOrigin();
  const settings = UpdatesConfigSchema.parse({
    source: 'url',
    url: TEST_ORIGIN,
    check_interval: 'off',
    ...options.settings,
  });
  let served: ReturnType<typeof buildRelease> | undefined;
  if (options.release !== false) {
    served = buildRelease(options.signWith ?? keys, options.release ?? { version: NEWER });
    if (options.tamper !== undefined) {
      served = { ...served, manifestBytes: options.tamper(served.manifestBytes) };
    }
    origin.publish(TEST_ORIGIN, served);
  }
  const situations = new RecordingSituations();
  const clock = new FakeClock();
  const staging = new UpdateStaging(join(dir, 'staging'));
  const checker = new UpdateChecker({
    settings,
    currentVersion: options.version ?? INSTALLED,
    platform: 'linux-x64',
    installKind: options.installKind ?? 'own',
    key: parsePublicKey(options.publicPem ?? keys.publicPem),
    source: createUpdateSource({ kind: 'url', url: TEST_ORIGIN }, { fetch: origin.fetch }),
    staging,
    clock,
    situations,
    logger: createSilentLogger(),
  });
  return {
    checker,
    origin,
    keys,
    situations,
    staging,
    clock,
    dir,
    updates: () => situations.of('daemon.update') as Record<string, unknown>[],
    leftovers: () => readdir(join(dir, 'staging')).catch(() => []),
    exeAsked: () => origin.asked.some((address) => address.includes('otheater-')),
  };
}

const phases = (r: Rig): unknown[] => r.updates().map((event) => event.phase);

describe('a good version', () => {
  it('is downloaded, checked and stored, and nothing else is touched', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    const status = await r.checker.checkNow();
    expect(status).toMatchObject({
      lastResult: 'ready',
      found: NEWER,
      ready: NEWER,
      lastReason: null,
    });
    expect(phases(r)).toEqual(['found', 'downloaded', 'verified']);
    expect(r.updates()[2]).toMatchObject({
      version: NEWER,
      current: INSTALLED,
      channel: 'stable',
      mode: 'notify',
      effectiveMode: 'notify',
      reason: null,
    });
    const stored = await r.staging.ready();
    expect(stored?.version).toBe(NEWER);
    expect(await readFile(stored?.file ?? '')).toEqual(EXE_BYTES);
    expect(await r.leftovers()).toEqual([NEWER]);
    expect(r.checker.counters().checks.ready).toBe(1);
    expect(r.situations.of('daemon.notice')).toEqual([]);
  });

  it('is not downloaded again when it is already stored', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    await r.checker.checkNow();
    const before = r.origin.asked.filter((address) => address.includes('otheater-')).length;
    await r.checker.checkNow();
    expect(r.origin.asked.filter((address) => address.includes('otheater-'))).toHaveLength(before);
    expect(r.checker.status().ready).toBe(NEWER);
  });

  it('is found again after a restart, from the staging folder', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    await r.checker.checkNow();
    const again = new UpdateChecker({
      settings: UpdatesConfigSchema.parse({
        mode: 'notify',
        source: 'url',
        url: TEST_ORIGIN,
        check_interval: 'off',
      }),
      currentVersion: INSTALLED,
      platform: 'linux-x64',
      installKind: 'own',
      key: parsePublicKey(r.keys.publicPem),
      source: createUpdateSource(
        { kind: 'url', url: TEST_ORIGIN },
        { fetch: () => Promise.reject(new TypeError('down')) },
      ),
      staging: r.staging,
      clock: r.clock,
      situations: new RecordingSituations(),
      logger: createSilentLogger(),
    });
    again.start();
    await vi.waitFor(() => {
      expect(again.status().lastResult).toBe('failed');
    });
    // The origin is down, but what was stored is still offered.
    expect(again.status().ready).toBe(NEWER);
    await again.stop();
  });
});

describe('what is refused', () => {
  it('a signature of another key: nothing is downloaded, nothing is stored', async () => {
    const r = await rig({ signWith: makeKeys() });
    const status = await r.checker.checkNow();
    expect(status).toMatchObject({ lastResult: 'rejected', lastReason: 'signature', ready: null });
    expect(r.exeAsked()).toBe(false);
    expect(await r.leftovers()).toEqual([]);
    expect(phases(r)).toEqual(['rejected']);
    expect(r.updates()[0]).toMatchObject({ reason: 'signature', version: null });
    expect(r.checker.counters().rejected.signature).toBe(1);
    expect(r.situations.of('daemon.notice')).toEqual([
      { kind: 'update_rejected', subject: null, detail: 'signature' },
    ]);
  });

  it('a manifest changed after it was signed', async () => {
    const r = await rig({
      tamper: (bytes) => Buffer.from(bytes.toString().replace(NEWER, '9.9.9')),
    });
    await r.checker.checkNow();
    expect(r.checker.status()).toMatchObject({ lastResult: 'rejected', lastReason: 'signature' });
    expect(r.exeAsked()).toBe(false);
    expect(r.checker.status().found).toBeNull();
    expect(await r.leftovers()).toEqual([]);
  });

  it('an executable with another SHA-256', async () => {
    const r = await rig({
      settings: { mode: 'notify' },
      release: {
        version: NEWER,
        exe: Buffer.from('not what was signed'),
        sha256: '0'.repeat(64),
        size: 19,
      },
    });
    await r.checker.checkNow();
    expect(r.checker.status()).toMatchObject({
      lastResult: 'rejected',
      lastReason: 'sha256',
      ready: null,
    });
    expect(phases(r)).toEqual(['found', 'downloaded', 'rejected']);
    // The download was deleted: the staging folder holds nothing, not even a partial file.
    expect(await r.leftovers()).toEqual([]);
    expect(await r.staging.ready()).toBeUndefined();
    expect(r.checker.counters().rejected.sha256).toBe(1);
  });

  it('a size that is not the one of the manifest, longer or shorter', async () => {
    for (const size of [EXE_BYTES.length - 3, EXE_BYTES.length + 3]) {
      const r = await rig({ settings: { mode: 'notify' }, release: { version: NEWER, size } });
      await r.checker.checkNow();
      expect(r.checker.status()).toMatchObject({ lastResult: 'rejected', lastReason: 'size' });
      expect(await r.leftovers()).toEqual([]);
      expect(r.checker.counters().rejected.size).toBe(1);
    }
  });

  it('a version equal to the installed one is not an update; a lower one is refused', async () => {
    const same = await rig({ settings: { mode: 'notify' }, release: { version: INSTALLED } });
    expect((await same.checker.checkNow()).lastResult).toBe('up_to_date');
    expect(same.updates()).toEqual([]);
    expect(same.exeAsked()).toBe(false);

    const lower = await rig({ settings: { mode: 'notify' }, release: { version: '0.4.0' } });
    expect(await lower.checker.checkNow()).toMatchObject({
      lastResult: 'rejected',
      lastReason: 'version_not_newer',
    });
    expect(lower.exeAsked()).toBe(false);
    expect(await lower.leftovers()).toEqual([]);
  });

  it('a manifest of another channel than the one asked for', async () => {
    const r = await rig({ release: { version: NEWER, channel: 'beta' } });
    await r.checker.checkNow();
    expect(r.checker.status()).toMatchObject({
      lastResult: 'rejected',
      lastReason: 'wrong_channel',
    });
    expect(r.exeAsked()).toBe(false);
    expect(r.updates()[0]).toMatchObject({ phase: 'rejected', version: NEWER, channel: 'stable' });
  });

  it('a signed manifest that is not a manifest', async () => {
    const r = await rig({ release: { version: NEWER, manifest: { assets: [] } } });
    await r.checker.checkNow();
    expect(r.checker.status()).toMatchObject({
      lastResult: 'rejected',
      lastReason: 'bad_manifest',
    });
  });

  it('a version that needs a newer installed one is skipped, not rejected', async () => {
    const r = await rig({ release: { version: NEWER, minVersion: '0.5.5' } });
    expect((await r.checker.checkNow()).lastResult).toBe('skipped');
    expect(r.checker.status().lastReason).toBe('below_min_version');
    expect(phases(r)).toEqual(['skipped']);
    expect(r.situations.of('daemon.notice')).toEqual([]);
  });

  it('a platform with no executable is skipped', async () => {
    const r = await rig({
      settings: { mode: 'notify' },
      release: { version: NEWER, platform: 'win32-x64' },
    });
    expect((await r.checker.checkNow()).lastReason).toBe('no_asset');
    expect(await r.leftovers()).toEqual([]);
  });

  it('a name in the manifest that is a path is a bad manifest', async () => {
    const r = await rig({ settings: { mode: 'notify' }, release: { version: NEWER, name: '..' } });
    expect((await r.checker.checkNow()).lastReason).toBe('bad_manifest');
  });
});

describe('no network', () => {
  it('leaves the state failed, and the next search can work', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    r.origin.down = true;
    const status = await r.checker.checkNow();
    expect(status).toMatchObject({ lastResult: 'failed', lastReason: 'no_network' });
    expect(phases(r)).toEqual(['failed']);
    expect(r.situations.of('daemon.notice')).toEqual([]);
    r.origin.down = false;
    expect((await r.checker.checkNow()).lastResult).toBe('ready');
  });

  it('an origin that answers an error is failed with bad_response', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    r.origin.files.set(`${TEST_ORIGIN}manifest.json`, 500);
    expect(await r.checker.checkNow()).toMatchObject({
      lastResult: 'failed',
      lastReason: 'bad_response',
    });
  });

  it('start() returns at once, even when the origin never answers', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    const never = new UpdateChecker({
      settings: UpdatesConfigSchema.parse({ source: 'url', url: TEST_ORIGIN }),
      currentVersion: INSTALLED,
      platform: 'linux-x64',
      installKind: 'own',
      key: parsePublicKey(r.keys.publicPem),
      source: createUpdateSource(
        { kind: 'url', url: TEST_ORIGIN },
        {
          fetch: (_input, init) =>
            new Promise((_resolve, reject) => {
              const signal = init?.signal;
              if (signal?.aborted === true) reject(new TypeError('aborted'));
              signal?.addEventListener('abort', () => {
                reject(new TypeError('aborted'));
              });
            }),
        },
      ),
      staging: r.staging,
      clock: r.clock,
      situations: r.situations,
      logger: createSilentLogger(),
    });
    never.start();
    expect(never.status().lastResult).toBeNull();
    await never.stop();
  });

  it('a failure that goes on is told once, not at every search', async () => {
    const r = await rig({ settings: { mode: 'notify', check_interval: '6h' } });
    r.origin.down = true;
    r.checker.start();
    await vi.waitFor(() => {
      expect(r.checker.counters().checks.failed).toBe(1);
    });
    for (let lap = 2; lap <= 3; lap += 1) {
      await r.clock.advance(6 * HOUR);
      await vi.waitFor(() => {
        expect(r.checker.counters().checks.failed).toBe(lap);
      });
    }
    expect(phases(r)).toEqual(['failed']);
    await r.checker.stop();
  });
});

describe('the modes', () => {
  it('check: says a version exists and downloads nothing', async () => {
    const r = await rig({ settings: { mode: 'check' } });
    const status = await r.checker.checkNow();
    expect(status).toMatchObject({
      lastResult: 'found',
      found: NEWER,
      ready: null,
      effectiveMode: 'check',
    });
    expect(phases(r)).toEqual(['found']);
    expect(r.exeAsked()).toBe(false);
    expect(await r.leftovers()).toEqual([]);
  });

  it('notify: downloads, checks and stores, and says it is ready', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    const status = await r.checker.checkNow();
    expect(status).toMatchObject({
      lastResult: 'ready',
      ready: NEWER,
      effectiveMode: 'notify',
      notes: [],
    });
  });

  it("auto: keeps the mode (the apply is the coordinator's) and has no note", async () => {
    const r = await rig({ settings: { mode: 'auto' } });
    const status = await r.checker.checkNow();
    expect(status).toMatchObject({
      mode: 'auto',
      effectiveMode: 'auto',
      notes: [],
      ready: NEWER,
    });
    expect(
      r.updates().every((event) => event.mode === 'auto' && event.effectiveMode === 'auto'),
    ).toBe(true);
  });

  it('off: never asks the origin and does not schedule anything', async () => {
    const r = await rig({ settings: { mode: 'off', check_interval: '6h' } });
    r.checker.start();
    await r.checker.checkNow();
    expect(r.origin.asked).toEqual([]);
    expect(r.checker.status()).toMatchObject({
      mode: 'off',
      effectiveMode: 'off',
      lastResult: null,
      nextCheckAt: null,
    });
    expect(r.clock.pendingSleeps).toBe(0);
    await r.checker.stop();
  });

  it('a checkout acts as check and says so', async () => {
    const r = await rig({ settings: { mode: 'auto' }, installKind: 'checkout' });
    const status = await r.checker.checkNow();
    expect(status).toMatchObject({
      installKind: 'checkout',
      effectiveMode: 'check',
      notes: ['checkout_install'],
      found: NEWER,
      ready: null,
    });
    expect(r.exeAsked()).toBe(false);
  });

  it('no valid public key: nothing is searched, and the status says why', async () => {
    for (const publicPem of ['PLACEHOLDER\n', 'not a key']) {
      const r = await rig({ settings: { mode: 'notify' }, publicPem });
      const status = await r.checker.checkNow();
      expect(status).toMatchObject({
        effectiveMode: 'check',
        notes: ['no_public_key'],
        lastResult: 'skipped',
        lastReason: 'no_public_key',
      });
      expect(status.keyState).toBe(publicPem.startsWith('PLACEHOLDER') ? 'placeholder' : 'invalid');
      expect(r.origin.asked).toEqual([]);
    }
  });

  it('a checkout without a key is quiet in the schedule: no event, no notice', async () => {
    const r = await rig({
      settings: { mode: 'notify' },
      installKind: 'checkout',
      publicPem: 'PLACEHOLDER',
    });
    r.checker.start();
    await vi.waitFor(() => {
      expect(r.checker.counters().checks.skipped).toBe(1);
    });
    expect(r.updates()).toEqual([]);
    await r.checker.stop();
  });
});

describe('the schedule', () => {
  it('searches at the start and at every interval, and says when the next one is', async () => {
    const r = await rig({ settings: { mode: 'check', check_interval: '6h' } });
    r.checker.start();
    await vi.waitFor(() => {
      expect(r.checker.counters().checks.found).toBe(1);
    });
    await vi.waitFor(() => {
      expect(r.checker.status().nextCheckAt).toBe(new Date(r.clock.now() + 6 * HOUR).toISOString());
    });
    await r.clock.advance(6 * HOUR);
    await vi.waitFor(() => {
      expect(r.checker.counters().checks.found).toBe(2);
    });
    // The same version is told once.
    expect(phases(r)).toEqual(['found']);
    await r.checker.stop();
    expect(r.clock.pendingSleeps).toBe(0);
  });

  it('a manual search tells again what the schedule would not', async () => {
    const r = await rig({ settings: { mode: 'check' } });
    await r.checker.checkNow();
    await r.checker.checkNow();
    expect(phases(r)).toEqual(['found', 'found']);
  });

  it('concurrent manual searches share one run', async () => {
    const r = await rig({ settings: { mode: 'check' } });
    await Promise.all([r.checker.checkNow(), r.checker.checkNow()]);
    expect(r.origin.asked.filter((address) => address.endsWith('manifest.json'))).toHaveLength(1);
  });

  it('a rejected version stays refused and is told once per version and reason', async () => {
    const r = await rig({
      settings: { mode: 'check', check_interval: '6h' },
      signWith: makeKeys(),
    });
    r.checker.start();
    await vi.waitFor(() => {
      expect(r.checker.counters().rejected.signature).toBe(1);
    });
    await r.clock.advance(6 * HOUR);
    await vi.waitFor(() => {
      expect(r.checker.counters().rejected.signature).toBe(2);
    });
    expect(phases(r)).toEqual(['rejected']);
    expect(r.situations.of('daemon.notice')).toHaveLength(1);
    await r.checker.stop();
  });
});

describe('the GitHub origin', () => {
  async function githubRig(channel: 'stable' | 'beta', release: ReleaseSpec) {
    const r = await rig({
      settings: { mode: 'notify', channel, source: 'github', url: undefined },
      release: false,
    });
    const built = buildRelease(r.keys, release);
    const checker = new UpdateChecker({
      settings: UpdatesConfigSchema.parse({ mode: 'notify', channel, check_interval: 'off' }),
      currentVersion: INSTALLED,
      platform: 'linux-x64',
      installKind: 'own',
      key: parsePublicKey(r.keys.publicPem),
      source: createUpdateSource({ kind: 'github' }, { fetch: r.origin.fetch }),
      staging: r.staging,
      clock: r.clock,
      situations: r.situations,
      logger: createSilentLogger(),
    });
    return { ...r, checker, built };
  }

  it('stable reads the latest release; with none published it is up to date', async () => {
    const g = await githubRig('stable', { version: NEWER });
    expect((await g.checker.checkNow()).lastResult).toBe('up_to_date');
    g.origin.publish(GITHUB_STABLE, g.built);
    expect(await g.checker.checkNow()).toMatchObject({ lastResult: 'ready', ready: NEWER });
    expect(g.origin.asked.every((address) => address.startsWith('https://github.com/'))).toBe(true);
  });

  it('beta reads the list and takes the first prerelease', async () => {
    const g = await githubRig('beta', { version: '0.6.0-beta.1', channel: 'beta' });
    g.origin.files.set(
      GITHUB_LIST,
      JSON.stringify([
        { tag_name: 'v0.5.9', prerelease: false },
        { tag_name: 'v0.6.0-beta.1', prerelease: true },
        { tag_name: 'v0.6.0-beta.0', prerelease: true },
      ]),
    );
    g.origin.publish(
      'https://github.com/asantos43/orchestration-theater/releases/download/v0.6.0-beta.1/',
      g.built,
    );
    expect(await g.checker.checkNow()).toMatchObject({
      lastResult: 'ready',
      ready: '0.6.0-beta.1',
    });
  });

  it('beta with no prerelease is up to date', async () => {
    const g = await githubRig('beta', { version: NEWER, channel: 'beta' });
    g.origin.files.set(GITHUB_LIST, JSON.stringify([{ tag_name: 'v0.5.9', prerelease: false }]));
    expect((await g.checker.checkNow()).lastResult).toBe('up_to_date');
  });
});
