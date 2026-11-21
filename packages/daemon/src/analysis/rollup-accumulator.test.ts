// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { NO_DIMS, RollupAccumulator, percentile } from './rollup-accumulator.js';

const DIMS = { scenarioId: 's1', executor: 'fake/one', role: 'actor' };

describe('the nearest-rank percentile', () => {
  it('is null without samples and the only sample with one', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('takes the rank of the quantile in an ascending list', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(100);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
  });
});

describe('the rows of a day', () => {
  it('sums, counts and takes the percentiles of the samples of a cell', () => {
    const acc = new RollupAccumulator('2026-11-20');
    for (const ms of [300, 100, 200, 400]) acc.sample(DIMS, 'attempt_ms', '', 'daemon', ms);
    expect(acc.rows()).toEqual([
      {
        day: '2026-11-20',
        ...DIMS,
        metric: 'attempt_ms',
        facet: '',
        origin: 'daemon',
        count: 4,
        sum: 1000,
        p50: 200,
        p95: 400,
        max: 400,
      },
    ]);
  });

  it('gives a counter a count equal to its sum and no percentiles', () => {
    const acc = new RollupAccumulator('2026-11-20');
    acc.count(NO_DIMS, 'rejections', 'PLAN_REVIEWED', 'daemon');
    acc.count(NO_DIMS, 'rejections', 'PLAN_REVIEWED', 'daemon', 2);
    const [row] = acc.rows();
    expect(row).toMatchObject({ count: 3, sum: 3, p50: null, p95: null, max: null });
  });

  it('keeps a cell with only unknown samples as a gap, never as a zero', () => {
    const acc = new RollupAccumulator('2026-11-20');
    acc.gap(DIMS, 'tokens_in', '', 'client');
    const [row] = acc.rows();
    expect(row).toMatchObject({ count: 0, sum: null, p50: null, p95: null, max: null });
  });

  it('ignores a value that is not a duration or a count', () => {
    const acc = new RollupAccumulator('2026-11-20');
    acc.sample(DIMS, 'attempt_ms', '', 'daemon', Number.NaN);
    acc.sample(DIMS, 'attempt_ms', '', 'daemon', -5);
    expect(acc.rows()).toEqual([]);
  });

  it('keeps known samples when a gap shares the cell', () => {
    const acc = new RollupAccumulator('2026-11-20');
    acc.gap(DIMS, 'tokens_in', '', 'client');
    acc.sample(DIMS, 'tokens_in', '', 'client', 120);
    expect(acc.rows()[0]).toMatchObject({ count: 1, sum: 120 });
  });

  it('comes out in the order of the key whatever the order it went in', () => {
    const a = new RollupAccumulator('2026-11-20');
    const b = new RollupAccumulator('2026-11-20');
    a.count(DIMS, 'z', '', 'daemon');
    a.count(NO_DIMS, 'a', 'x', 'daemon');
    b.count(NO_DIMS, 'a', 'x', 'daemon');
    b.count(DIMS, 'z', '', 'daemon');
    expect(a.rows()).toEqual(b.rows());
    expect(a.rows().map((row) => row.metric)).toEqual(['a', 'z']);
  });
});
