// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { platform } from 'node:process';
import {
  MEMORY_PROBE_PORT_VERSION,
  type Adapter,
  type AdapterImplements,
  type MemoryProbe,
} from '@otheater/core';
import { systemProcessTable, type ProcessTable } from './process-table.js';

/** Identity of the posix memory probe (architecture 5.18, "Versão dos contratos"). */
export const POSIX_MEMORY_PROBE_ADAPTER: Adapter = {
  id: 'posix',
  implements: { port: 'MemoryProbe', range: `^${MEMORY_PROBE_PORT_VERSION}` },
};

const KB_PER_MB = 1024;

/** `MemAvailable` of `/proc/meminfo`, in MB rounded down; `undefined` when the line is missing. */
export function parseMemAvailableMb(text: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text);
  return match?.[1] === undefined ? undefined : Math.floor(Number(match[1]) / KB_PER_MB);
}

/**
 * The share of a process in `/proc/<pid>/smaps_rollup`, in kB: `Pss` (the proportional share, so a
 * page two processes map counts half in each), or else `Rss`. `undefined` when neither is there.
 */
export function parseSmapsRollupKb(text: string): number | undefined {
  for (const name of ['Pss', 'Rss']) {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

/** What the probe reads from the system; tests hand in their own. */
export interface PosixMemoryProbeDeps {
  /** Reads a text file; rejects when it cannot. Default: `fs.readFile` as utf8. */
  readonly readText?: (path: string) => Promise<string>;
  /** The operating system the probe works for. Default: `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Free memory in bytes where `/proc` is not there (macOS, Windows). Default: `os.freemem`. */
  readonly freemem?: () => number;
  /** The process table `treeMb` walks. Default: the one of the system. */
  readonly table?: ProcessTable;
}

/**
 * The `MemoryProbe` for Linux, macOS and anything with `os.freemem` (architecture 5.9).
 *
 * - Linux: `MemAvailable` of `/proc/meminfo` [V]: the memory a new process can take without
 *   swapping, which counts the reclaimable page cache as free.
 * - Elsewhere: `os.freemem()`. [N] On macOS that figure leaves out the cache that could be
 *   reclaimed, so it is lower than the real headroom; the probe errs on the side of waiting.
 * - `treeMb` (Linux only): the sum of `Pss` of `/proc/<pid>/smaps_rollup` over the process and its
 *   descendants. A process the user cannot read is skipped; a tree with no readable process is
 *   `undefined`.
 */
export class PosixMemoryProbe implements MemoryProbe {
  readonly id = POSIX_MEMORY_PROBE_ADAPTER.id;
  readonly implements: AdapterImplements = POSIX_MEMORY_PROBE_ADAPTER.implements;
  readonly #readText: (path: string) => Promise<string>;
  readonly #platform: NodeJS.Platform;
  readonly #freemem: () => number;
  readonly #table: ProcessTable;

  constructor(deps: PosixMemoryProbeDeps = {}) {
    this.#readText = deps.readText ?? ((path) => readFile(path, 'utf8'));
    this.#platform = deps.platform ?? platform;
    this.#freemem = deps.freemem ?? freemem;
    this.#table = deps.table ?? systemProcessTable();
  }

  async availableMb(): Promise<number | undefined> {
    if (this.#platform === 'linux') {
      try {
        return parseMemAvailableMb(await this.#readText('/proc/meminfo'));
      } catch {
        return undefined;
      }
    }
    try {
      const bytes = this.#freemem();
      return Number.isFinite(bytes) ? Math.floor(bytes / (KB_PER_MB * KB_PER_MB)) : undefined;
    } catch {
      return undefined;
    }
  }

  async treeMb(pid: number): Promise<number | undefined> {
    if (this.#platform !== 'linux') return undefined;
    const table = await this.#table();
    if (!table.has(pid)) return undefined;
    const children = new Map<number, number[]>();
    for (const info of table.values()) {
      if (info.zombie) continue;
      const list = children.get(info.ppid) ?? [];
      list.push(info.pid);
      children.set(info.ppid, list);
    }
    const tree: number[] = [];
    const seen = new Set<number>();
    const queue = [pid];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (seen.has(next)) continue;
      seen.add(next);
      tree.push(next);
      queue.push(...(children.get(next) ?? []));
    }
    const parts = await Promise.all(
      tree.map(async (member) => {
        try {
          return parseSmapsRollupKb(await this.#readText(`/proc/${String(member)}/smaps_rollup`));
        } catch {
          return undefined;
        }
      }),
    );
    const readable = parts.filter((part): part is number => part !== undefined);
    if (readable.length === 0) return undefined;
    return Math.round(readable.reduce((sum, kb) => sum + kb, 0) / KB_PER_MB);
  }
}
