// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../../paths.js';
import { recoverInterrupted, type ApplyPorts } from './applier.js';
import { createHealthProbe } from './health.js';
import { readJournal, writeJournal, type UpdateJournal } from './journal.js';
import { applierArguments } from './launch.js';
import { layoutOf } from './layout.js';
import { recoverAtStart } from './recover.js';
import { composeOwnSchemas } from '../../compose.js';
import { newestMigration } from './schemas.js';
import {
  clearStaging,
  exists,
  linkPrevious,
  placeStaged,
  restorePrevious,
  undoLink,
} from './swap.js';
import { migrationTestHook } from './test-migration.js';

/** The small pieces of the applier: layout, journal, file moves, health look, hook, recovery at the start. */

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-apply-support-'));
  folders.push(dir);
  return dir;
}

const JOURNAL: UpdateJournal = {
  v: 1,
  from: '0.5.0',
  to: '0.6.0',
  sha256: 'a'.repeat(64),
  step: 'waiting',
  oldPid: 0,
  applierPid: 0,
  dataDir: '/data',
  exe: '/x/ot',
  rollback: 'auto',
  healthTimeoutMs: 1000,
  stableMs: 0,
  backup: null,
  reason: null,
  reported: false,
  startedAt: 1,
  updatedAt: 1,
};

describe('layoutOf and applierArguments', () => {
  const exe = join(sep, 'opt', 'ot', 'ot');
  const folder = join(sep, 'opt', 'ot');

  it('puts previous, staging and the journal beside the executable', () => {
    const layout = layoutOf(exe);
    expect(layout).toMatchObject({
      folder,
      previousExe: join(folder, 'previous', 'ot'),
      stagingExe: join(folder, 'staging', 'ot'),
      journal: join(folder, 'update-state.json'),
    });
    expect(layoutOf(join(folder, 'ot.exe')).previousExe.endsWith('ot.exe')).toBe(true);
  });

  it('names the internal mode and the journal', () => {
    expect(applierArguments(layoutOf(exe))).toEqual([
      '--ot-internal=apply-update',
      '--journal',
      join(folder, 'update-state.json'),
    ]);
  });
});

describe('journal', () => {
  it('writes whole and reads back; none and corrupt are told apart', async () => {
    const dir = await temp();
    const file = join(dir, 'update-state.json');
    expect(await readJournal(file)).toEqual({ kind: 'none' });
    await writeJournal(file, JOURNAL);
    expect(await readJournal(file)).toEqual({ kind: 'ok', journal: JOURNAL });
    await writeFile(file, '{"v":1,');
    expect(await readJournal(file)).toEqual({ kind: 'corrupt' });
    await writeFile(file, JSON.stringify({ ...JOURNAL, step: 'bogus' }));
    expect(await readJournal(file)).toEqual({ kind: 'corrupt' });
  });
});

describe('swap', () => {
  it('links, places, restores and undoes with the executable never absent', async () => {
    const dir = await temp();
    const layout = layoutOf(join(dir, 'ot'));
    await mkdir(layout.stagingDir, { recursive: true });
    await writeFile(layout.exe, 'old');
    await writeFile(layout.stagingExe, 'new');
    await linkPrevious(layout);
    expect(await readFile(layout.previousExe, 'utf8')).toBe('old');
    expect(await readFile(layout.exe, 'utf8')).toBe('old');
    await placeStaged(layout);
    expect(await readFile(layout.exe, 'utf8')).toBe('new');
    expect(await readFile(layout.previousExe, 'utf8')).toBe('old');
    expect(await exists(layout.stagingExe)).toBe(false);
    if (process.platform !== 'win32') {
      expect((await stat(layout.exe)).mode & 0o111).not.toBe(0);
    }
    await restorePrevious(layout);
    expect(await readFile(layout.exe, 'utf8')).toBe('old');
    await writeFile(layout.previousExe, 'x');
    await undoLink(layout);
    expect(await exists(layout.previousExe)).toBe(false);
    await clearStaging(layout);
    expect(await exists(layout.stagingDir)).toBe(false);
  });

  it('keeps only one previous: a second swap replaces it', async () => {
    const dir = await temp();
    const layout = layoutOf(join(dir, 'ot'));
    await mkdir(layout.previousDir, { recursive: true });
    await writeFile(layout.exe, 'v2');
    await writeFile(layout.previousExe, 'v1');
    await linkPrevious(layout);
    expect(await readFile(layout.previousExe, 'utf8')).toBe('v2');
  });
});

describe('schemas', () => {
  it('reads the number of the newest migration', () => {
    expect(newestMigration({})).toBe(0);
    expect(newestMigration({ '0001_a': 1, '0010_setup': 2, '0003_b': 3, junk: 4 })).toBe(10);
  });

  it('gives the schemas of this daemon, as the manifest says them', () => {
    expect(composeOwnSchemas()).toEqual({ store: 10, telemetry: 3 });
  });
});

