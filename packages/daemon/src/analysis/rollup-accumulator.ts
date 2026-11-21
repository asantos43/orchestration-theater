// SPDX-License-Identifier: MPL-2.0
import type { RollupRow } from '@otheater/core';

/** The dimensions of a row besides the day; the empty string where the value is not known. */
export interface RollupDims {
  readonly scenarioId: string;
  readonly executor: string;
  readonly role: string;
}

export const NO_DIMS: RollupDims = { scenarioId: '', executor: '', role: '' };

interface Cell {
  readonly dims: RollupDims;
  readonly metric: string;
  readonly facet: string;
  readonly origin: string;
  /** Known samples (durations, tokens, costs). */
  readonly samples: number[];
  /** What a counter counted; `null` for a cell of samples. */
  counter: number | null;
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * Builds the rows of one day (Phase 8, P9). A cell holds either samples (a duration, a token
 * count, a cost: the row gets the count, the sum, the p50, the p95 and the maximum) or a counter
 * (the row gets the count, and the sum is the count). A cell that only had unknown samples
 * (`gap`) becomes a row of count 0 and no figure at all: a gap, never a zero. The rows come out in
 * the order of their key, so the same input always gives the same rows.
 */
export class RollupAccumulator {
  readonly #day: string;
  readonly #cells = new Map<string, Cell>();

  constructor(day: string) {
    this.#day = day;
  }

  #cell(dims: RollupDims, metric: string, facet: string, origin: string): Cell {
    const key = [dims.scenarioId, dims.executor, dims.role, metric, facet, origin].join('\u0000');
    let cell = this.#cells.get(key);
    if (cell === undefined) {
      cell = { dims, metric, facet, origin, samples: [], counter: null };
      this.#cells.set(key, cell);
    }
    return cell;
  }

  /** One known value. */
  sample(dims: RollupDims, metric: string, facet: string, origin: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.#cell(dims, metric, facet, origin).samples.push(value);
  }

  /** One that the source did not know: keeps the row, adds nothing to its figures. */
  gap(dims: RollupDims, metric: string, facet: string, origin: string): void {
    this.#cell(dims, metric, facet, origin);
  }

  count(dims: RollupDims, metric: string, facet: string, origin: string, n = 1): void {
    const cell = this.#cell(dims, metric, facet, origin);
    cell.counter = (cell.counter ?? 0) + n;
  }

  rows(): RollupRow[] {
    const rows: RollupRow[] = [];
    for (const cell of this.#cells.values()) {
      const base = {
        day: this.#day,
        scenarioId: cell.dims.scenarioId,
        executor: cell.dims.executor,
        role: cell.dims.role,
        metric: cell.metric,
        facet: cell.facet,
        origin: cell.origin,
      };
      if (cell.counter !== null) {
        rows.push({
          ...base,
          count: cell.counter,
          sum: cell.counter,
          p50: null,
          p95: null,
          max: null,
        });
      } else if (cell.samples.length === 0) {
        rows.push({ ...base, count: 0, sum: null, p50: null, p95: null, max: null });
      } else {
        const sorted = [...cell.samples].sort((a, b) => a - b);
        rows.push({
          ...base,
          count: sorted.length,
          sum: sorted.reduce((acc, v) => acc + v, 0),
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          max: sorted[sorted.length - 1] ?? null,
        });
      }
    }
    return rows.sort(compareRollupKeys);
  }
}

export function compareRollupKeys(a: RollupRow, b: RollupRow): number {
  const key = (r: RollupRow): string =>
    [r.day, r.scenarioId, r.executor, r.role, r.metric, r.facet, r.origin].join('\u0000');
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
