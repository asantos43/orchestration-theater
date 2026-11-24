// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdatesConfigSchema } from '../../config.js';
import { createSilentLogger } from '../../logger.js';
import { RecordingSituations } from '../../test-helpers.js';
import { UpdateChecker } from '../checker.js';
import {
  buildRelease,
  FakeOrigin,
  makeKeys,
  TEST_ORIGIN,
  type TestKeys,
} from '../release-fixture.js';
import { createUpdateSource } from '../source.js';
import { UpdateStaging } from '../staging.js';
import { parsePublicKey, sha256OfFile } from '../verify.js';
import { runApply, type ApplyPorts } from './applier.js';
import {
  ApplyCoordinator,
  ApplyRefusal,
  type ApplyCoordinatorOptions,
  type BackupResult,
} from './coordinator.js';
import { readJournal, writeJournal, type UpdateJournal } from './journal.js';
import { layoutOf, type InstallLayout } from './layout.js';
import { checkJournalTrust } from './trust.js';
import { writeProof } from './trust-fixture.js';

/** The deadline of the waits: long, for the slow Windows runner of the CI; a met wait returns at once. */
const WAIT = { timeout: 15_000 };

/**
 * Deciding when to apply (P8): the three moments of `apply_when`, the wait of `idle` and its
 * question after `max_wait`, the backup before a migration, and how a swap that ended is told.
 * The checker is the real one over an origin in memory; the swap itself is not run here (see
 * `applier.test.ts`), except in the one test that follows a swap from the request to the report.
 */

const INSTALLED = '0.5.0';
const NEWER = '0.6.0';
const NEW_BODY = Buffer.from('#!/bin/sh\necho ok\n# new\n');
const OWN = { store: 10, telemetry: 3 } as const;
const HOUR = 3_600_000;
const SAME = { schemas: { store: 10, telemetry: 3 } };

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Work {
  running: number;
  held: boolean;
  holds: number;
  releases: number;
}

interface Rig {
  readonly checker: UpdateChecker;
  readonly coordinator: ApplyCoordinator;
  readonly clock: FakeClock;
  readonly situations: RecordingSituations;
  readonly staging: UpdateStaging;
  readonly layout: InstallLayout;
  readonly keys: TestKeys;
  readonly dir: string;
  readonly work: Work;
  readonly launched: { layout: InstallLayout; exe: string }[];
  readonly shutdowns: string[];
  readonly backups: string[];
  options(over?: Partial<ApplyCoordinatorOptions>): ApplyCoordinatorOptions;
  updates(): Record<string, unknown>[];
  notices(): Record<string, unknown>[];
  state(): string;
}

