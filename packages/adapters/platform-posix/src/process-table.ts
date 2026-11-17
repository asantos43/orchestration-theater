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
  /**
   * The same instant as epoch milliseconds, when the table can tell (what the reconciliation of a
   * restart compares with the instant it recorded). Linux derives it from the boot time, so it is
   * good to a second or so: callers compare with a tolerance ({@link START_TOLERANCE_MS}).
   */
  readonly startedAtMs?: number;
}

/** [proposta] How far two readings of one process start may differ and still be the same process. */
export const START_TOLERANCE_MS = 2000;

/** [proposta] Clock ticks per second of `/proc/<pid>/stat` times; 100 on every Linux in use. */
const CLOCK_TICKS_PER_SECOND = 100;

/** A snapshot of every process the user can see, keyed by pid. */
export type ProcessSnapshot = ReadonlyMap<number, ProcessInfo>;

/** Reads the whole process table. Never rejects: an unreadable table is an empty one. */
export type ProcessTable = () => Promise<ProcessSnapshot>;

/**
 * Parses `/proc/<pid>/stat`. The command name sits between parentheses and may hold spaces and
 * parentheses itself, so the fields are counted after the LAST `)`: state, ppid, pgrp, ...,
 * starttime (the 20th field after the command; proc(5), fields 3, 4, 5 and 22).
 */
export function parseProcStat(
  pid: number,
  text: string,
  bootTimeMs?: number,
): ProcessInfo | undefined {
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
  const ticks = Number(start);
  const startedAtMs =
    bootTimeMs !== undefined && Number.isFinite(ticks)
      ? Math.round(bootTimeMs + (ticks * 1000) / CLOCK_TICKS_PER_SECOND)
      : undefined;
  return {
    pid,
    ppid,
    pgid,
    zombie: state === 'Z' || state === 'X',
    start,
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
  };
}

/** The boot time of the machine in epoch ms (`btime` of `/proc/stat`), or `undefined`. */
export function parseBootTime(text: string): number | undefined {
  const match = /^btime\s+(\d+)\s*$/m.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1000;
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
    const startedAtMs = Date.parse(start);
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      zombie: stat.startsWith('Z'),
      start,
      ...(Number.isNaN(startedAtMs) ? {} : { startedAtMs }),
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
    const bootTimeMs = parseBootTime(await readFile(`${procDir}/stat`, 'utf8').catch(() => ''));
    const rows = await Promise.all(
      names
        .filter((name) => /^\d+$/.test(name))
        .map(async (name) => {
          try {
            return parseProcStat(
              Number(name),
              await readFile(`${procDir}/${name}/stat`, 'utf8'),
              bootTimeMs,
            );
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
