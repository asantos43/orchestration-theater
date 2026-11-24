// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:process';
import { LAUNCH_MARKER_ENV, type MarkedProcess } from '@otheater/core';
import type { ProcessSnapshot } from './process-table.js';

/** The launch marker of every live process that has one: pid to marker. */
export type MarkerSource = (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>;

const MARKER_PREFIX = `${LAUNCH_MARKER_ENV}=`;

/** The marker in the environment block of `/proc/<pid>/environ` (entries are separated by NUL). */
export function markerFromEnviron(text: string): string | undefined {
  for (const entry of text.split('\0')) {
    if (entry.startsWith(MARKER_PREFIX) && entry.length > MARKER_PREFIX.length) {
      return entry.slice(MARKER_PREFIX.length);
    }
  }
  return undefined;
}

/**
 * The marker in a line of `ps -E -ww -o pid=,command=` (macOS): the environment follows the
 * command, separated by spaces, so the marker is the word that starts with the variable name.
 * A marker never holds a space (the daemon makes it from a row id).
 */
export function markerFromPsLine(line: string): { pid: number; marker: string } | undefined {
  const match = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const word = match[2].split(/\s+/).find((candidate) => candidate.startsWith(MARKER_PREFIX));
  if (word === undefined || word.length === MARKER_PREFIX.length) return undefined;
  return { pid: Number(match[1]), marker: word.slice(MARKER_PREFIX.length) };
}

/** Linux: one read of `/proc/<pid>/environ` per process. What the user cannot read or what ended is skipped. */
export function procFsMarkers(procDir = '/proc'): MarkerSource {
  return async (pids) => {
    const found = new Map<number, string>();
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const marker = markerFromEnviron(
            await readFile(`${procDir}/${String(pid)}/environ`, 'utf8'),
          );
          if (marker !== undefined) found.set(pid, marker);
        } catch {
          // Gone in the meantime, or not ours to read.
        }
      }),
    );
    return found;
  };
}

/** macOS [N: not run on a Mac]: one `ps -E` call; it shows the environment of the processes of the user only. */
export function psMarkers(): MarkerSource {
  return () =>
    new Promise((resolve) => {
      execFile(
        'ps',
        ['-A', '-E', '-ww', '-o', 'pid=,command='],
        { env: { LC_ALL: 'C', PATH: '/bin:/usr/bin' }, maxBuffer: 256 * 1024 * 1024 },
        (error, stdout) => {
          const found = new Map<number, string>();
          if (error === null) {
            for (const line of stdout.split('\n')) {
              const parsed = markerFromPsLine(line);
              if (parsed !== undefined) found.set(parsed.pid, parsed.marker);
            }
          }
          resolve(found);
        },
      );
    });
}

/** The marker reader for this operating system. */
export function systemMarkerSource(): MarkerSource {
  return platform === 'linux' ? procFsMarkers() : psMarkers();
}

/** The processes of `table` (zombies and processes without a start instant left out) that carry a marker. */
export async function scanMarked(
  table: ProcessSnapshot,
  source: MarkerSource,
): Promise<MarkedProcess[]> {
  const candidates = [...table.values()].filter(
    (info) => !info.zombie && info.startedAtMs !== undefined,
  );
  const markers = await source(candidates.map((info) => info.pid));
  const marked: MarkedProcess[] = [];
  for (const info of candidates) {
    const marker = markers.get(info.pid);
    if (marker !== undefined && info.startedAtMs !== undefined) {
      marked.push({ marker, pid: info.pid, startedAt: info.startedAtMs });
    }
  }
  return marked;
}
