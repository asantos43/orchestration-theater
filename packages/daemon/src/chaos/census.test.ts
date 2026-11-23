// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aliveEntries,
  censusPids,
  isAlive,
  pidFileEntries,
  readProc,
  scanProc,
  sessionEntries,
  START_TOLERANCE_MS,
  takeCensus,
} from './census.js';

const linux = process.platform === 'linux';
const run = linux ? describe : describe.skip;

let runDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  runDir = realpathSync(mkdtempSync(join(tmpdir(), 'ot-census-')));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(runDir, { recursive: true, force: true });
});

/** A process of this test (never one of anybody else's) that lives in `cwd` until it is killed. */
function sleeper(cwd: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], {
    cwd,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

async function died(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

function makeStore(rows: readonly (readonly [string, number | null, number | null])[]): string {
  const path = join(runDir, 'store.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, pid INTEGER, process_started_at INTEGER)');
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  for (const row of rows) insert.run(...row);
  db.close();
  return path;
}

run('the census of processes', () => {
  it('readProc reads this process, and nothing of a pid that does not exist', () => {
    const info = readProc(process.pid);
    expect(info).toMatchObject({ pid: process.pid, zombie: false });
    expect(info?.startedAtMs).toBeLessThanOrEqual(Date.now());
    expect(readProc(2 ** 22 + 12_345)).toBeUndefined();
    expect(isAlive(process.pid)).toBe(true);
  });

  it('finds the sessions with a pid and their start instant', () => {
    const path = makeStore([
      ['s1', 4_000_001, 1_700_000_000_000],
      ['s2', null, null],
      ['s3', 4_000_002, null],
    ]);
    expect(sessionEntries(path)).toEqual([
      { pid: 4_000_001, source: 'sessions', startedAtMs: 1_700_000_000_000, detail: 'session s1' },
      { pid: 4_000_002, source: 'sessions', detail: 'session s3' },
    ]);
    expect(sessionEntries(join(runDir, 'absent.sqlite'))).toEqual([]);
  });

  it('reads the pid files, one pid per line, ignoring other files and bad lines', () => {
    const dir = join(runDir, 'state', 'pids');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-1.pid'), '1234\n\nnot-a-number\n-5\n');
    writeFileSync(join(dir, 'agent-2.pid'), '5678');
    writeFileSync(join(dir, 'notes.txt'), '9999');
    const entries = pidFileEntries(join(runDir, 'state'));
    expect(entries.map((entry) => entry.pid).sort()).toEqual([1234, 5678]);
    expect(entries.every((entry) => entry.source === 'pid-file')).toBe(true);
    expect(pidFileEntries(join(runDir, 'nowhere'))).toEqual([]);
  });

  it('scans /proc for the unique directory of the run, by working directory', async () => {
    const child = sleeper(runDir);
    const outsider = sleeper(tmpdir());
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pids = scanProc(runDir).map((entry) => entry.pid);
    expect(pids).toContain(child.pid);
    expect(pids).not.toContain(outsider.pid);
    expect(scanProc(runDir, new Set([child.pid ?? 0])).map((entry) => entry.pid)).not.toContain(
      child.pid,
    );
  });

  it('a census joins the three sources, leaves out the test process, and sees a death', async () => {
    const child = sleeper(runDir);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pid = child.pid ?? 0;
    const store = makeStore([['s1', pid, readProc(pid)?.startedAtMs ?? null]]);
    const dir = join(runDir, 'state', 'pids');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'one.pid'), `${String(pid)}\n${String(process.pid)}\n`);
    const census = takeCensus({ runDir, stateDir: join(runDir, 'state'), storePath: store });
    expect(new Set(census.entries.map((entry) => entry.source))).toEqual(
      new Set(['sessions', 'pid-file', 'proc']),
    );
    expect(censusPids(census)).toEqual([pid]);
    expect(aliveEntries(census).length).toBeGreaterThan(0);
    child.kill('SIGKILL');
    await died(child);
    expect(aliveEntries(census)).toEqual([]);
  });

  it('a session entry whose start instant differs is a recycled pid, not ours', async () => {
    const child = sleeper(runDir);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pid = child.pid ?? 0;
    const real = readProc(pid)?.startedAtMs ?? 0;
    const entry = (startedAtMs: number) => ({
      entries: [{ pid, source: 'sessions' as const, startedAtMs, detail: 's' }],
    });
    expect(aliveEntries(entry(real))).toHaveLength(1);
    expect(aliveEntries(entry(real + START_TOLERANCE_MS - 1))).toHaveLength(1);
    expect(aliveEntries(entry(real + START_TOLERANCE_MS + 60_000))).toHaveLength(0);
  });
});