async function rig(
  options: {
    settings?: Record<string, unknown>;
    manifest?: Record<string, unknown>;
    backup?: () => Promise<BackupResult>;
    noBackup?: boolean;
    env?: Record<string, string>;
    releaseBuild?: boolean;
    checkout?: boolean;
    launchFails?: boolean;
    running?: number;
    release?: boolean;
  } = {},
): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-coordinator-'));
  dirs.push(dir);
  const folder = join(dir, 'install');
  await mkdir(folder, { recursive: true });
  const layout = layoutOf(join(folder, 'ot'));
  await writeFile(layout.exe, '#!/bin/sh\necho ok\n');
  await chmod(layout.exe, 0o755);
  const keys = makeKeys();
  const origin = new FakeOrigin();
  origin.publish(
    TEST_ORIGIN,
    buildRelease(keys, {
      version: NEWER,
      exe: NEW_BODY,
      expires: '2999-01-01T00:00:00.000Z',
      ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
    }),
  );
  const settings = UpdatesConfigSchema.parse({
    source: 'url',
    url: TEST_ORIGIN,
    check_interval: 'off',
    ...options.settings,
  });
  const clock = new FakeClock();
  const situations = new RecordingSituations();
  const staging = new UpdateStaging(join(dir, 'data', 'updates', 'staging'));
  const key = parsePublicKey(keys.publicPem);
  const work: Work = { running: options.running ?? 0, held: false, holds: 0, releases: 0 };
  const launched: Rig['launched'] = [];
  const shutdowns: string[] = [];
  const backups: string[] = [];
  const held: { checker?: UpdateChecker } = {};

  const make = (over: Partial<ApplyCoordinatorOptions> = {}): ApplyCoordinatorOptions => ({
    settings,
    version: INSTALLED,
    dataDir: join(dir, 'data'),
    layout: options.checkout === true ? undefined : layout,
    key,
    platform: 'linux-x64',
    staging,
    clock,
    situations,
    logger: createSilentLogger(),
    work: {
      active: () => work.running,
      hold: () => {
        work.held = true;
        work.holds += 1;
      },
      release: () => {
        work.held = false;
        work.releases += 1;
      },
    },
    backup:
      options.noBackup === true
        ? undefined
        : (options.backup ??
          (() => {
            backups.push('made');
            return Promise.resolve({ ok: true, dir: join(dir, 'backups', 'pre-update') });
          })),
    ownSchemas: OWN,
    launch: (installed, exe) => {
      if (options.launchFails === true) return Promise.reject(new Error('spawn ENOENT'));
      launched.push({ layout: installed, exe });
      return Promise.resolve();
    },
    shutdown: () => {
      shutdowns.push('shutdown');
      return Promise.resolve();
    },
    effectiveMode: () => held.checker?.status().effectiveMode ?? 'off',
    forget: (version) => held.checker?.forget(version),
    releaseBuild: options.releaseBuild ?? false,
    env: options.env ?? {},
    idlePollMs: 5000,
    reportPollMs: 1000,
    stableMs: 0,
    pid: 4242,
    ...over,
  });
  const coordinator = new ApplyCoordinator(make());
  const checker = new UpdateChecker({
    settings,
    currentVersion: INSTALLED,
    platform: 'linux-x64',
    installKind: 'own',
    key,
    source: createUpdateSource({ kind: 'url', url: TEST_ORIGIN }, { fetch: origin.fetch }),
    staging,
    clock,
    situations,
    logger: createSilentLogger(),
    applier: coordinator,
  });
  held.checker = checker;
  // Nothing runs until the test asks: the checker is not started.
  return {
    checker,
    coordinator,
    clock,
    situations,
    staging,
    layout,
    keys,
    dir,
    work,
    launched,
    shutdowns,
    backups,
    options: make,
    updates: () => situations.of('daemon.update') as Record<string, unknown>[],
    notices: () => situations.of('daemon.notice') as Record<string, unknown>[],
    state: () => coordinator.status().state,
  };
}

async function exists(file: string): Promise<boolean> {
  return await stat(file).then(
    () => true,
    () => false,
  );
}

const phases = (r: Rig): unknown[] => r.updates().map((event) => event.phase);

describe('the file-call repetition keys reach the journal (N305)', () => {
  it('writes updates.apply.fs_retry and fs_retry_timeout in the journal the applier reads', async () => {
    const r = await rig({
      settings: { apply_when: 'park', apply: { fs_retry: 'always', fs_retry_timeout: '45s' } },
      manifest: SAME,
    });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.shutdowns).toEqual(['shutdown']);
    }, WAIT);
    const reading = await readJournal(r.layout.journal);
    expect(reading.kind === 'ok' ? reading.journal : undefined).toMatchObject({
      fsRetry: 'always',
      fsRetryTimeoutMs: 45_000,
    });
  });
});

