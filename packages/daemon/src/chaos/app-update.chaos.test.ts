// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readDiscovery } from '../api/files.js';
import { composeClock, composeStoreFileTools } from '../compose.js';
import { loadConfig } from '../config.js';
import { dataPaths } from '../paths.js';
import { createBackup } from '../recovery/backup.js';
import type { ServiceManager } from '../service/index.js';
import { ServiceError } from '../service/types.js';
import { createHealthProbe } from '../updates/apply/health.js';
import { readJournal, writeJournal, type UpdateJournal } from '../updates/apply/journal.js';
import { layoutOf, type InstallLayout } from '../updates/apply/layout.js';
import { recoverAtStart } from '../updates/apply/recover.js';
import { realApplyPorts } from '../updates/apply/real-ports.js';
import { writeProof } from '../updates/apply/trust-fixture.js';
import { makeKeys, type TestKeys } from '../updates/release-fixture.js';
import { parsePublicKey, sha256Hex } from '../updates/verify.js';
import { takeCensus } from './census.js';
import { assertHarnessBuilt } from './harness.js';
import {
  assertInvariants,
  checkI1,
  checkI3,
  checkI7,
  DEFAULT_ALLOWED_LEFTOVERS,
} from './invariants.js';
import {
  childEnv,
  daemonLog,
  findLeftovers,
  makeRunDir,
  pidAlive,
  removeRunDir,
  startApplierChild,
  startFakeDaemon,
  stopPid,
  waitGone,
  waitUntil,
  writeFakeExe,
  type FakeDaemonMode,
  type Watched,
} from './update-chaos-fixture.js';

/**
 * Chaos C, the application (Phase 11, P6; docs/23): the real applier (`runApply` over the real ports,
 * `updates/apply/*`) runs as a process of its own and is killed with SIGKILL between the steps of the
 * journal and at the named points of the file moves of `swap`. The daemons are the fake ones of the
 * fixture (a process that holds the instance lock, migrates a real SQLite store and answers
 * `/v1/health`), started detached by the real ports, so they survive the applier as the real one
 * would. Afterwards `recoverAtStart` runs in the test, as the next `ot` would, and the swap must end
 * in a good state: the new version kept, or the old one back with its store, never a half of either.
 * Not here: the `import()` of the new code inside a real SEA (P12).
 */

const KEYS: TestKeys = makeKeys();
const TRUST = { key: parsePublicKey(KEYS.publicPem), platform: 'linux-x64' } as const;
const LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };
const FROM = '1.0.0';
const TO = '2.0.0';

/** The service of the test: it is never installed, so the daemon is started as a child (and nothing real is touched). */
const NO_SERVICE = {
  kind: 'fake',
  id: 'otheater-test',
  install: () => Promise.reject(new ServiceError('not_installed', 'no service in the test')),
  uninstall: () => Promise.resolve(),
  status: () => Promise.reject(new ServiceError('not_installed', 'no service in the test')),
  start: () => Promise.reject(new ServiceError('not_installed', 'no service in the test')),
  stop: () => Promise.resolve(),
} as unknown as ServiceManager;

interface Rig {
  readonly runDir: string;
  readonly dataDir: string;
  readonly layout: InstallLayout;
  readonly v1: Buffer;
  readonly v2: Buffer;
  readonly oldDaemon: Watched;
  readonly journal: UpdateJournal;
}

interface RigOptions {
  readonly v2Mode?: FakeDaemonMode;
  readonly publishGate?: string;
  readonly healthTimeoutMs?: number;
}

let runDir: string;
let children: Watched[] = [];

beforeAll(assertHarnessBuilt);
afterAll(disposeTestGitIsolation);

beforeEach(async () => {
  runDir = await makeRunDir();
});

afterEach(async () => {
  for (const child of children) if (pidAlive(child.pid)) child.process.kill('SIGKILL');
  children = [];
  // Every daemon of the run is in its log: the ones the applier started are not children of the test.
  for (const entry of daemonLog(runDir)) await stopPid(entry.pid);
  await removeRunDir(runDir);
});

