// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  parseMemAvailableMb,
  parseSmapsRollupKb,
  PosixMemoryProbe,
  POSIX_MEMORY_PROBE_ADAPTER,
} from './memory-probe.js';
import type { ProcessInfo } from './process-table.js';

const meminfo = (kb: number): string =>
  `MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:   ${String(kb)} kB\nBuffers:           10 kB\n`;

const row = (pid: number, ppid: number, zombie = false): ProcessInfo => ({
  pid,
  ppid,
  pgid: pid,
  zombie,
  start: '1',
});

const smaps = (pssKb: number): string =>
  `Rss:  ${String(pssKb * 2)} kB\nPss:  ${String(pssKb)} kB\n`;

describe('parseMemAvailableMb', () => {
  it('reads MemAvailable in MB, rounded down', () => {
    expect(parseMemAvailableMb(meminfo(2_097_151))).toBe(2047);
    expect(parseMemAvailableMb(meminfo(2_097_152))).toBe(2048);
  });

  it('is undefined when the line is missing', () => {
    expect(parseMemAvailableMb('MemTotal: 1 kB\n')).toBeUndefined();
    expect(parseMemAvailableMb('')).toBeUndefined();
  });
});

describe('parseSmapsRollupKb', () => {
  it('prefers Pss, falls back to Rss', () => {
    expect(parseSmapsRollupKb('Rss: 200 kB\nPss: 90 kB\n')).toBe(90);
    expect(parseSmapsRollupKb('Rss: 200 kB\n')).toBe(200);
    expect(parseSmapsRollupKb('nothing')).toBeUndefined();
  });
});

describe('PosixMemoryProbe', () => {
  it('declares the port it implements', () => {
    expect(new PosixMemoryProbe().implements).toEqual(POSIX_MEMORY_PROBE_ADAPTER.implements);
    expect(POSIX_MEMORY_PROBE_ADAPTER.implements.port).toBe('MemoryProbe');
  });

  it('reads MemAvailable on Linux and never rejects when the file is unreadable', async () => {
    const ok = new PosixMemoryProbe({
      platform: 'linux',
      readText: (path) => {
        expect(path).toBe('/proc/meminfo');
        return Promise.resolve(meminfo(4_194_304));
      },
    });
    expect(await ok.availableMb()).toBe(4096);
    const broken = new PosixMemoryProbe({
      platform: 'linux',
      readText: () => Promise.reject(new Error('EACCES')),
    });
    expect(await broken.availableMb()).toBeUndefined();
  });

  it('uses os.freemem where there is no /proc', async () => {
    const probe = new PosixMemoryProbe({
      platform: 'darwin',
      freemem: () => 3 * 1024 * 1024 * 1024,
    });
    expect(await probe.availableMb()).toBe(3072);
    expect(await probe.treeMb(1)).toBeUndefined();
  });

  it('sums the Pss of the process and its descendants only', async () => {
    const files = new Map([
      ['/proc/10/smaps_rollup', smaps(100 * 1024)],
      ['/proc/11/smaps_rollup', smaps(50 * 1024)],
      ['/proc/12/smaps_rollup', smaps(25 * 1024)],
      ['/proc/99/smaps_rollup', smaps(999 * 1024)],
    ]);
    const probe = new PosixMemoryProbe({
      platform: 'linux',
      table: () =>
        Promise.resolve(
          new Map([
            [10, row(10, 1)],
            [11, row(11, 10)],
            [12, row(12, 11)],
            [13, row(13, 10, true)], // zombie: ignored
            [99, row(99, 1)], // not below 10
          ]),
        ),
      readText: (path) => {
        const text = files.get(path);
        return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
      },
    });
    expect(await probe.treeMb(10)).toBe(175);
    expect(await probe.treeMb(12)).toBe(25);
  });

  it('is undefined for a pid that is not there or a tree nobody can read', async () => {
    const probe = new PosixMemoryProbe({
      platform: 'linux',
      table: () => Promise.resolve(new Map([[10, row(10, 1)]])),
      readText: () => Promise.reject(new Error('EACCES')),
    });
    expect(await probe.treeMb(404)).toBeUndefined();
    expect(await probe.treeMb(10)).toBeUndefined();
  });
});