describe('park: applies at once', () => {
  it('writes the journal, puts the copy next to the executable, starts the applier and shuts down', async () => {
    const r = await rig({ settings: { apply_when: 'park' }, manifest: SAME });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.shutdowns).toEqual(['shutdown']);
    }, WAIT);
    expect(r.launched).toHaveLength(1);
    // The applier runs from the stored copy, never from the file that the swap renames.
    const staged = await r.staging.ready();
    expect(r.launched[0]?.exe).toBe(staged?.file);
    expect(await readFile(r.layout.stagingExe)).toEqual(NEW_BODY);

    const reading = await readJournal(r.layout.journal);
    expect(reading.kind).toBe('ok');
    const journal = reading.kind === 'ok' ? reading.journal : undefined;
    expect(journal).toMatchObject({
      from: INSTALLED,
      to: NEWER,
      step: 'waiting',
      oldPid: 4242,
      rollback: 'auto',
      healthTimeoutMs: 60_000,
      fsRetry: 'auto',
      fsRetryTimeoutMs: 15_000,
      exe: r.layout.exe,
      backup: null,
      reported: false,
    });
    expect(journal?.sha256).toBe(await sha256OfFile(r.layout.stagingExe));
    // The journal rests on the signed manifest the daemon left beside the executable (P8a).
    expect(
      journal === undefined
        ? undefined
        : await checkJournalTrust({
            layout: r.layout,
            journal,
            key: parsePublicKey(r.keys.publicPem),
            platform: 'linux-x64',
          }),
    ).toEqual({ ok: true });
    expect(phases(r)).toEqual(['found', 'downloaded', 'verified', 'applying']);
    expect(r.state()).toBe('applying');
    expect(r.work.holds).toBe(0);
  });

  it('is not tried a second time while it is applying', async () => {
    const r = await rig({ settings: { apply_when: 'park' } });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
    expect(() => r.coordinator.request('park')).toThrow(ApplyRefusal);
    expect(() => r.coordinator.request('default')).toThrow(/already being applied/);
  });
});

describe('idle: waits for a quiet moment', () => {
  it('holds the new work back while an attempt runs, and applies when none does', async () => {
    const r = await rig({ running: 1 });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.state()).toBe('waiting');
    }, WAIT);
    expect(r.work.held).toBe(true);
    expect(r.launched).toEqual([]);
    expect(r.coordinator.status().askAt).not.toBeNull();

    await r.clock.advance(5000);
    expect(r.launched).toEqual([]);
    r.work.running = 0;
    await r.clock.advance(5000);
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
    expect(r.state()).toBe('applying');
    expect(phases(r)).toContain('applying');
  });

  it('applies at once when nothing is running', async () => {
    const r = await rig();
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
  });

  it('after max_wait releases the work and asks the Producer: park or wait', async () => {
    const r = await rig({ running: 1, settings: { max_wait: '1h' } });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.state()).toBe('waiting');
    }, WAIT);
    await r.clock.advance(HOUR);
    await vi.waitFor(() => {
      expect(r.state()).toBe('asked');
    }, WAIT);
    expect(r.work.held).toBe(false);
    expect(r.notices()).toEqual([{ kind: 'update_ask', subject: NEWER, detail: 'park|wait' }]);
    expect(r.launched).toEqual([]);
    expect(r.coordinator.status().askAt).toBeNull();
  });

  it('"wait" after the question holds the work again and goes on waiting', async () => {
    const r = await rig({ running: 1, settings: { max_wait: '1h' } });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.state()).toBe('waiting');
    }, WAIT);
    await r.clock.advance(HOUR);
    await vi.waitFor(() => {
      expect(r.state()).toBe('asked');
    }, WAIT);
    r.coordinator.request('wait');
    expect(r.state()).toBe('waiting');
    expect(r.work.held).toBe(true);
    r.work.running = 0;
    await r.clock.advance(5000);
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
  });

  it('"park" after the question applies with the work still running', async () => {
    const r = await rig({ running: 2, settings: { max_wait: '1h' } });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.state()).toBe('waiting');
    }, WAIT);
    await r.clock.advance(HOUR);
    await vi.waitFor(() => {
      expect(r.state()).toBe('asked');
    }, WAIT);
    const status = r.coordinator.request('park');
    expect(status.state).toBe('applying');
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
  });

  it('releases the work when the wait is stopped', async () => {
    const r = await rig({ running: 1 });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.work.held).toBe(true);
    }, WAIT);
    await r.coordinator.stop();
    expect(r.work.held).toBe(false);
  });
});

