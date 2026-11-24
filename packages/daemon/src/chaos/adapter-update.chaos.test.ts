// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AdapterUnavailable } from '@otheater/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureAdapter } from '../adapters/adapter-fixture.js';
import {
  adapterDir,
  adapterEntry,
  AdapterInstallError,
  INSTALL_CRASH_POINTS,
  installAdapter,
  isInstalled,
} from '../adapters/install.js';
import { AdapterManager } from '../adapters/manager.js';
import { tarballPath } from '../adapters/adapter-fixture.js';
import { RecordingSituations } from '../test-helpers.js';
import { takeCensus } from './census.js';
import { assertHarnessBuilt } from './harness.js';
import { assertInvariants, checkI1, checkI3, checkI7 } from './invariants.js';
import {
  ADAPTER_LEFTOVERS,
  ChaosRegistry,
  chaosAdapter,
  findLeftovers,
  LINUX_X64,
  makeRunDir,
  pidAlive,
  removeRunDir,
  startAdapterChild,
  stopPid,
  waitGone,
  waitUntil,
  type Watched,
} from './update-chaos-fixture.js';

/**
 * Chaos C, the managed adapter (Phase 11, P6; docs/23): the installer of the ACP adapter
 * (`adapters/install.ts`) runs as a process of its own and is killed with SIGKILL at the named points
 * of its steps and in the middle of a download, the registry goes away or serves a file that is cut,
 * and a new version is installed while a session of the old one is running. After every cut: no half
 * installation is ever used (I1, I3 and I7 hold, the manager does not hand out a command for a folder
 * that is not whole), and the next installation ends in a complete one. The packages are made in the
 * test, the registry is on the loopback; nothing is downloaded.
 */

const ID = 'claude-agent-acp';

let runDir: string;
let dataDir: string;
let adaptersDir: string;
let registry: ChaosRegistry | undefined;
let children: Watched[] = [];
let sessions: number[] = [];

beforeAll(assertHarnessBuilt);

beforeEach(async () => {
  runDir = await makeRunDir();
  dataDir = join(runDir, 'data');
  adaptersDir = join(dataDir, 'adapters');
  await mkdir(adaptersDir, { recursive: true });
  // A small real store: I1 looks at it, and the census reads `sessions` from it.
  const db = new DatabaseSync(join(dataDir, 'store.sqlite'));
  db.exec(
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, pid INTEGER, process_started_at INTEGER);' +
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT);' +
      "INSERT INTO notes (text) VALUES ('kept');",
  );
  db.close();
});

afterEach(async () => {
  for (const child of children) {
    if (pidAlive(child.pid)) child.process.kill('SIGKILL');
  }
  for (const pid of sessions) await stopPid(pid);
  children = [];
  sessions = [];
  await registry?.close();
  registry = undefined;
  await removeRunDir(runDir);
});

// --- helpers ---------------------------------------------------------------------------------

function managerFor(
  adapterOf: () => FixtureAdapter,
  situations = new RecordingSituations(),
  installOptions: Record<string, unknown> = {},
): { manager: AdapterManager; situations: RecordingSituations } {
  const manager = new AdapterManager({
    adaptersDir,
    install: 'auto',
    registry: registry?.url ?? 'http://127.0.0.1:1',
    find: (command) =>
      command === 'claude' || command === 'codex' ? `/usr/bin/${command}` : undefined,
    platform: LINUX_X64,
    self: { sea: false, execPath: process.execPath },
    lockOf: (id) => ({ ...adapterOf().lock, id }),
    installOptions: { retryDelayMs: 0, retries: 0, concurrency: 1, ...installOptions },
    situations,
    logger: { info: () => undefined, warn: () => undefined },
  });
  return { manager, situations };
}

const noticeKinds = (situations: RecordingSituations): string[] =>
  situations.of('daemon.notice').map((payload) => (payload as { kind: string }).kind);

async function startRegistry(...adapters: FixtureAdapter[]): Promise<ChaosRegistry> {
  registry = await ChaosRegistry.start(...adapters);
  return registry;
}

function child(watched: Watched): Watched {
  children.push(watched);
  return watched;
}

/** Waits for the child to be gone and says it was the SIGKILL that took it. */
async function expectKilled(watched: Watched): Promise<void> {
  const exit = await watched.exited;
  expect(exit.signal).toBe('SIGKILL');
}

