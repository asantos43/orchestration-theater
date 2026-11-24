// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { markerFromEnviron, markerFromPsLine, scanMarked } from './marker-scan.js';
import type { ProcessInfo, ProcessSnapshot } from './process-table.js';

describe('markerFromEnviron', () => {
  it('reads the marker out of a NUL separated environment block', () => {
    expect(markerFromEnviron('PATH=/usr/bin\0OT_LAUNCH_ID=proc-123\0HOME=/x\0')).toBe('proc-123');
  });

  it('is undefined without the variable, or with it empty, or for a longer name that ends the same', () => {
    expect(markerFromEnviron('PATH=/usr/bin\0')).toBeUndefined();
    expect(markerFromEnviron('OT_LAUNCH_ID=\0')).toBeUndefined();
    expect(markerFromEnviron('XOT_LAUNCH_ID=nope\0')).toBeUndefined();
    expect(markerFromEnviron('')).toBeUndefined();
  });
});

describe('markerFromPsLine', () => {
  it('reads the marker from the environment that `ps -E` prints after the command', () => {
    expect(
      markerFromPsLine('  4242 /bin/agent --flag PATH=/usr/bin OT_LAUNCH_ID=proc-9 HOME=/x'),
    ).toEqual({
      pid: 4242,
      marker: 'proc-9',
    });
  });

  it('is undefined for a line without the marker, an empty one, or noise', () => {
    expect(markerFromPsLine('4242 /bin/agent PATH=/usr/bin')).toBeUndefined();
    expect(markerFromPsLine('4242 /bin/agent OT_LAUNCH_ID=')).toBeUndefined();
    expect(markerFromPsLine('')).toBeUndefined();
    expect(markerFromPsLine('not a line')).toBeUndefined();
  });
});

describe('scanMarked', () => {
  const info = (pid: number, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
    pid,
    ppid: 1,
    pgid: pid,
    zombie: false,
    start: String(pid),
    startedAtMs: pid * 1000,
    ...extra,
  });
  const withoutStart = (pid: number): ProcessInfo => {
    const full = info(pid);
    return {
      pid: full.pid,
      ppid: full.ppid,
      pgid: full.pgid,
      zombie: full.zombie,
      start: full.start,
    };
  };

  it('returns the live processes that carry a marker, with their start instant', async () => {
    const table: ProcessSnapshot = new Map([
      [1, info(1)],
      [2, info(2)],
      [3, info(3, { zombie: true })],
      [4, withoutStart(4)],
    ]);
    const asked: number[][] = [];
    const found = await scanMarked(table, (pids) => {
      asked.push([...pids]);
      return Promise.resolve(
        new Map([
          [2, 'row-2'],
          [3, 'row-3'],
          [4, 'row-4'],
        ]),
      );
    });
    // Zombies and processes without a start instant are never asked about, nor returned.
    expect(asked).toEqual([[1, 2]]);
    expect(found).toEqual([{ marker: 'row-2', pid: 2, startedAt: 2000 }]);
  });
});
