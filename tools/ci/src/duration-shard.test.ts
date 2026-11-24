// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { balance, parseTimings, shardMode, timingKey } from './duration-shard.js';
import { mergeTimings, parseVitestLog } from './test-timings.js';

describe('shardMode', () => {
  it('is duration by default and accepts hash', () => {
    expect(shardMode({})).toBe('duration');
    expect(shardMode({ OT_TEST_SHARD_MODE: '' })).toBe('duration');
    expect(shardMode({ OT_TEST_SHARD_MODE: 'duration' })).toBe('duration');
    expect(shardMode({ OT_TEST_SHARD_MODE: 'hash' })).toBe('hash');
  });

  it('refuses another value', () => {
    expect(() => shardMode({ OT_TEST_SHARD_MODE: 'size' })).toThrow(
      'OT_TEST_SHARD_MODE=size: use duration or hash',
    );
  });
});

describe('balance', () => {
  const timings = new Map([
    ['a', 900],
    ['b', 500],
    ['c', 400],
    ['d', 300],
    ['e', 200],
    ['f', 100],
  ]);

  it('puts every key in exactly one shard and evens the time out', () => {
    const shards = balance(['f', 'e', 'd', 'c', 'b', 'a'], timings, 2);
    expect(shards.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const loads = shards.map((keys) => keys.reduce((sum, key) => sum + (timings.get(key) ?? 0), 0));
    expect(loads).toEqual([1200, 1200]);
  });

  it('gives the same shards whatever the order of the keys', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(balance([...keys].reverse(), timings, 3)).toEqual(balance(keys, timings, 3));
  });

  it('weighs a key with no measure as the median, and counts a repeated key once', () => {
    // Median of 900..100 is 350: `new` goes where the load is lowest at that point.
    const shards = balance(['a', 'b', 'new', 'new'], timings, 2);
    expect(shards).toEqual([['a'], ['b', 'new']]);
  });

  it('splits evenly by count when there are no timings', () => {
    const shards = balance(['a', 'b', 'c', 'd', 'e'], new Map(), 2);
    expect(shards.map((keys) => keys.length).sort()).toEqual([2, 3]);
  });

  it('leaves the extra shards empty when there are fewer keys than shards', () => {
    expect(balance(['a'], timings, 3)).toEqual([['a'], [], []]);
  });

  it('refuses a count below 1', () => {
    expect(() => balance(['a'], timings, 0)).toThrow('balance: count 0');
  });
});

describe('parseTimings', () => {
  const text = JSON.stringify({
    version: 1,
    platforms: { linux: { 'x.test.ts': 10, 'bad.test.ts': -1 }, darwin: { 'y.test.ts': 20 } },
  });

  it('reads the durations of the system and drops invalid ones', () => {
    expect([...parseTimings(text, 'darwin')]).toEqual([['y.test.ts', 20]]);
    expect([...parseTimings(text, 'linux')]).toEqual([['x.test.ts', 10]]);
  });

  it('borrows linux for a system with no measures', () => {
    expect([...parseTimings(text, 'win32')]).toEqual([['x.test.ts', 10]]);
  });

  it('refuses another format', () => {
    expect(() => parseTimings('{"version":2}', 'linux')).toThrow('expected { "version": 1');
  });
});

describe('timingKey', () => {
  it('is the path from the root with forward slashes', () => {
    const root = path.resolve('repo');
    expect(timingKey(root, path.join(root, 'packages', 'a', 'x.test.ts'))).toBe(
      'packages/a/x.test.ts',
    );
  });
});

describe('parseVitestLog', () => {
  it('reads the file lines of the reporter, in ms or s, and keeps the longest of a repeat', () => {
    const log = [
      ' ✓  packages  packages/a/src/x.test.ts (12 tests) 1234ms',
      ' ❯  packages  packages/a/src/y.test.tsx (2 tests | 1 failed) 2389ms',
      ' ✓ tools/ci/src/z.test.ts (3 tests) 1.5s',
      '     ✓ a test inside a file 1120ms',
      ' ↓  packages  packages/a/src/skipped.test.ts (4 tests | 4 skipped)',
      ' ✓  packages  packages/a/src/x.test.ts (12 tests) 1000ms',
      ' Test Files  3 passed (3)',
    ].join('\r\n');
    expect(Object.fromEntries(parseVitestLog(log))).toEqual({
      'packages/a/src/x.test.ts': 1234,
      'packages/a/src/y.test.tsx': 2389,
      'tools/ci/src/z.test.ts': 1500,
    });
  });
});

describe('mergeTimings', () => {
  it('replaces the measured files of one system and keeps the rest', () => {
    const previous = {
      version: 1 as const,
      platforms: { linux: { 'a.test.ts': 1, 'b.test.ts': 2 }, darwin: { 'a.test.ts': 3 } },
    };
    const merged = mergeTimings(
      previous,
      'linux',
      new Map([
        ['b.test.ts', 20],
        ['c.test.ts', 30],
      ]),
    );
    expect(merged).toEqual({
      version: 1,
      platforms: {
        darwin: { 'a.test.ts': 3 },
        linux: { 'a.test.ts': 1, 'b.test.ts': 20, 'c.test.ts': 30 },
      },
    });
    expect(previous.platforms.linux['b.test.ts']).toBe(2);
  });

  it('starts a new file', () => {
    expect(mergeTimings(undefined, 'win32', new Map([['a.test.ts', 5]]))).toEqual({
      version: 1,
      platforms: { win32: { 'a.test.ts': 5 } },
    });
  });
});