function invariants(allowedAlive: readonly number[] = []): void {
  const census = takeCensus({
    runDir,
    stateDir: join(runDir, 'state'),
    storePath: join(dataDir, 'store.sqlite'),
    exclude: allowedAlive,
  });
  assertInvariants([checkI1({ dataDir }), checkI3(census), checkI7({ root: runDir })]);
}

async function leftovers(): Promise<string[]> {
  return (await findLeftovers(adaptersDir, ADAPTER_LEFTOVERS)).map((path) =>
    path.slice(adaptersDir.length),
  );
}

/** No folder that is not whole may be handed out: the entry is not there, and the manager says so. */
async function expectNotUsable(adapter: FixtureAdapter): Promise<void> {
  const dir = adapterDir(adaptersDir, adapter.lock);
  expect(await isInstalled(dir, adapter.lock)).toBe(false);
  expect(existsSync(adapterEntry(dir, adapter.lock))).toBe(false);
  expect(existsSync(join(dir, '.otheater-adapter.json'))).toBe(false);
  const { manager } = managerFor(() => adapter);
  expect(() => manager.commandFor('claude-code', 'managed')).toThrow(AdapterUnavailable);
}

/** Starts the adapter the manager hands out, as the daemon starts a session, and waits until it runs. */
async function startSession(adapter: FixtureAdapter, name: string): Promise<number> {
  const { manager } = managerFor(() => adapter);
  const { cmd, args } = manager.commandFor('claude-code', 'managed');
  const ready = join(runDir, `ready-${name}.json`);
  const session = spawn(cmd, [...args], {
    cwd: runDir,
    env: { ...process.env, OT_ADAPTER_READY: ready, OT_ADAPTER_VERSION: adapter.lock.version },
    stdio: 'ignore',
  });
  const pid = session.pid ?? 0;
  sessions.push(pid);
  await waitUntil(`the session ${name} runs`, () => existsSync(ready));
  const info = JSON.parse(await readFile(ready, 'utf8')) as { version: string; pid: number };
  expect(info).toEqual({ version: adapter.lock.version, pid });
  return pid;
}

async function endSession(pid: number): Promise<void> {
  await stopPid(pid);
  sessions = sessions.filter((candidate) => candidate !== pid);
}

// --- the installer killed at the points of its steps ----------------------------------------

const POINTS: readonly { at: string; point: string; whole?: true }[] = [
  { at: INSTALL_CRASH_POINTS.afterLock, point: INSTALL_CRASH_POINTS.afterLock },
  // The files of `fake-acp` are the first four writes, the nine files of the two packages in all.
  { at: `${INSTALL_CRASH_POINTS.afterFile}#1`, point: INSTALL_CRASH_POINTS.afterFile },
  { at: `${INSTALL_CRASH_POINTS.afterFile}#4`, point: INSTALL_CRASH_POINTS.afterFile },
  { at: `${INSTALL_CRASH_POINTS.afterFile}#5`, point: INSTALL_CRASH_POINTS.afterFile },
  { at: `${INSTALL_CRASH_POINTS.afterFile}#9`, point: INSTALL_CRASH_POINTS.afterFile },
  { at: INSTALL_CRASH_POINTS.beforeMarker, point: INSTALL_CRASH_POINTS.beforeMarker },
  { at: INSTALL_CRASH_POINTS.afterMarker, point: INSTALL_CRASH_POINTS.afterMarker },
  { at: INSTALL_CRASH_POINTS.beforeSwap, point: INSTALL_CRASH_POINTS.beforeSwap },
  { at: INSTALL_CRASH_POINTS.afterSwap, point: INSTALL_CRASH_POINTS.afterSwap, whole: true },
];

