// SPDX-License-Identifier: MPL-2.0

/** `items[index]`, or a `RangeError` when there is no such element (no `!` needed). */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`No element at index ${String(index)}`);
  return item;
}

/** Percentile of an ascending array by the nearest-rank method; `p` is in 0..100. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('percentile of an empty sample');
  if (!(p >= 0 && p <= 100)) throw new RangeError(`p must be within 0..100, got ${String(p)}`);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return at(sorted, rank - 1);
}

export interface Summary {
  readonly count: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Count, mean, min, p50, p95, p99 and max of a sample (any order, at least one value). */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) throw new RangeError('summary of an empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    min: at(sorted, 0),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: at(sorted, sorted.length - 1),
  };
}

/** Median (mean of the two middle values for an even count). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? at(sorted, middle)
    : (at(sorted, middle - 1) + at(sorted, middle)) / 2;
}

export function maxOf(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('max of an empty sample');
  return values.reduce((a, b) => Math.max(a, b));
}

/** Rounds to `digits` decimals (for the JSON report; keeps files readable). */
export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
