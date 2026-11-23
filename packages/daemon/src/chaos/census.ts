// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11, P1): test only, excluded from the build of the package.
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The census of processes (docs/23, "O censo de processos"). Before the daemon is killed, and after
 * the reconciliation, the harness lists every process that belongs to the run and asks whether it
 * is still alive. Three sources, because each one alone misses processes:
 * 1. the `sessions` rows (pid and start instant, written by the tracking launcher): found by
 *    `kill(pid, 0)` AND by the start instant, so a pid the system reused is not taken for ours;
 * 2. the pids the harness and the fake agent write in `<state dir>/pids/*.pid`, one per line;
 * 3. a scan of `/proc` for any process whose command line, working directory or environment holds
 *    the unique directory of the run. The directory is new for every run, so nothing else matches,
 *    and the scan reads `/proc` itself (never `pgrep -f` with a pattern of its own command). It is
 *    what finds a grandchild that left the process group.
 *
 * Linux only: `/proc` is the table. On other systems the census is empty, and the chaos tests that
 * need it are skipped there (docs/23: "Linux como único sistema do nível automático").
 */

/** The folder of the state directory where processes write their pid (`<pid>\n` per file). */
export const PID_DIR_NAME = 'pids';

/** How far two readings of one process start may differ and still be the same process. */
export const START_TOLERANCE_MS = 2000;

/** Clock ticks per second of the times in `/proc/<pid>/stat`: 100 on every Linux in use. */
const CLOCK_TICKS_PER_SECOND = 100;

export type CensusSource = 'sessions' | 'pid-file' | 'proc';

export interface CensusEntry {
  readonly pid: number;
  readonly source: CensusSource;
  /** Start instant (epoch ms) recorded by the source, when it has one: only `sessions` does. */
  readonly startedAtMs?: number | undefined;
  /** What found it: the session id, the pid file, or what the scan matched. */
  readonly detail: string;
}

export interface ProcInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly zombie: boolean;
  readonly startedAtMs?: number | undefined;
}

function bootTimeMs(): number | undefined {
  try {
    const match = /^btime\s+(\d+)\s*$/m.exec(readFileSync('/proc/stat', 'utf8'));
    return match?.[1] === undefined ? undefined : Number(match[1]) * 1000;
  } catch {
    return undefined;
  }
}

/** Reads `/proc/<pid>/stat`. `undefined` when the process is not there. */
export function readProc(
  pid: number,
  boot: number | undefined = bootTimeMs(),
): ProcInfo | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  // The command name sits between parentheses and may hold both: count the fields after the last.
  const end = text.lastIndexOf(')');
  if (end < 0) return undefined;
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const ticks = Number(fields[19]);
  if (state === undefined || !Number.isInteger(ppid)) return undefined;
  return {
    pid,
    ppid,
    zombie: state === 'Z' || state === 'X',
    ...(boot !== undefined && Number.isFinite(ticks)
      ? { startedAtMs: Math.round(boot + (ticks * 1000) / CLOCK_TICKS_PER_SECOND) }
      : {}),
  };
}

/** Whether the process is there and running (a zombie waiting for its parent is not alive). */
export function isAlive(pid: number): boolean {
  const info = readProc(pid);
  return info !== undefined && !info.zombie;
}

/** `sessions` rows with a pid: every one of them is a client the dead daemon may have left. */
export function sessionEntries(storePath: string): CensusEntry[] {
  if (!existsSync(storePath)) return [];
  const db = new DatabaseSync(storePath);
  try {
    db.exec('PRAGMA query_only = ON');
    const rows = db
      .prepare('SELECT id, pid, process_started_at FROM sessions WHERE pid IS NOT NULL')
      .all() as { id: string; pid: number; process_started_at: number | null }[];
    return rows.map((row) => ({
      pid: row.pid,
      source: 'sessions',
      ...(row.process_started_at === null ? {} : { startedAtMs: row.process_started_at }),
      detail: `session ${row.id}`,
    }));
  } finally {
    db.close();
  }
}

/** The pids written in `<state dir>/pids/*.pid`. */
export function pidFileEntries(stateDir: string): CensusEntry[] {
  const dir = join(stateDir, PID_DIR_NAME);
  if (!existsSync(dir)) return [];
  const entries: CensusEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.pid')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      const pid = Number(line.trim());
      if (line.trim() !== '' && Number.isInteger(pid) && pid > 0) {
        entries.push({ pid, source: 'pid-file', detail: `${PID_DIR_NAME}/${name}` });
      }
    }
  }
  return entries;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Every process of `/proc` whose command line, working directory or environment holds `runDir`
 * (the unique folder of the run). `exclude` leaves out the pids that are not part of the answer,
 * such as the test process itself.
 */
export function scanProc(runDir: string, exclude: ReadonlySet<number> = new Set()): CensusEntry[] {
  if (!existsSync('/proc/self')) return [];
  const found: CensusEntry[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (exclude.has(pid)) continue;
    const base = `/proc/${name}`;
    let where: string | undefined;
    if (readText(`${base}/cmdline`).includes(runDir)) where = 'command line';
    else {
      try {
        // `cwd` is a link: a process that is gone, or not ours to read, makes the call fail.
        if (readlinkSync(`${base}/cwd`).startsWith(runDir)) where = 'working directory';
      } catch {
        // Skipped.
      }
      if (where === undefined && readText(`${base}/environ`).includes(runDir))
        where = 'environment';
    }
    if (where !== undefined) found.push({ pid, source: 'proc', detail: where });
  }
  return found;
}

export interface Census {
  readonly entries: readonly CensusEntry[];
}

export interface CensusInput {
  /** The unique folder of the run (every file of the run is inside it). */
  readonly runDir: string;
  readonly stateDir: string;
  /** `<data dir>/store.sqlite`. */
  readonly storePath: string;
  /** Pids that are not part of the census (the test process; the daemon the test itself started and wants to leave out). */
  readonly exclude?: readonly number[];
}

/** Lists the processes of the run, from the three sources. A pid found by two sources appears twice. */
export function takeCensus(input: CensusInput): Census {
  const exclude = new Set([process.pid, ...(input.exclude ?? [])]);
  const entries = [
    ...sessionEntries(input.storePath),
    ...pidFileEntries(input.stateDir),
    ...scanProc(input.runDir, exclude),
  ].filter((entry) => !exclude.has(entry.pid));
  return { entries };
}

/**
 * The entries of the census whose process is alive now. A `sessions` entry counts only if the
 * process started at the recorded instant (a reused pid is another process); the other two have
 * no instant and count while the pid is alive.
 */
export function aliveEntries(census: Census): CensusEntry[] {
  const boot = bootTimeMs();
  return census.entries.filter((entry) => {
    const info = readProc(entry.pid, boot);
    if (info === undefined || info.zombie) return false;
    if (entry.startedAtMs === undefined || info.startedAtMs === undefined) return true;
    return Math.abs(info.startedAtMs - entry.startedAtMs) <= START_TOLERANCE_MS;
  });
}

/** What a process is running, for a message (`/proc/<pid>/cmdline`, cut short); empty if it is gone. */
export function commandOf(pid: number, max = 200): string {
  const text = readText(`/proc/${String(pid)}/cmdline`)
    .split('\0')
    .join(' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** The distinct pids of the census. */
export function censusPids(census: Census): number[] {
  return [...new Set(census.entries.map((entry) => entry.pid))];
}