describe.skipIf(process.platform !== 'linux')(
  'the installer of the managed adapter, killed',
  { timeout: 240_000 },
  () => {
    describe.each([
      { variant: 'a clean folder', junk: false },
      { variant: 'an incomplete folder already at the target', junk: true },
    ])('with $variant', ({ junk }) => {
      it.each(POINTS)(
        'SIGKILL at $at: nothing half done is used, and the next install ends whole',
        async ({ at, point, whole }) => {
          const adapter = chaosAdapter('1.0.0');
          const server = await startRegistry(adapter);
          const dir = adapterDir(adaptersDir, adapter.lock);
          if (junk) {
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'half.txt'), 'a folder that no marker vouches for');
          }

          const installer = child(
            await startAdapterChild({
              runDir,
              adaptersDir,
              registry: server.url,
              adapter,
              crashAt: at,
            }),
          );
          const crash = (await installer.line('CRASHPOINT ')) as { point: string };
          expect(crash.point).toBe(point);
          await expectKilled(installer);

          // After the cut.
          if (whole === true) {
            expect(await isInstalled(dir, adapter.lock)).toBe(true);
            const { manager } = managerFor(() => adapter);
            expect(manager.commandFor('claude-code', 'managed').args).toEqual([
              adapterEntry(dir, adapter.lock),
            ]);
          } else {
            await expectNotUsable(adapter);
          }
          invariants();

          // The next installation: the lock of the dead installer does not hold it back.
          const { manager, situations } = managerFor(() => adapter, undefined, {
            lockWaitMs: 20_000,
          });
          const result = await manager.ensure('claude-code');
          expect(result.status).toBe(whole === true ? 'already_installed' : 'installed');
          expect(await isInstalled(dir, adapter.lock)).toBe(true);
          expect(existsSync(join(dir, 'half.txt'))).toBe(false);
          expect(noticeKinds(situations)).not.toContain('adapter_install_failed');
          const pid = await startSession(adapter, 'after');
          await endSession(pid);
          await waitGone(pid);

          if (whole === true) {
            // The folder is whole, so nothing sweeps what the cut left (the lock, the folder moved
            // aside); the installation of the next version does, and it is not held back either.
            const next = chaosAdapter('1.0.1');
            await server.close();
            registry = await ChaosRegistry.start(adapter, next);
            const second = managerFor(() => next, undefined, { lockWaitMs: 20_000 });
            await second.manager.ensure('claude-code');
          }
          expect(await leftovers()).toEqual([]);
          invariants();
        },
      );
    });

    it('SIGKILL while the first tarball is held half-way: no folder is left that could be used', async () => {
      const adapter = chaosAdapter('1.0.0');
      const server = await startRegistry(adapter);
      server.mode(tarballPath('fake-acp', '1.0.0'), 'hold-half');
      const installer = child(
        await startAdapterChild({ runDir, adaptersDir, registry: server.url, adapter }),
      );
      await server.reached(tarballPath('fake-acp', '1.0.0'));
      installer.process.kill('SIGKILL');
      await expectKilled(installer);

      await expectNotUsable(adapter);
      invariants();

      server.mode(tarballPath('fake-acp', '1.0.0'), 'serve');
      const { manager } = managerFor(() => adapter, undefined, { lockWaitMs: 20_000 });
      expect((await manager.ensure('claude-code')).status).toBe('installed');
      expect(await leftovers()).toEqual([]);
      invariants();
    });

    it('SIGKILL while the second tarball is held half-way (the first is already on the disk)', async () => {
      const adapter = chaosAdapter('1.0.0');
      const server = await startRegistry(adapter);
      const second = tarballPath('fake-dep', '1.0.0');
      server.mode(second, 'hold-half');
      const installer = child(
        await startAdapterChild({ runDir, adaptersDir, registry: server.url, adapter }),
      );
      await server.reached(second);
      // The staging folder has the first package whole: the cut leaves a tree that looks like an installation.
      const staged = await findLeftovers(adaptersDir, [/^\.tmp-/]);
      expect(staged).toHaveLength(1);
      expect(
        existsSync(join(staged[0] ?? '', 'node_modules', 'fake-acp', 'dist', 'index.js')),
      ).toBe(true);
      installer.process.kill('SIGKILL');
      await expectKilled(installer);

      await expectNotUsable(adapter);
      invariants();

      server.mode(second, 'serve');
      const { manager } = managerFor(() => adapter, undefined, { lockWaitMs: 20_000 });
      expect((await manager.ensure('claude-code')).status).toBe('installed');
      expect(await leftovers()).toEqual([]);
      invariants();
    });

    it('the lock a killed installer leaves is taken over at once (lock_takeover: dead_owner) and not before the stale age with stale_only', async () => {
      const adapter = chaosAdapter('1.0.0');
      const server = await startRegistry(adapter);
      const installer = child(
        await startAdapterChild({
          runDir,
          adaptersDir,
          registry: server.url,
          adapter,
          crashAt: INSTALL_CRASH_POINTS.afterLock,
        }),
      );
      await installer.line('CRASHPOINT ');
      await expectKilled(installer);
      expect(existsSync(join(adaptersDir, ID, '.install.lock'))).toBe(true);

      // The old rule: only a lock older than `lockStaleMs` is taken over, so a retry waits and gives up.
      const base = {
        lock: adapter.lock,
        adaptersDir,
        registry: server.url,
        platform: LINUX_X64,
        retries: 0,
        retryDelayMs: 0,
        concurrency: 1,
      } as const;
      await expect(
        installAdapter({ ...base, lockTakeover: 'stale_only', lockWaitMs: 1500 }),
      ).rejects.toMatchObject({ code: 'locked' });
      expect(await isInstalled(adapterDir(adaptersDir, adapter.lock), adapter.lock)).toBe(false);

      // The default: the process that wrote the lock is gone, so it is taken over.
      const result = await installAdapter({ ...base, lockWaitMs: 1500 });
      expect(result.status).toBe('installed');
      expect(await leftovers()).toEqual([]);
      invariants();
    });

    it('a lock of a live installer is waited for, not taken over', async () => {
      const adapter = chaosAdapter('1.0.0');
      const server = await startRegistry(adapter);
      // The lock names this test process, which is alive.
      await mkdir(join(adaptersDir, ID), { recursive: true });
      await writeFile(join(adaptersDir, ID, '.install.lock'), `${String(process.pid)} now\n`);
      await expect(
        installAdapter({
          lock: adapter.lock,
          adaptersDir,
          registry: server.url,
          platform: LINUX_X64,
          retries: 0,
          retryDelayMs: 0,
          lockWaitMs: 600,
        }),
      ).rejects.toMatchObject({ code: 'locked' });
      expect(server.requests).toEqual([]);
    });
  },
);