describe('next_start: leaves it ready', () => {
  it('does not apply by itself while the daemon runs', async () => {
    const r = await rig({ settings: { apply_when: 'next_start' } });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.state()).toBe('scheduled');
    }, WAIT);
    expect(r.launched).toEqual([]);
    expect(r.work.holds).toBe(0);
    expect(r.checker.status().ready).toBe(NEWER);
  });

  it('applies the version found on disk at the next start', async () => {
    const first = await rig({ settings: { apply_when: 'next_start' } });
    await first.checker.checkNow();
    const next = new ApplyCoordinator(first.options());
    next.ready(NEWER, true);
    await vi.waitFor(() => {
      expect(first.launched).toHaveLength(1);
    }, WAIT);
    expect(first.shutdowns).toEqual(['shutdown']);
  });
});

describe('the modes', () => {
  it('notify applies nothing by itself and applies on request', async () => {
    const r = await rig({ settings: { mode: 'notify', apply_when: 'park' } });
    await r.checker.checkNow();
    await new Promise((done) => setTimeout(done, 20));
    expect(r.state()).toBe('none');
    expect(r.launched).toEqual([]);
    r.coordinator.request('default');
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
  });

  it('notify with next_start: "default" is refused and "park" applies', async () => {
    const r = await rig({ settings: { mode: 'notify', apply_when: 'next_start' } });
    await r.checker.checkNow();
    expect(() => r.coordinator.request('default')).toThrow(/next_start/);
    r.coordinator.request('park');
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
  });

  it('check and off are refused: nothing was downloaded', async () => {
    for (const mode of ['check', 'off']) {
      const r = await rig({ settings: { mode } });
      await r.checker.checkNow();
      expect(() => r.coordinator.request('park')).toThrow(ApplyRefusal);
    }
  });
});

describe('the requests that are refused', () => {
  it('refuses when no version is ready, from a checkout, and "wait" with nothing to wait for', async () => {
    const none = await rig({ settings: { mode: 'notify' } });
    expect(() => none.coordinator.request('default')).toThrow(/No version is ready/);

    const checkout = await rig({ settings: { mode: 'notify' }, checkout: true });
    await checkout.checker.checkNow();
    try {
      checkout.coordinator.request('park');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApplyRefusal);
      expect((error as ApplyRefusal).code).toBe('conflict');
    }

    const ready = await rig({ settings: { mode: 'notify' } });
    await ready.checker.checkNow();
    expect(() => ready.coordinator.request('wait')).toThrow(/not waiting/);
  });
});

