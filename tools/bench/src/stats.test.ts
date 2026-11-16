// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { maxOf, median, percentile, round, summarize } from './stats.js';

describe('percentile (nearest rank)', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);

  it('picks the value at the rank ceil(p/100 * n)', () => {
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it('p0 is the minimum and a single value is every percentile', () => {
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([7], 99)).toBe(7);
  });

  it('rounds the rank up for small samples', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 51)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 99)).toBe(5);
  });

  it('rejects an empty sample and a percentile outside 0..100', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile(sorted, 101)).toThrow(RangeError);
    expect(() => percentile(sorted, -1)).toThrow(RangeError);
    expect(() => percentile(sorted, Number.NaN)).toThrow(RangeError);
  });
});

describe('summarize', () => {
  it('sorts a copy and reports count, mean, min, percentiles and max', () => {
    const input = [5, 1, 4, 2, 3];
    const summary = summarize(input);
    expect(input).toEqual([5, 1, 4, 2, 3]);
    expect(summary).toEqual({ count: 5, mean: 3, min: 1, p50: 3, p95: 5, p99: 5, max: 5 });
  });

  it('rejects an empty sample', () => {
    expect(() => summarize([])).toThrow(RangeError);
  });
});

describe('median, maxOf and round', () => {
  it('median averages the two middle values of an even count', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow(RangeError);
  });

  it('maxOf returns the largest value', () => {
    expect(maxOf([2, 9, 4])).toBe(9);
    expect(() => maxOf([])).toThrow(RangeError);
  });

  it('round keeps the requested decimals', () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(1.235, 0)).toBe(1);
  });
});
