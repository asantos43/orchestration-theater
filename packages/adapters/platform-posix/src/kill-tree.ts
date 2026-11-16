// SPDX-License-Identifier: MPL-2.0
import type { KillReport } from '@otheater/core';
import type { ProcessInfo, ProcessSnapshot, ProcessTable } from './process-table.js';

/** How often the tree is looked at while it dies. */
export const POLL_MS = 25;
/** [proposta] Longest wait for the tree to vanish after SIGKILL; what is left is reported. */
export const KILL_SETTLE_MS = 2000;

/** The tree to end: the root and the process group it leads (architecture 5.9). */
export interface KillTarget {
  readonly rootPid: number;
  /** Start time of the root as the process table reports it; `undefined` if it was not read. */
  readonly rootStart: string | undefined;
}

/** Everything `killProcessTree` needs from the outside, so tests can stand in for the system. */
export interface KillDeps {
  readonly table: ProcessTable;
  /** Sends `signal` to a pid, or to the whole group of that id when `group` is true. */
  readonly signal: (pid: number, signal: NodeJS.Signals, group: boolean) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/**
 * Sends a signal and swallows the two errors that only mean "nothing to signal": the process or
 * group is gone (`ESRCH`) or is not ours (`EPERM`). Refuses pids that would hit the caller or
 * init: `0`, `1` and negatives make `kill(2)` reach whole groups or the whole system.
 */
export function sendSignal(pid: number, signal: NodeJS.Signals, group: boolean): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

/**
 * Ends a process tree in two layers (architecture 5.9, "Fallback de kill"):
 *
 * 1. The process group of the root: one `kill(-pgid)` reaches every descendant that stayed in it.
 * 2. The descendants found in the process table: a grandchild that called `setsid` (or was
 *    spawned `detached`) leaves the group, but its parent chain still leads to the root, so the
 *    table walk finds it. The walk runs again on every poll, to catch what the tree forks while
 *    it dies.
 *
 * The polite signal (SIGTERM) goes first; whatever is still alive after `graceMs` gets SIGKILL,
 * repeated until the tree is gone or {@link KILL_SETTLE_MS} passes. Pids are always checked
 * together with their start time, so a recycled pid is never signalled.
 *
 * Limit [N]: a descendant that escaped the group AND whose every ancestor already died before the
 * walk has no link to the root any more (it was adopted by init); nothing here can find it.
 */
export async function killProcessTree(
  target: KillTarget,
  graceMs: number,
  deps: KillDeps,
): Promise<KillReport> {
  const { rootPid } = target;
  const known = new Map<number, string>();

  /** Adds the group members and the descendants of known pids; returns the pids that are new. */
  const absorb = (table: ProcessSnapshot): ProcessInfo[] => {
    const added: ProcessInfo[] = [];
    const take = (info: ProcessInfo): void => {
      if (info.zombie || known.has(info.pid)) return;
      known.set(info.pid, info.start);
      added.push(info);
    };
    for (const info of table.values()) {
      const isRoot = info.pid === rootPid;
      if (isRoot && target.rootStart !== undefined && info.start !== target.rootStart) continue;
      if (isRoot || (info.pgid === rootPid && info.pid !== rootPid)) take(info);
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const info of table.values()) {
        if (known.has(info.pid) || info.zombie) continue;
        const parent = table.get(info.ppid);
        if (parent !== undefined && known.get(parent.pid) === parent.start) {
          take(info);
          grew = true;
        }
      }
    }
    return added;
  };

  const alive = (table: ProcessSnapshot): ProcessInfo[] => {
    const rows: ProcessInfo[] = [];
    for (const [pid, start] of known) {
      const info = table.get(pid);
      if (info?.start === start && !info.zombie) rows.push(info);
    }
    return rows;
  };

  /** One signal to the group (if any live member is in it) and one to each member outside it. */
  const signalAll = (signal: NodeJS.Signals, rows: readonly ProcessInfo[]): void => {
    if (rows.some((info) => info.pgid === rootPid)) deps.signal(rootPid, signal, true);
    for (const info of rows) if (info.pgid !== rootPid) deps.signal(info.pid, signal, false);
  };

  let table = await deps.table();
  absorb(table);
  const found = known.size;
  if (found === 0) return { found: 0, forced: false, remaining: [] };

  signalAll('SIGTERM', alive(table));

  let forced = false;
  table = await deps.table();
  const graceEnd = deps.now() + graceMs;
  while (alive(table).length > 0) {
    if (deps.now() >= graceEnd) {
      forced = true;
      break;
    }
    await deps.sleep(Math.min(POLL_MS, Math.max(0, graceEnd - deps.now())));
    table = await deps.table();
    // Forked while dying: the newcomers get the polite signal too.
    signalAll('SIGTERM', absorb(table));
  }

  if (forced) {
    const settleEnd = deps.now() + KILL_SETTLE_MS;
    for (;;) {
      absorb(table);
      const rows = alive(table);
      if (rows.length === 0 || deps.now() >= settleEnd) break;
      signalAll('SIGKILL', rows);
      await deps.sleep(POLL_MS);
      table = await deps.table();
    }
  }

  return { found, forced, remaining: alive(table).map((info) => info.pid) };
}
