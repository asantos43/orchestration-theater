// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { platform } from 'node:process';

/** One row of the process table: what the kill fallback needs to walk a tree (architecture 5.9). */
export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  /** Process group id. A launched root is its own group leader, so its `pgid` is its `pid`. */
  readonly pgid: number;
  /** The process ended and only waits to be reaped; it counts as dead. */
  readonly zombie: boolean;
  /**
   * Start time, opaque but stable for the life of the process. Together with `pid` it identifies
   * a process, so a recycled pid is never mistaken for the one that was seen before.
   */
  readonly start: string;
}

/** A snapshot of every process the user can see, keyed by pid. */
export type ProcessSnapshot = ReadonlyMap<number, ProcessInfo>;

/** Reads the whole process table. Never rejects: an unreadable table is an empty one. */
export type ProcessTable = () => Promise<ProcessSnapshot>;

/**
 * Parses `/proc/<pid>/stat`. The command name sits between parentheses and may hold spaces and
 * parentheses itself, so the fields are counted after the LAST `)`: state, ppid, pgrp, ...,
 * starttime (the 20th field after the command; proc(5), fields 3, 4, 5 and 22).
 */
export function parseProcStat(pid: number, text: string): ProcessInfo | undefined {
  const end = text.lastIndexOf(')');
  if (end < 0) return undefined;
  const fields = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const start = fields[19];
  if (state === undefined || start === undefined || !Number.isInteger(ppid)) return undefined;
  if (!Number.isInteger(pgid)) return undefined;
  return { pid, ppid, pgid, zombie: state === 'Z' || state === 'X', start };
}

/**
 * Parses `ps -A -o pid=,ppid=,pgid=,stat=,lstart=` (macOS and other BSD-like systems). `lstart`
 * is a fixed-width date with spaces, so it is the rest of the line.
 */
export function parsePsOutput(text: string): ProcessSnapshot {
  const table = new Map<number, ProcessInfo>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pgid, stat, start] = match;
    if (pid === undefined || ppid === undefined || pgid === undefined) continue;
    if (stat === undefined || start === undefined) continue;
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      zombie: stat.startsWith('Z'),
      start,
    });
  }
  return table;
}

/** Linux: one `readFile` per `/proc/<pid>/stat`. A process that ends mid-scan is just skipped. */
export function procFsTable(procDir = '/proc'): ProcessTable {
  return async () => {
    let names: string[];
    try {
      names = await readdir(procDir);
    } catch {
      return new Map();
    }
    const rows = await Promise.all(
      names
        .filter((name) => /^\d+$/.test(name))
        .map(async (name) => {
          try {
            return parseProcStat(Number(name), await readFile(`${procDir}/${name}/stat`, 'utf8'));
          } catch {
            return undefined;
          }
        }),
    );
    const table = new Map<number, ProcessInfo>();
    for (const row of rows) if (row !== undefined) table.set(row.pid, row);
    return table;
  };
}

/** macOS (and anything else with a BSD `ps`): one `ps` call. */
export function psTable(): ProcessTable {
  return () =>
    new Promise((resolve) => {
      execFile(
        'ps',
        ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
        // `LC_ALL=C` fixes the `lstart` format; the rest of the environment is not needed.
        { env: { LC_ALL: 'C', PATH: '/bin:/usr/bin' }, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          resolve(error === null ? parsePsOutput(stdout) : new Map());
        },
      );
    });
}

/** The table reader for this operating system: `/proc` on Linux, `ps` elsewhere. */
export function systemProcessTable(): ProcessTable {
  return platform === 'linux' ? procFsTable() : psTable();
}