describe('the backup before a migration', () => {
  const same = SAME;

  async function apply(r: Rig): Promise<UpdateJournal | undefined> {
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.state() === 'applying' || r.notices().length > 0).toBe(true);
    }, WAIT);
    await vi.waitFor(async () => {
      expect((await readJournal(r.layout.journal)).kind === 'ok' || r.notices().length > 0).toBe(
        true,
      );
    }, WAIT);
    const reading = await readJournal(r.layout.journal);
    return reading.kind === 'ok' ? reading.journal : undefined;
  }

  it('is not made when the schemas are the same', async () => {
    const r = await rig({ settings: { apply_when: 'park' }, manifest: same });
    const journal = await apply(r);
    expect(r.backups).toEqual([]);
    expect(journal?.backup).toBeNull();
  });

  it('is made, and recorded in the journal, when the store schema is larger', async () => {
    const r = await rig({
      settings: { apply_when: 'park' },
      manifest: { schemas: { store: 11, telemetry: 3 } },
    });
    const journal = await apply(r);
    expect(r.backups).toEqual(['made']);
    expect(journal?.backup).toBe(join(r.dir, 'backups', 'pre-update'));
  });

  it('is made when the telemetry schema is larger, and when the manifest does not say', async () => {
    const telemetry = await rig({
      settings: { apply_when: 'park' },
      manifest: { schemas: { store: 10, telemetry: 4 } },
    });
    await apply(telemetry);
    expect(telemetry.backups).toEqual(['made']);
    const silent = await rig({ settings: { apply_when: 'park' } });
    await apply(silent);
    expect(silent.backups).toEqual(['made']);
  });

  it('backup_before_migration: false makes none', async () => {
    const r = await rig({
      settings: { apply_when: 'park', backup_before_migration: false },
      manifest: { schemas: { store: 11, telemetry: 3 } },
    });
    const journal = await apply(r);
    expect(r.backups).toEqual([]);
    expect(journal?.backup).toBeNull();
  });

  it('OT_TEST_MIGRATION forces it outside the release build, and does nothing in it', async () => {
    const outside = await rig({
      settings: { apply_when: 'park' },
      manifest: same,
      env: { OT_TEST_MIGRATION: 'store' },
    });
    await apply(outside);
    expect(outside.backups).toEqual(['made']);

    const release = await rig({
      settings: { apply_when: 'park' },
      manifest: same,
      env: { OT_TEST_MIGRATION: 'store' },
      releaseBuild: true,
    });
    await apply(release);
    expect(release.backups).toEqual([]);
  });

  it('a backup that fails stops the apply, moves nothing and tells it', async () => {
    const r = await rig({
      settings: { apply_when: 'park' },
      manifest: { schemas: { store: 11, telemetry: 3 } },
      backup: () => Promise.resolve({ ok: false, detail: 'the disk is full' }),
    });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(phases(r)).toContain('failed');
    }, WAIT);
    expect(r.launched).toEqual([]);
    expect(r.shutdowns).toEqual([]);
    expect(await exists(r.layout.journal)).toBe(false);
    expect(await exists(r.layout.stagingDir)).toBe(false);
    expect(r.updates().at(-1)).toMatchObject({ phase: 'failed', reason: 'backup_failed' });
    expect(r.notices()).toEqual([
      { kind: 'update_failed', subject: NEWER, detail: 'backup_failed' },
    ]);
    expect(r.state()).toBe('none');
    // The version is still ready for another try.
    expect(r.checker.status().ready).toBe(NEWER);
  });

  it('a store that cannot make a backup stops the apply when one is needed', async () => {
    const r = await rig({
      settings: { apply_when: 'park' },
      manifest: { schemas: { store: 11, telemetry: 3 } },
      noBackup: true,
    });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(phases(r)).toContain('failed');
    }, WAIT);
    expect(r.launched).toEqual([]);
  });
});