// --- the rig ----------------------------------------------------------------------------------

function userVersion(dataDir: string): number {
  const db = new DatabaseSync(join(dataDir, 'store.sqlite'));
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function tables(dataDir: string): string[] {
  const db = new DatabaseSync(join(dataDir, 'store.sqlite'));
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
  } finally {
    db.close();
  }
}

/** An installation of 1.0.0 that runs, a signed 2.0.0 in `staging/`, a real backup of the store, and the journal. */
async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const dataDir = join(runDir, 'data');
  const layout = layoutOf(join(runDir, 'install', 'ot'));
  const paths = dataPaths(dataDir);
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(paths.store);
  db.exec(
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, pid INTEGER, process_started_at INTEGER);' +
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT);' +
      "INSERT INTO notes (text) VALUES ('kept');" +
      'PRAGMA user_version = 1;',
  );
  db.close();

  // The backup the real updater makes before a migration, made by the real code over the real store.
  const config = await loadConfig(paths.config);
  const backup = await createBackup({
    backupDir: join(dataDir, config.backup.dir),
    dataDir,
    content: 'store_only',
    method: 'online_api',
    trigger: 'update',
    clock: composeClock(undefined),
    version: FROM,
    storeBackup: (dest, backupOptions) =>
      composeStoreFileTools(config, dataDir).backupFile(dest, backupOptions),
  });

  const v1 = await writeFakeExe(runDir, layout.exe, { version: FROM, mode: 'healthy', schema: 1 });
  const v2 = await writeFakeExe(runDir, layout.stagingExe, {
    version: TO,
    mode: options.v2Mode ?? 'healthy',
    schema: 2,
    publishGate: options.publishGate,
  });
  const manifestSha256 = await writeProof(layout, KEYS, {
    version: TO,
    platform: 'linux-x64',
    exe: v2,
  });

  // The daemon that is being replaced.
  const oldDaemon = startFakeDaemon(runDir, layout.exe, dataDir);
  children.push(oldDaemon);
  await waitUntil('the old daemon is ready', () =>
    daemonLog(runDir).some((entry) => entry.pid === oldDaemon.pid && entry.event === 'ready'),
  );

  const journal: UpdateJournal = {
    v: 1,
    from: FROM,
    to: TO,
    sha256: sha256Hex(v2),
    manifestSha256,
    step: 'waiting',
    oldPid: oldDaemon.pid,
    applierPid: 0,
    dataDir,
    exe: layout.exe,
    rollback: 'auto',
    healthTimeoutMs: options.healthTimeoutMs ?? 30_000,
    stableMs: 0,
    backup: backup.dir,
    reason: null,
    reported: false,
    startedAt: 1,
    updatedAt: 1,
  };
  await writeJournal(layout.journal, journal);
  return { runDir, dataDir, layout, v1, v2, oldDaemon, journal };
}