// --- the registry goes away, the file arrives cut ---------------------------------------------

describe.skipIf(process.platform !== 'linux')(
  'the managed adapter and a registry that fails',
  { timeout: 240_000 },
  () => {
    async function failsThenRecovers(
      prepare: (server: ChaosRegistry, adapter: FixtureAdapter) => Promise<void> | void,
      expectedCode: string,
      heal: (server: ChaosRegistry, adapter: FixtureAdapter) => Promise<void> | void,
    ): Promise<void> {
      const adapter = chaosAdapter('1.0.0');
      const server = await startRegistry(adapter);
      await prepare(server, adapter);
      const { manager, situations } = managerFor(() => adapter);

      const failure: unknown = await manager.ensure('claude-code').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AdapterInstallError);
      expect((failure as AdapterInstallError).code).toBe(expectedCode);
      // The situation is told as an event, and what the cut left is not used (and not kept).
      expect(noticeKinds(situations)).toContain('adapter_install_failed');
      await expectNotUsable(adapter);
      expect(await leftovers()).toEqual([]);
      invariants();
      expect(manager.status('claude-code').failure).toContain(expectedCode);

      await heal(server, adapter);
      expect((await manager.ensure('claude-code')).status).toBe('installed');
      expect(manager.status('claude-code').failure).toBeUndefined();
      expect(await leftovers()).toEqual([]);
      invariants();
    }

    it('the registry is down: network error, nothing left, installs when it is back', async () => {
      await failsThenRecovers(
        async (server) => {
          await server.stop();
        },
        'network',
        async (server) => {
          await server.restart();
        },
      );
    });

    it('the registry goes down in the middle of the second tarball', async () => {
      const adapter = chaosAdapter('1.0.0');
      const server = await startRegistry(adapter);
      const second = tarballPath('fake-dep', '1.0.0');
      server.mode(second, 'hold-half');
      const { manager, situations } = managerFor(() => adapter);
      const attempt = manager.ensure('claude-code').then(
        () => undefined,
        (error: unknown) => error,
      );
      await server.reached(second);
      await server.stop();
      const failure = await attempt;
      expect(failure).toBeInstanceOf(AdapterInstallError);
      expect((failure as AdapterInstallError).code).toBe('network');
      expect(noticeKinds(situations)).toContain('adapter_install_failed');
      await expectNotUsable(adapter);
      expect(await leftovers()).toEqual([]);
      invariants();

      await server.restart();
      server.mode(second, 'serve');
      expect((await manager.ensure('claude-code')).status).toBe('installed');
      expect(await leftovers()).toEqual([]);
      invariants();
    });

    it('the connection is cut half-way through the file', async () => {
      await failsThenRecovers(
        (server) => {
          server.mode(tarballPath('fake-acp', '1.0.0'), 'cut-half');
        },
        'network',
        (server) => {
          server.mode(tarballPath('fake-acp', '1.0.0'), 'serve');
        },
      );
    });

    it('the file arrives short with a matching length: the integrity check refuses it', async () => {
      await failsThenRecovers(
        (server) => {
          server.mode(tarballPath('fake-dep', '1.0.0'), 'short');
        },
        'integrity',
        (server) => {
          server.mode(tarballPath('fake-dep', '1.0.0'), 'serve');
        },
      );
    });

    it('the registry answers 503', async () => {
      await failsThenRecovers(
        (server) => {
          server.mode(tarballPath('fake-acp', '1.0.0'), { status: 503 });
        },
        'registry_status',
        (server) => {
          server.mode(tarballPath('fake-acp', '1.0.0'), 'serve');
        },
      );
    });
  },
);