describe('what stops an apply before anything moves', () => {
  it('a stored file that changed on disk is rejected and dropped', async () => {
    const r = await rig({ settings: { apply_when: 'park', mode: 'notify' } });
    await r.checker.checkNow();
    const staged = await r.staging.ready();
    await writeFile(staged?.file ?? '', '#!/bin/sh\necho tampered\n');
    r.coordinator.request('park');
    await vi.waitFor(() => {
      expect(phases(r)).toContain('rejected');
    }, WAIT);
    expect(r.launched).toEqual([]);
    expect(await r.staging.ready()).toBeUndefined();
    expect(r.updates().at(-1)).toMatchObject({ phase: 'rejected', reason: 'sha256' });
    expect(r.notices()).toEqual([{ kind: 'update_rejected', subject: NEWER, detail: 'sha256' }]);
    expect(await exists(r.layout.journal)).toBe(false);
  });

  it('an applier that cannot be started leaves no journal and no copy', async () => {
    const r = await rig({ settings: { apply_when: 'park' }, launchFails: true });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(phases(r)).toContain('rolled_back');
    }, WAIT);
    expect(r.shutdowns).toEqual([]);
    expect(await exists(r.layout.journal)).toBe(false);
    expect(await exists(r.layout.stagingDir)).toBe(false);
    expect(r.updates().at(-1)).toMatchObject({ phase: 'rolled_back', reason: 'swap_failed' });
    expect(r.state()).toBe('none');
  });

  it('a swap under way (applier alive) is not started over', async () => {
    const r = await rig({ settings: { apply_when: 'park', mode: 'notify' } });
    await r.checker.checkNow();
    const manifestSha256 = await writeProof(r.layout, r.keys, {
      version: NEWER,
      sha256: 'a'.repeat(64),
    });
    await writeJournal(
      r.layout.journal,
      journalOf(r, { step: 'checking', applierPid: process.pid, manifestSha256 }),
    );
    r.coordinator.request('park');
    await vi.waitFor(() => {
      expect(r.updates().at(-1)).toMatchObject({ phase: 'rolled_back', reason: 'swap_failed' });
    }, WAIT);
    expect(r.launched).toEqual([]);
  });

  it('a journal that no signed manifest backs does not hold the way, whatever pid it names (P8a)', async () => {
    const r = await rig({ settings: { apply_when: 'park', mode: 'notify' } });
    await r.checker.checkNow();
    await writeJournal(
      r.layout.journal,
      journalOf(r, { step: 'checking', applierPid: process.pid }),
    );
    r.coordinator.request('park');
    await vi.waitFor(() => {
      expect(r.launched).toHaveLength(1);
    }, WAIT);
  });

  it('a manifest that expired while it waited in the store is refused at the apply (P8a)', async () => {
    const soon = new Date(Date.UTC(2026, 0, 1) + HOUR).toISOString();
    const r = await rig({
      settings: { apply_when: 'park', mode: 'notify' },
      manifest: { expires: soon },
    });
    expect((await r.checker.checkNow()).lastResult).toBe('ready');
    await r.clock.advance(2 * HOUR);
    r.coordinator.request('park');
    await vi.waitFor(() => {
      expect(r.updates().at(-1)).toMatchObject({ phase: 'rejected', reason: 'bad_manifest' });
    }, WAIT);
    expect(r.launched).toEqual([]);
    expect(await exists(r.layout.journal)).toBe(false);
  });

  it('a stored version of another channel than the configured one is refused at the apply (P8a)', async () => {
    const r = await rig({ settings: { apply_when: 'park', mode: 'notify' } });
    await r.checker.checkNow();
    // The channel is changed after the version was stored: the stored manifest is of the other one.
    (r.options().settings as { channel: string }).channel = 'beta';
    r.coordinator.request('park');
    await vi.waitFor(() => {
      expect(r.updates().at(-1)).toMatchObject({ phase: 'rejected', reason: 'wrong_channel' });
    }, WAIT);
    expect(r.launched).toEqual([]);
  });
});

function journalOf(r: Rig, over: Partial<UpdateJournal> = {}): UpdateJournal {
  return {
    v: 1,
    from: INSTALLED,
    to: NEWER,
    sha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    step: 'committed',
    oldPid: 1,
    applierPid: 0,
    dataDir: join(r.dir, 'data'),
    exe: r.layout.exe,
    rollback: 'auto',
    healthTimeoutMs: 60_000,
    stableMs: 0,
    backup: null,
    reason: null,
    reported: false,
    startedAt: 1,
    updatedAt: Date.UTC(2026, 10, 22, 15),
    ...over,
  };
}