/** The old daemon goes away (as it does when it hands over to the applier), and the applier is killed at `crashAt`. */
async function killApplierAt(
  rig: Rig,
  crashAt: string,
  options: { keepOldDaemon?: boolean } = {},
): Promise<void> {
  if (options.keepOldDaemon !== true) {
    rig.oldDaemon.process.kill('SIGTERM');
    await rig.oldDaemon.exited;
  }
  const applier = await startApplierChild({
    runDir: rig.runDir,
    journal: rig.layout.journal,
    publicPem: KEYS.publicPem,
    crashAt,
  });
  children.push(applier);
  const crash = (await applier.line('CRASHPOINT ')) as { point: string; detail?: string };
  expect(`${crash.point}${crash.detail === undefined ? '' : `:${crash.detail}`}`).toBe(
    crashAt.replace(/#\d+$/, ''),
  );
  expect((await applier.exited).signal).toBe('SIGKILL');
}

/** What the next `ot` that starts does with the journal it finds. */
async function recover(rig: Rig): Promise<unknown> {
  const env = childEnv(rig.runDir);
  return await recoverAtStart({
    execPath: rig.layout.exe,
    env,
    trust: TRUST,
    ports: () => {
      // The ports read only the data folder, the layout and the timeouts of the journal.
      return realApplyPorts({
        layout: rig.layout,
        journal: rig.journal,
        logger: LOGGER,
        service: NO_SERVICE,
        env,
      });
    },
  });
}

async function finalStep(rig: Rig): Promise<string> {
  const reading = await readJournal(rig.layout.journal);
  if (reading.kind !== 'ok') throw new Error(`the journal is ${reading.kind}`);
  return reading.journal.step;
}

/** The daemon that is alive on the data folder, by `api.json` (none: `undefined`). */
async function liveDaemon(rig: Rig): Promise<number | undefined> {
  const reading = await readDiscovery(dataPaths(rig.dataDir).apiDiscovery);
  return reading.kind === 'live' ? reading.info.pid : undefined;
}

function invariants(rig: Rig, allowAlive: readonly number[] = []): void {
  const census = takeCensus({
    runDir: rig.runDir,
    stateDir: join(rig.runDir, 'state'),
    storePath: join(rig.dataDir, 'store.sqlite'),
    exclude: allowAlive,
  });
  assertInvariants([
    checkI1({ dataDir: rig.dataDir }),
    checkI3(census),
    // While a daemon lives it holds the instance lock inside a transaction, so SQLite keeps the
    // rollback journal of that lock beside it; it goes with the daemon, and is a leftover after it.
    checkI7({
      root: rig.runDir,
      allowed:
        allowAlive.length === 0
          ? DEFAULT_ALLOWED_LEFTOVERS
          : [...DEFAULT_ALLOWED_LEFTOVERS, /^daemon\.lock-journal$/],
    }),
  ]);
}

/** Leftovers the invariants do not name: the temporary journal of a dead writer, a half-moved executable. */
const INSTALL_LEFTOVERS = [/\.tmp$/, /\.partial$/, /\.new$/, /^update-state\.json\.\d+/];

type Expectation = 'kept' | 'rolled_back';

/**
 * The state after the recovery, in every case: the journal ended; the executable is whole and of the
 * version the outcome says; the store is the one of that version; at most one daemon runs, and it is
 * the one that is installed; the invariants hold; and the version that is installed starts and answers.
 */
async function expectGoodState(rig: Rig, expectation: Expectation): Promise<void> {
  const final = expectation === 'kept' ? 'committed' : 'rolled_back';
  expect(await finalStep(rig)).toBe(final);
  const exe = await readFile(rig.layout.exe);
  expect(exe.equals(expectation === 'kept' ? rig.v2 : rig.v1)).toBe(true);
  if (expectation === 'kept') {
    expect(userVersion(rig.dataDir)).toBe(2);
    expect(tables(rig.dataDir)).toContain('migrated_2');
    // The old executable stays where a later rollback finds it.
    expect(existsSync(rig.layout.previousExe)).toBe(true);
  } else {
    expect(userVersion(rig.dataDir)).toBe(1);
    expect(tables(rig.dataDir)).not.toContain('migrated_2');
    expect(tables(rig.dataDir)).toContain('notes');
    expect(existsSync(rig.layout.previousExe)).toBe(false);
  }
  expect(await findLeftovers(join(rig.runDir, 'install'), INSTALL_LEFTOVERS)).toEqual([]);

  // At most one daemon is alive: the one the installed version is.
  const version = expectation === 'kept' ? TO : FROM;
  const probe = createHealthProbe({ dataDir: rig.dataDir });
  let daemon = await liveDaemon(rig);
  invariants(rig, daemon === undefined ? [] : [daemon]);
  if (daemon === undefined) {
    const started = startFakeDaemon(rig.runDir, rig.layout.exe, rig.dataDir);
    children.push(started);
    await waitUntil('the installed version starts', () =>
      daemonLog(rig.runDir).some((entry) => entry.pid === started.pid && entry.event === 'ready'),
    );
    daemon = started.pid;
  }
  expect(await probe({ version, notPid: 0 })).toBe('ok');
  expect(
    daemonLog(rig.runDir)
      .filter((entry) => entry.pid === daemon)
      .map((entry) => entry.version),
  ).toEqual(expect.arrayContaining([version]));
  await stopPid(daemon);
  await waitGone(daemon);
  invariants(rig);
}

// --- the applier killed ------------------------------------------------------------------------

/** Where the applier is killed in a swap that goes well, and what the recovery must make of it. */
const SWAP_POINTS: readonly { at: string; ends: Expectation }[] = [
  { at: 'apply.before_journal:waiting', ends: 'rolled_back' },
  { at: 'journal.before_rename#1', ends: 'rolled_back' },
  { at: 'apply.after_journal:waiting', ends: 'rolled_back' },
  { at: 'swap.before_link', ends: 'rolled_back' },
  { at: 'swap.after_unlink_previous', ends: 'rolled_back' },
  { at: 'swap.after_link', ends: 'rolled_back' },
  { at: 'apply.before_journal:linked', ends: 'rolled_back' },
  { at: 'journal.before_rename#2', ends: 'rolled_back' },
  { at: 'apply.after_journal:linked', ends: 'rolled_back' },
  { at: 'swap.before_place', ends: 'rolled_back' },
  // The new executable is in place and the journal still says `linked`: no daemon ran, so it goes back.
  { at: 'swap.after_place', ends: 'rolled_back' },
  { at: 'apply.before_journal:placed', ends: 'rolled_back' },
  { at: 'journal.before_rename#3', ends: 'rolled_back' },
  { at: 'apply.after_journal:placed', ends: 'rolled_back' },
  { at: 'apply.before_journal:starting', ends: 'rolled_back' },
  { at: 'journal.before_rename#4', ends: 'rolled_back' },
  { at: 'apply.after_journal:starting', ends: 'rolled_back' },
  // The new daemon is up and answers: the recovery keeps the version.
  { at: 'apply.after_start_daemon', ends: 'kept' },
  { at: 'apply.before_journal:checking', ends: 'kept' },
  { at: 'journal.before_rename#5', ends: 'kept' },
  { at: 'apply.after_journal:checking', ends: 'kept' },
  { at: 'apply.before_commit', ends: 'kept' },
  { at: 'apply.before_journal:committed', ends: 'kept' },
  { at: 'journal.before_rename#6', ends: 'kept' },
  // The journal already says `committed`: nothing is left to decide, only the staging folder to forget.
  { at: 'apply.after_journal:committed', ends: 'kept' },
  { at: 'swap.before_clear_staging', ends: 'kept' },
];

describe.skipIf(process.platform !== 'linux')(
  'the applier of an update, killed',
  { timeout: 240_000 },
  () => {
    it.each(SWAP_POINTS)('SIGKILL at $at: the recovery ends in "$ends"', async ({ at, ends }) => {
      const rig = await makeRig();
      await killApplierAt(rig, at);
      const recovery = (await recover(rig)) as { kind: string };
      expect(['finished', 'none']).toContain(recovery.kind);
      await expectGoodState(rig, ends);
      // A second start of `ot` finds nothing to do.
      expect(await recover(rig)).toEqual({ kind: 'none' });
    });

    it('SIGKILL while the old daemon is still there: nothing was moved, and the old daemon is left alone', async () => {
      const rig = await makeRig();
      await killApplierAt(rig, 'apply.after_journal:waiting', { keepOldDaemon: true });
      expect(pidAlive(rig.oldDaemon.pid)).toBe(true);
      const recovery = (await recover(rig)) as { kind: string };
      expect(recovery.kind).toBe('finished');
      expect(await finalStep(rig)).toBe('rolled_back');
      expect(pidAlive(rig.oldDaemon.pid)).toBe(true);
      invariants(rig, [rig.oldDaemon.pid]);
      await expectGoodState(rig, 'rolled_back');
    });

    it('the recovery does not touch a swap whose applier is still running', async () => {
      const rig = await makeRig();
      const live = await writeJournalWith(rig, { applierPid: rig.oldDaemon.pid, step: 'linked' });
      expect(live).toBe('linked');
      expect(await recover(rig)).toEqual({ kind: 'running' });
      expect(await finalStep(rig)).toBe('linked');
    });
  },
);

async function writeJournalWith(rig: Rig, patch: Partial<UpdateJournal>): Promise<string> {
  await writeJournal(rig.layout.journal, { ...rig.journal, ...patch });
  return await finalStep(rig);
}

// --- the new version does not hold: the automatic rollback, and the applier killed in it --------

const ROLLBACK_POINTS: readonly string[] = [
  'apply.before_journal:rolling_back',
  'journal.before_rename#6',
  'apply.after_journal:rolling_back',
  'swap.before_restore',
  'swap.after_restore',
  'apply.before_journal:rolled_back',
  'journal.before_rename#7',
  'apply.after_journal:rolled_back',
];

describe.skipIf(process.platform !== 'linux')(
  'the automatic rollback of an update that does not hold',
  { timeout: 240_000 },
  () => {
    it('the applier takes the old version back, with its store, when the new daemon answers 503', async () => {
      const rig = await makeRig({ v2Mode: 'unhealthy', healthTimeoutMs: 4000 });
      rig.oldDaemon.process.kill('SIGTERM');
      await rig.oldDaemon.exited;
      const applier = await startApplierChild({
        runDir,
        journal: rig.layout.journal,
        publicPem: KEYS.publicPem,
      });
      children.push(applier);
      const outcome = (await applier.line('OUTCOME ')) as { kind: string; reason?: string };
      expect(outcome).toEqual({ kind: 'rolled_back', reason: 'health' });
      expect((await applier.exited).code).toBe(0);
      await expectGoodState(rig, 'rolled_back');
    });

    it.each(ROLLBACK_POINTS)('SIGKILL at %s: the recovery finishes the rollback', async (at) => {
      const rig = await makeRig({ v2Mode: 'unhealthy', healthTimeoutMs: 4000 });
      await killApplierAt(rig, at);
      await recover(rig);
      await expectGoodState(rig, 'rolled_back');
      expect(await recover(rig)).toEqual({ kind: 'none' });
    });

    it('a new daemon that dies at once is taken back too (the applier killed once the rollback began)', async () => {
      const rig = await makeRig({ v2Mode: 'dies_on_start', healthTimeoutMs: 4000 });
      await killApplierAt(rig, 'apply.after_journal:rolling_back');
      await recover(rig);
      await expectGoodState(rig, 'rolled_back');
    });

    it('a new daemon that holds the instance lock before it publishes api.json does not escape the rollback', async () => {
      // The migration of the real daemon happens after the lock and before api.json: when it takes
      // longer than the health timeout, the applier sees "not started" and rolls back while the
      // daemon is still there with the lock. The rollback has to stop it, or the backup cannot be
      // restored (it needs the lock) and the old executable would run over a migrated store.
      const gate = join(runDir, 'publish.gate');
      const rig = await makeRig({ v2Mode: 'healthy', publishGate: gate, healthTimeoutMs: 1500 });
      rig.oldDaemon.process.kill('SIGTERM');
      await rig.oldDaemon.exited;
      const applier = await startApplierChild({
        runDir,
        journal: rig.layout.journal,
        publicPem: KEYS.publicPem,
      });
      children.push(applier);
      const outcome = (await applier.line('OUTCOME ')) as { kind: string; reason?: string };
      expect(outcome).toEqual({ kind: 'rolled_back', reason: 'not_started' });
      await applier.exited;

      // The daemon of 2.0.0 is not alive, and the store is the one of 1.0.0.
      const started = daemonLog(runDir).filter(
        (entry) => entry.version === TO && entry.event === 'locked',
      );
      expect(started.length).toBeGreaterThan(0);
      for (const entry of started) expect(pidAlive(entry.pid)).toBe(false);
      await expectGoodState(rig, 'rolled_back');
    });
  },
);
