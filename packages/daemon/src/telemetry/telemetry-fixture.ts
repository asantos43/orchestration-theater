// SPDX-License-Identifier: MPL-2.0
import type {
  RollupFilter,
  RollupRow,
  TelemetryBatch,
  TelemetryDeleteResult,
  TelemetryHealth,
  TelemetryLogRecord,
  TelemetryMetricPoint,
  TelemetryReadFilter,
  TelemetrySpan,
  TelemetryStore,
  TelemetryWriteReceipt,
} from '@otheater/core';

/**
 * A `TelemetryStore` in memory, for the tests of the daemon (which may not import the SQLite
 * adapter: only `compose.ts` does). It keeps the contract the projector leans on: a span is
 * identified by `(traceId, spanId)` and the first one written stays, the cursors are kept apart
 * from the spans, and `health().resets` counts the times the base was replaced. The identity of
 * the real adapter, on a real file, is checked in the tests of the adapter.
 */
export class MemoryTelemetryStore implements TelemetryStore {
  readonly #spans = new Map<string, TelemetrySpan>();
  readonly #cursors = new Map<string, number>();
  readonly #metrics: TelemetryMetricPoint[] = [];
  readonly #logs: TelemetryLogRecord[] = [];
  readonly #rollups = new Map<string, RollupRow>();
  #readyThrough: string | null = null;
  #resets = 0;
  #closed = false;

  write(batch: TelemetryBatch): TelemetryWriteReceipt {
    if (this.#closed) return { accepted: 0, dropped: (batch.spans ?? []).length };
    for (const span of batch.spans ?? []) {
      const key = `${span.traceId}/${span.spanId}`;
      if (!this.#spans.has(key)) this.#spans.set(key, span);
    }
    this.#metrics.push(...(batch.metrics ?? []));
    this.#logs.push(...(batch.logs ?? []));
    return {
      accepted:
        (batch.spans ?? []).length + (batch.metrics ?? []).length + (batch.logs ?? []).length,
      dropped: 0,
    };
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  readSpans(filter: TelemetryReadFilter = {}): Promise<readonly TelemetrySpan[]> {
    const spans = [...this.#spans.values()]
      .filter((span) => filter.playId === undefined || span.playId === filter.playId)
      .filter((span) => filter.attemptId === undefined || span.attemptId === filter.attemptId)
      .filter((span) => filter.sessionId === undefined || span.sessionId === filter.sessionId)
      .filter((span) => filter.scenarioId === undefined || span.scenarioId === filter.scenarioId)
      .filter(
        (span) =>
          filter.fromUnixNano === undefined || span.startTimeUnixNano >= filter.fromUnixNano,
      )
      .filter(
        (span) => filter.toUnixNano === undefined || span.startTimeUnixNano < filter.toUnixNano,
      )
      .filter(
        (span) =>
          filter.endedFromUnixNano === undefined ||
          span.endTimeUnixNano >= filter.endedFromUnixNano,
      )
      .filter(
        (span) =>
          filter.endedToUnixNano === undefined || span.endTimeUnixNano < filter.endedToUnixNano,
      )
      .sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
    return Promise.resolve(spans.slice(0, filter.limit ?? 10_000));
  }

  readMetrics(filter: TelemetryReadFilter = {}): Promise<readonly TelemetryMetricPoint[]> {
    return Promise.resolve(
      this.#metrics
        .filter((point) => filter.attemptId === undefined || point.attemptId === filter.attemptId)
        .filter((point) => filter.playId === undefined || point.playId === filter.playId)
        .filter(
          (point) => filter.fromUnixNano === undefined || point.timeUnixNano >= filter.fromUnixNano,
        )
        .filter(
          (point) => filter.toUnixNano === undefined || point.timeUnixNano < filter.toUnixNano,
        )
        .slice(0, filter.limit ?? 10_000),
    );
  }

  readLogs(filter: TelemetryReadFilter = {}): Promise<readonly TelemetryLogRecord[]> {
    return Promise.resolve(
      this.#logs
        .filter((record) => filter.attemptId === undefined || record.attemptId === filter.attemptId)
        .filter((record) => filter.playId === undefined || record.playId === filter.playId)
        .filter(
          (record) =>
            filter.fromUnixNano === undefined || record.timeUnixNano >= filter.fromUnixNano,
        )
        .filter(
          (record) => filter.toUnixNano === undefined || record.timeUnixNano < filter.toUnixNano,
        )
        .slice(0, filter.limit ?? 10_000),
    );
  }

  replaceRollupDay(day: string, rows: readonly RollupRow[]): Promise<void> {
    for (const [key, row] of this.#rollups) if (row.day === day) this.#rollups.delete(key);
    for (const row of rows) {
      const key = [
        row.day,
        row.scenarioId,
        row.executor,
        row.role,
        row.metric,
        row.facet,
        row.origin,
      ].join('|');
      this.#rollups.set(key, row);
    }
    return Promise.resolve();
  }

  readRollups(filter: RollupFilter = {}): Promise<readonly RollupRow[]> {
    const rows = [...this.#rollups.values()]
      .filter((row) => filter.fromDay === undefined || row.day >= filter.fromDay)
      .filter((row) => filter.toDay === undefined || row.day <= filter.toDay)
      .filter((row) => filter.scenarioId === undefined || row.scenarioId === filter.scenarioId)
      .filter((row) => filter.executor === undefined || row.executor === filter.executor)
      .filter((row) => filter.role === undefined || row.role === filter.role);
    const key = (row: RollupRow): string =>
      [row.day, row.scenarioId, row.executor, row.role, row.metric, row.facet, row.origin].join(
        '|',
      );
    return Promise.resolve(rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
  }

  readRollupsReadyThrough(): Promise<string | null> {
    return Promise.resolve(this.#readyThrough);
  }

  markRollupsReady(day: string): Promise<void> {
    if (this.#readyThrough === null || day > this.#readyThrough) this.#readyThrough = day;
    return Promise.resolve();
  }

  deleteRollupsBefore(day: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rollups) {
      if (row.day < day) {
        this.#rollups.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  deleteOlderThan(cutoffUnixNano: bigint): Promise<TelemetryDeleteResult> {
    let spans = 0;
    for (const [key, span] of this.#spans) {
      if (span.endTimeUnixNano < cutoffUnixNano) {
        this.#spans.delete(key);
        spans += 1;
      }
    }
    return Promise.resolve({ spans, metrics: 0, logs: 0 });
  }

  readCursor(name: string): Promise<number | null> {
    return Promise.resolve(this.#cursors.get(name) ?? null);
  }

  writeCursor(name: string, value: number): Promise<void> {
    this.#cursors.set(name, value);
    return Promise.resolve();
  }

  /** What a recreated base is: empty, no cursor, one more reset. */
  reset(): void {
    this.#spans.clear();
    this.#cursors.clear();
    this.#metrics.length = 0;
    this.#logs.length = 0;
    this.#rollups.clear();
    this.#readyThrough = null;
    this.#resets += 1;
  }

  health(): Promise<TelemetryHealth> {
    return Promise.resolve({
      state: 'ok',
      queued: 0,
      written: this.#spans.size,
      droppedOverflow: 0,
      discarded: 0,
      resets: this.#resets,
      fileBytes: null,
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