describe('how a swap that ended is told (by the daemon that comes back)', () => {
  it('committed: applied, the notice, the copy dropped, and the journal marked as reported', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    await r.checker.checkNow();
    await writeJournal(r.layout.journal, journalOf(r, { step: 'committed' }));
    const back = new ApplyCoordinator(r.options({ version: NEWER, forget: () => undefined }));
    back.start();
    await vi.waitFor(() => {
      expect(phases(r)).toContain('applied');
    }, WAIT);
    expect(r.updates().at(-1)).toMatchObject({ phase: 'applied', version: NEWER, current: NEWER });
    expect(r.notices()).toEqual([{ kind: 'update_applied', subject: NEWER, detail: INSTALLED }]);
    expect(await r.staging.ready()).toBeUndefined();
    await vi.waitFor(async () => {
      const reading = await readJournal(r.layout.journal);
      expect(reading.kind === 'ok' && reading.journal.reported).toBe(true);
    }, WAIT);
    expect(back.status().last).toMatchObject({ outcome: 'applied', version: NEWER, reason: null });
    await back.stop();
  });

  it('rolled_back: told by the old daemon that came back, with the reason', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    await writeJournal(r.layout.journal, journalOf(r, { step: 'rolled_back', reason: 'health' }));
    r.coordinator.start();
    await vi.waitFor(() => {
      expect(phases(r)).toEqual(['rolled_back']);
    }, WAIT);
    expect(r.updates()[0]).toMatchObject({ reason: 'health', version: NEWER, current: INSTALLED });
    expect(r.notices()).toEqual([{ kind: 'update_rolled_back', subject: NEWER, detail: 'health' }]);
    expect(r.coordinator.status().last).toMatchObject({ outcome: 'rolled_back', reason: 'health' });
    await r.coordinator.stop();
  });

  it('failed (rollback: off): told as failed', async () => {
    const r = await rig({ settings: { mode: 'notify', rollback: 'off' } });
    await writeJournal(r.layout.journal, journalOf(r, { step: 'failed', reason: 'not_started' }));
    const back = new ApplyCoordinator(r.options({ version: NEWER }));
    back.start();
    await vi.waitFor(() => {
      expect(phases(r)).toEqual(['failed']);
    }, WAIT);
    expect(r.notices()).toEqual([{ kind: 'update_failed', subject: NEWER, detail: 'not_started' }]);
    await back.stop();
  });

  it('a swap under way that no signed manifest backs is told as untrusted, once (P8a)', async () => {
    const r = await rig();
    await writeJournal(r.layout.journal, journalOf(r, { step: 'checking' }));
    r.coordinator.start();
    await vi.waitFor(() => {
      expect(r.notices().map((notice) => notice.kind)).toEqual(['update_untrusted_journal']);
    }, WAIT);
    expect(r.notices()[0]).toMatchObject({ subject: NEWER });
    await r.coordinator.stop();
  });

  it('tells it once: a journal that was reported is only read', async () => {
    const r = await rig({ settings: { mode: 'notify' } });
    await writeJournal(
      r.layout.journal,
      journalOf(r, { step: 'rolled_back', reason: 'health', reported: true }),
    );
    r.coordinator.start();
    await vi.waitFor(() => {
      expect(r.coordinator.status().last?.outcome).toBe('rolled_back');
    }, WAIT);
    expect(r.updates()).toEqual([]);
    expect(r.notices()).toEqual([]);
    await r.coordinator.stop();
  });

  it('a version that was rolled back is not applied again by itself, but the Producer can', async () => {
    const r = await rig({ settings: { apply_when: 'park' } });
    await writeJournal(
      r.layout.journal,
      journalOf(r, { step: 'rolled_back', reason: 'health', reported: true }),
    );
    await r.checker.checkNow();
    await new Promise((done) => setTimeout(done, 30));
    expect(r.launched).toEqual([]);
    expect(r.state()).toBe('none');
    r.coordinator.request('park');
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
  });
});

describe('from the request to the report, with the swap in between', () => {
  it('the daemon applies, the applier swaps, and the new daemon says it was applied', async () => {
    const r = await rig({ settings: { apply_when: 'park' } });
    await r.checker.checkNow();
    await vi.waitFor(() => {
      expect(r.shutdowns).toHaveLength(1);
    }, WAIT);
    const reading = await readJournal(r.layout.journal);
    if (reading.kind !== 'ok') throw new Error('no journal');
    let now = 1000;
    const ports: ApplyPorts = {
      clock: {
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      },
      isAlive: () => false,
      startDaemon: () => Promise.resolve({ ok: true }),
      stopDaemon: () => Promise.resolve(),
      probe: () => Promise.resolve('ok'),
      restoreBackup: () => Promise.resolve(),
      sha256: sha256OfFile,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    expect(await runApply(r.layout, ports, reading.journal)).toEqual({ kind: 'committed' });
    expect(await readFile(r.layout.exe)).toEqual(NEW_BODY);

    const back = new ApplyCoordinator(r.options({ version: NEWER }));
    back.start();
    await vi.waitFor(() => {
      expect(phases(r)).toContain('applied');
    }, WAIT);
    await back.stop();
  });
});