describe('migrationTestHook', () => {
  it('names the bases, and answers nothing in the release build', () => {
    expect(migrationTestHook({ env: {} })).toEqual([]);
    expect(migrationTestHook({ env: { OT_TEST_MIGRATION: 'store' } })).toEqual(['store']);
    expect(migrationTestHook({ env: { OT_TEST_MIGRATION: 'telemetry, store' } })).toEqual([
      'store',
      'telemetry',
    ]);
    expect(migrationTestHook({ env: { OT_TEST_MIGRATION: '1' } })).toEqual(['store', 'telemetry']);
    expect(migrationTestHook({ env: { OT_TEST_MIGRATION: '1' }, releaseBuild: true })).toEqual([]);
  });
});

describe('createHealthProbe', () => {
  async function dataDir(pid: number): Promise<string> {
    const dir = await temp();
    const paths = dataPaths(dir);
    await writeFile(paths.apiToken, 'tok\n');
    await writeFile(
      paths.apiDiscovery,
      `${JSON.stringify({ url: 'http://127.0.0.1:1', pid, daemonId: randomUUID(), apiVersion: 1 })}\n`,
    );
    return dir;
  }
  const answer =
    (status: number, body: unknown): typeof fetch =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('is down with no api.json, with a dead pid, or when the old daemon still answers', async () => {
    const empty = await temp();
    expect(
      await createHealthProbe({ dataDir: empty, fetch: answer(200, {}) })({
        version: '1',
        notPid: 0,
      }),
    ).toBe('down');
    const dir = await dataDir(4242);
    const dead = createHealthProbe({ dataDir: dir, alive: () => false, fetch: answer(200, {}) });
    expect(await dead({ version: '1', notPid: 0 })).toBe('down');
    const same = createHealthProbe({ dataDir: dir, alive: () => true, fetch: answer(200, {}) });
    expect(await same({ version: '1', notPid: 4242 })).toBe('down');
  });

  it('is ok for the new version, unhealthy for a non-200, down for another version or a refusal', async () => {
    const dir = await dataDir(4242);
    const ok = { status: 'ok', version: '0.6.0', pid: 4242 };
    const probe = (fetch: typeof globalThis.fetch) =>
      createHealthProbe({ dataDir: dir, alive: () => true, fetch });
    expect(await probe(answer(200, ok))({ version: '0.6.0', notPid: 1 })).toBe('ok');
    expect(
      await probe(answer(200, { ...ok, version: '0.5.0' }))({ version: '0.6.0', notPid: 1 }),
    ).toBe('down');
    expect(await probe(answer(503, {}))({ version: '0.6.0', notPid: 1 })).toBe('unhealthy');
    expect(await probe(answer(200, { nope: true }))({ version: '0.6.0', notPid: 1 })).toBe(
      'unhealthy',
    );
    expect(
      await probe(() => Promise.reject(new Error('ECONNREFUSED')))({ version: '0.6.0', notPid: 1 }),
    ).toBe('down');
  });
});

describe('recoverAtStart', () => {
  it('does nothing with no journal and never throws', async () => {
    const dir = await temp();
    expect(await recoverAtStart({ execPath: join(dir, 'ot') })).toEqual({ kind: 'none' });
    await writeFile(join(dir, 'update-state.json'), 'not json');
    expect(await recoverAtStart({ execPath: join(dir, 'ot') })).toEqual({ kind: 'corrupt' });
  });

  it('ignores a journal of another folder', async () => {
    const dir = await temp();
    await writeJournal(join(dir, 'update-state.json'), {
      ...JOURNAL,
      step: 'placed',
      exe: join(await temp(), 'ot'),
    });
    expect(await recoverAtStart({ execPath: join(dir, 'ot') })).toEqual({ kind: 'none' });
  });

  it('finishes a swap whose applier died: the new daemon answers, so it is committed', async () => {
    if (process.platform === 'win32') return;
    const dir = await temp();
    const layout = layoutOf(join(dir, 'ot'));
    await mkdir(layout.previousDir, { recursive: true });
    await writeFile(layout.exe, '#!/bin/sh\n');
    await chmod(layout.exe, 0o755);
    await writeFile(layout.previousExe, '#!/bin/sh\n# old\n');
    await writeJournal(layout.journal, { ...JOURNAL, step: 'checking', exe: layout.exe });
    const ports = (): ApplyPorts => ({
      clock: { now: () => 5, sleep: () => Promise.resolve() },
      isAlive: () => false,
      startDaemon: () => Promise.resolve({ ok: true }),
      stopDaemon: () => Promise.resolve(),
      probe: () => Promise.resolve('ok'),
      restoreBackup: () => Promise.resolve(),
      sha256: () => Promise.resolve('a'.repeat(64)),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const result = await recoverAtStart({ execPath: layout.exe, ports });
    expect(result).toEqual({ kind: 'finished', outcome: { kind: 'committed' } });
    const reading = await readJournal(layout.journal);
    expect(reading.kind === 'ok' && reading.journal.step).toBe('committed');
  });

  it('is the same call as recoverInterrupted for a final journal: nothing to do', async () => {
    const dir = await temp();
    const layout = layoutOf(join(dir, 'ot'));
    await writeJournal(layout.journal, { ...JOURNAL, step: 'committed', exe: layout.exe });
    expect(await recoverInterrupted(layout, {} as ApplyPorts, false)).toEqual({ kind: 'none' });
  });
});