// --- the version is switched with a session running -------------------------------------------

describe.skipIf(process.platform !== 'linux')(
  'the version of the managed adapter is switched with a session running',
  { timeout: 240_000 },
  () => {
    it('the new version is installed beside the old one, and the session of the old one is untouched', async () => {
      const v1 = chaosAdapter('1.0.0');
      const v2 = chaosAdapter('2.0.0');
      await startRegistry(v1, v2);
      let current = v1;
      const { manager } = managerFor(() => current, undefined, { lockWaitMs: 20_000 });
      await manager.ensure('claude-code');
      const session = await startSession(v1, 'v1');

      current = v2;
      expect(() => manager.commandFor('claude-code', 'managed')).toThrow(AdapterUnavailable);
      await manager.ensure('claude-code');

      expect(pidAlive(session)).toBe(true);
      expect(await isInstalled(adapterDir(adaptersDir, v1.lock), v1.lock)).toBe(true);
      expect(manager.commandFor('claude-code', 'managed').args).toEqual([
        adapterEntry(adapterDir(adaptersDir, v2.lock), v2.lock),
      ]);
      expect(await leftovers()).toEqual([]);

      await endSession(session);
      invariants();
    });

    it('the install of the new version is killed mid-download: the old version and its session are untouched, and the retry ends whole', async () => {
      const v1 = chaosAdapter('1.0.0');
      const v2 = chaosAdapter('2.0.0');
      const server = await startRegistry(v1, v2);
      let current = v1;
      const { manager } = managerFor(() => current, undefined, { lockWaitMs: 20_000 });
      await manager.ensure('claude-code');
      const session = await startSession(v1, 'v1');

      const second = tarballPath('fake-dep', '2.0.0');
      server.mode(second, 'hold-half');
      const installer = child(
        await startAdapterChild({ runDir, adaptersDir, registry: server.url, adapter: v2 }),
      );
      await server.reached(second);
      installer.process.kill('SIGKILL');
      await expectKilled(installer);

      // The cut happened beside a running session of the old version, which does not notice.
      expect(pidAlive(session)).toBe(true);
      expect(await isInstalled(adapterDir(adaptersDir, v1.lock), v1.lock)).toBe(true);
      expect(manager.commandFor('claude-code', 'managed').args).toEqual([
        adapterEntry(adapterDir(adaptersDir, v1.lock), v1.lock),
      ]);
      await expectNotUsable(v2);

      // The retry: the version is switched, the old one stays where it is (a session may still use it).
      server.mode(second, 'serve');
      current = v2;
      expect((await manager.ensure('claude-code')).status).toBe('installed');
      expect(pidAlive(session)).toBe(true);
      expect(await isInstalled(adapterDir(adaptersDir, v1.lock), v1.lock)).toBe(true);
      expect(await isInstalled(adapterDir(adaptersDir, v2.lock), v2.lock)).toBe(true);
      expect(await leftovers()).toEqual([]);

      await endSession(session);
      const next = await startSession(v2, 'v2');
      await endSession(next);
      invariants();
    });
  },
);
