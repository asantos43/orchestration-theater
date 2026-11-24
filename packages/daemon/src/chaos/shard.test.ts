// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { chaosShard, ChaosSlicer } from './harness.js';

describe('chaosShard', () => {
  it('is the whole file when OT_CHAOS_SHARD is unset or empty', () => {
    expect(chaosShard({})).toEqual({ index: 1, count: 1 });
    expect(chaosShard({ OT_CHAOS_SHARD: '' })).toEqual({ index: 1, count: 1 });
  });

  it('reads <index>/<count>', () => {
    expect(chaosShard({ OT_CHAOS_SHARD: '3/6' })).toEqual({ index: 3, count: 6 });
  });

  it.each(['0/4', '5/4', '1/0', 'x', '2', '1/2/3', '-1/2', '1.5/2'])('throws on %s', (raw) => {
    expect(() => chaosShard({ OT_CHAOS_SHARD: raw })).toThrow(/OT_CHAOS_SHARD/);
  });
});

describe('ChaosSlicer', () => {
  it('splits the cases of every group across the shards, each case in exactly one shard', () => {
    const groups: (readonly unknown[])[] = [
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      Array.from({ length: 50 }, (_, i) => i),
    ];
    const count = 6;
    const seen: unknown[][] = groups.map(() => []);
    const sizes: number[] = [];
    for (let index = 1; index <= count; index += 1) {
      const slicer = new ChaosSlicer({ index, count });
      let size = 0;
      groups.forEach((group, g) => {
        const part = slicer.take(group);
        seen[g]?.push(...part);
        size += part.length;
      });
      if (slicer.has()) size += 1;
      sizes.push(size);
    }
    groups.forEach((group, g) => {
      expect([...(seen[g] ?? [])].sort()).toEqual([...group].sort());
    });
    // 58 cases over 6 shards: 9 or 10 each.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(58);
  });

  it('keeps every case when the shard is 1/1', () => {
    const slicer = new ChaosSlicer({ index: 1, count: 1 });
    expect(slicer.take([1, 2, 3])).toEqual([1, 2, 3]);
    expect(slicer.has()).toBe(true);
  });
});
