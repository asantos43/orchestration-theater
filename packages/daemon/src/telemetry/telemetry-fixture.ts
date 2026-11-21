// SPDX-License-Identifier: MPL-2.0
import type {
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
  #resets = 0;
  #closed = false;

  write(batch: TelemetryBatch): TelemetryWriteReceipt {
    if (this.#closed) return { accepted: 0, dropped: (batch.spans ?? []).length };
    for (const span of batch.spans ?? []) {
      const key = `${span.traceId}/${span.spanId}`;
      if (!this.#spans.has(key)) this.#spans.set(key, span);
    }
    return { accepted: (batch.spans ?? []).length, dropped: 0 };
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
      .sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
    return Promise.resolve(spans.slice(0, filter.limit ?? 10_000));
  }

  readMetrics(): Promise<readonly TelemetryMetricPoint[]> {
    return Promise.resolve([]);
  }

  readLogs(): Promise<readonly TelemetryLogRecord[]> {
    return Promise.resolve([]);
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
