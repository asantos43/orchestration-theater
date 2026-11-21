// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from './event-log.js';

/**
 * Semver of the `TelemetryStore` port contract (architecture 5.11 and 5.18, "Versão dos
 * contratos"). It moves on its own, apart from `STORE_PORT_VERSION`: the telemetry base is a
 * different file with a different life (N54).
 */
export const TELEMETRY_STORE_PORT_VERSION = '0.3.0';

/**
 * Attributes of a resource, span, metric point or log record (the OTLP `KeyValue` list read as an
 * object). [proposta] Values are JSON values: a number, a string, a boolean, `null`, or an array
 * or object of those. What goes in them is the receiver's choice (P2); the store keeps it as it
 * came and never looks inside, so a content filter is the receiver's job, not the store's.
 */
export type TelemetryAttributes = Readonly<Record<string, JsonValue>>;

/**
 * The OTheater ids a telemetry record is tied to (architecture 5.11, "correlação"). The receiver
 * fills what it knows (from the resource attributes or the session that owns the client process);
 * a field it does not know is `null`. They are indexed, so "everything of one attempt" is a quick
 * read.
 */
export interface TelemetryCorrelation {
  readonly scenarioId: string | null;
  readonly playId: string | null;
  readonly attemptId: string | null;
  readonly sessionId: string | null;
}

/** Status of a span, as in OTLP: not set, ok, or an error. */
export const TELEMETRY_SPAN_STATUSES = ['unset', 'ok', 'error'] as const;
export type TelemetrySpanStatus = (typeof TELEMETRY_SPAN_STATUSES)[number];

/** Which signal a record belongs to. */
export const TELEMETRY_SIGNALS = ['spans', 'metrics', 'logs'] as const;
export type TelemetrySignal = (typeof TELEMETRY_SIGNALS)[number];

/**
 * One span. A span is identified by its `(traceId, spanId)`: writing one that is already in the
 * base is a no-op (P4 of Phase 8, port 0.2.0), so a producer that derives its ids from something
 * stable (the daemon spans, from the ids of the event log) can write the same span again and the
 * base keeps the first one. Times are exact epoch **nanoseconds** as `bigint`: an epoch in nanoseconds does not
 * fit the 53 bits of a `number`, and the base keeps them without rounding (the adapter splits them
 * in whole milliseconds and a remainder).
 */
export interface TelemetrySpan extends TelemetryCorrelation {
  /** 32 lowercase hex characters (OTLP trace id). */
  readonly traceId: string;
  /** 16 lowercase hex characters. */
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  /** OTLP `SpanKind` number (0 to 5). */
  readonly kind: number;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly status: TelemetrySpanStatus;
  readonly statusMessage: string | null;
  readonly attributes: TelemetryAttributes;
  readonly resource: TelemetryAttributes;
}

/** How a metric point aggregates, as in OTLP. A histogram keeps its buckets in `detail`. */
export const TELEMETRY_METRIC_KINDS = ['gauge', 'sum', 'histogram'] as const;
export type TelemetryMetricKind = (typeof TELEMETRY_METRIC_KINDS)[number];

/**
 * One metric data point. `value` is a double (an integer counter above 2^53 loses precision; a
 * client counter does not get there). For a histogram `value` is the sum and `detail` holds the
 * count and the buckets.
 */
export interface TelemetryMetricPoint extends TelemetryCorrelation {
  readonly name: string;
  readonly unit: string | null;
  readonly kind: TelemetryMetricKind;
  readonly timeUnixNano: bigint;
  /** Start of the aggregation window; `null` for a gauge. */
  readonly startTimeUnixNano: bigint | null;
  readonly value: number;
  readonly detail: Readonly<Record<string, JsonValue>> | null;
  readonly attributes: TelemetryAttributes;
  readonly resource: TelemetryAttributes;
}

/** One log record. `severity` is the OTLP `SeverityNumber` (1 to 24), or `null` when not set. */
export interface TelemetryLogRecord extends TelemetryCorrelation {
  readonly timeUnixNano: bigint;
  readonly severity: number | null;
  readonly severityText: string | null;
  readonly body: string | null;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly attributes: TelemetryAttributes;
  readonly resource: TelemetryAttributes;
}

/** What `write` takes: any mix of the three signals. */
export interface TelemetryBatch {
  readonly spans?: readonly TelemetrySpan[];
  readonly metrics?: readonly TelemetryMetricPoint[];
  readonly logs?: readonly TelemetryLogRecord[];
}

/**
 * Filter of a read. Every field is optional and they combine with AND. The window is
 * `[fromUnixNano, toUnixNano)`: the start time of a span, the time of a point or a record. Records
 * come in time order (oldest first), at most `limit` of them (default 1000, ceiling 10000).
 */
export interface TelemetryReadFilter {
  readonly scenarioId?: string | undefined;
  readonly playId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly fromUnixNano?: bigint | undefined;
  readonly toUnixNano?: bigint | undefined;
  /**
   * Spans only (ignored by the other signals): the window `[endedFromUnixNano, endedToUnixNano)`
   * is over the **end** of the span, so "the spans that ended on this day" is one read, whatever
   * their start. Port 0.3.0.
   */
  readonly endedFromUnixNano?: bigint | undefined;
  readonly endedToUnixNano?: bigint | undefined;
  readonly limit?: number | undefined;
}

/** What `write` reports: what it queued now, and what it had to drop to make room or because it has no base. */
export interface TelemetryWriteReceipt {
  readonly accepted: number;
  /** Records dropped now: the oldest in a full queue, or all of them when there is no base. */
  readonly dropped: number;
}

/** What `deleteOlderThan` removed, by signal. */
export interface TelemetryDeleteResult {
  readonly spans: number;
  readonly metrics: number;
  readonly logs: number;
}

/**
 * One row of the daily aggregates (`rollups_daily`, Phase 8, P9; N55, N217 (a)). [proposta] A row
 * is one number of the analysis for one day, scenario, Executor and role, and the **origin** it
 * came from: the same metric of the same group in two origins is two rows, so a figure that came
 * from the client and one the daemon priced are never added together.
 *
 * - `day`: `YYYY-MM-DD` in the time zone the aggregation was configured with.
 * - `scenarioId`, `executor` (`<client>/<profile>`) and `role`: empty when the source does not say.
 * - `metric` and `facet`: what is counted and its breakdown (the state of the stage, the kind of
 *   wait, the interruption cause...); `facet` is empty when there is none.
 * - `count`: the samples behind the row. `sum`, `p50`, `p95` and `max` are `null` when no sample
 *   knew the value: a gap, never a zero.
 */
export interface RollupRow {
  readonly day: string;
  readonly scenarioId: string;
  readonly executor: string;
  readonly role: string;
  readonly metric: string;
  readonly facet: string;
  readonly origin: string;
  readonly count: number;
  readonly sum: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

/** Filter of `readRollups`: the days are inclusive (`YYYY-MM-DD`); the rest match exactly. */
export interface RollupFilter {
  readonly fromDay?: string | undefined;
  readonly toDay?: string | undefined;
  readonly scenarioId?: string | undefined;
  readonly executor?: string | undefined;
  readonly role?: string | undefined;
}

/** A calendar day, `YYYY-MM-DD`. */
export const ROLLUP_DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * `ok`: writing and reading. `degraded`: the last write or read failed and the next one tries
 * again. `no_base`: the base could not be recreated; writes are discards (counted) until it can.
 */
export const TELEMETRY_STORE_STATES = ['ok', 'degraded', 'no_base'] as const;
export type TelemetryStoreState = (typeof TELEMETRY_STORE_STATES)[number];

/** Counters since the store was opened, and the state. Contains no telemetry content. */
export interface TelemetryHealth {
  readonly state: TelemetryStoreState;
  /** Records waiting in the queue. */
  readonly queued: number;
  /** Records written to the base. */
  readonly written: number;
  /** Records dropped from a full queue (the oldest go first). */
  readonly droppedOverflow: number;
  /** Records discarded because there was no base, or a write failed for good. */
  readonly discarded: number;
  /** Times the base was recreated. */
  readonly resets: number;
  /** Size of the main file in bytes; `null` when there is no base. */
  readonly fileBytes: number | null;
}

/**
 * The telemetry base (architecture 5.11, N54): spans, metric points and log records of the
 * clients, in a file of its own, apart from the `Store`. It is a **mirror to look at**, never
 * what the orchestration depends on: when it fails the daemon goes on and the telemetry is lost
 * (counted), never the other way round.
 *
 * Contract (checked by the tests of the adapter):
 * - `write` is idempotent for spans: a span whose `(traceId, spanId)` is already in the base is
 *   ignored (the first one stays), and the receipt still counts it as accepted. Metric points and
 *   log records have no identity and are always added.
 * - `write` never throws and never waits for the disk: it puts the records in a queue with a
 *   ceiling; the adapter writes them in batches. A full queue drops its **oldest** records and
 *   counts them (`droppedOverflow`). With no base the records are discarded and counted.
 * - A read first writes what is queued, so a record just written is there to read.
 * - Reads and `deleteOlderThan` reject with `AdapterUnavailable` when the base cannot be used; a
 *   corrupted or full file is recreated (the broken one is kept beside it) and the adapter tells
 *   the daemon, which records `telemetry.store_reset`.
 * - `close` writes the queue and releases the file; afterwards `write` is a discard.
 */
export interface TelemetryStore {
  write(batch: TelemetryBatch): TelemetryWriteReceipt;
  /**
   * Writes what is queued now. With no base it resolves (the records are discarded and counted);
   * it rejects when a write failed for a reason that does not recreate the base (e.g. a lock).
   */
  flush(): Promise<void>;
  readSpans(filter?: TelemetryReadFilter): Promise<readonly TelemetrySpan[]>;
  readMetrics(filter?: TelemetryReadFilter): Promise<readonly TelemetryMetricPoint[]>;
  readLogs(filter?: TelemetryReadFilter): Promise<readonly TelemetryLogRecord[]>;
  /**
   * Deletes what is older than `cutoffUnixNano`: spans by their end, points and records by their
   * time. The retention policy that decides the cutoff is not part of the port (Phase 8, P8).
   */
  deleteOlderThan(cutoffUnixNano: bigint): Promise<TelemetryDeleteResult>;
  /**
   * The cursor a producer saved with {@link TelemetryStore.writeCursor}, or `null` when it saved
   * none (or the base was recreated since, which is the point: the cursor lives in the base, so
   * losing the base makes the producer start again). Rejects with `AdapterUnavailable` when the
   * base cannot be used. Port 0.2.0.
   */
  readCursor(name: string): Promise<number | null>;
  /**
   * Saves a cursor (a non-negative integer, such as an event id) under `name`. It first writes
   * what is queued, so the cursor never runs ahead of the spans written before it; it rejects when
   * that write failed or the base cannot be used, and then the cursor is not saved. Port 0.2.0.
   */
  writeCursor(name: string, value: number): Promise<void>;
  /**
   * Replaces **every** row of `day` with `rows` in one transaction (a day that is aggregated again
   * gives the same rows, never a sum of two runs). Every row must carry that `day`, and a row is
   * identified by `(day, scenarioId, executor, role, metric, facet, origin)`; anything else is
   * `InvalidInput`. Rejects with `AdapterUnavailable` when the base cannot be used. Port 0.3.0.
   */
  replaceRollupDay(day: string, rows: readonly RollupRow[]): Promise<void>;
  /** The aggregates of the days in the filter, in the order of the key. Port 0.3.0. */
  readRollups(filter?: RollupFilter): Promise<readonly RollupRow[]>;
  /**
   * The last day up to which the aggregates are ready: every day up to it, inclusive, was
   * aggregated and kept. The retention of the raw telemetry (P8) never removes what is of a later
   * day. `null` when none is (or the base was recreated since, which is the point: with the base
   * went the aggregates). Port 0.3.0.
   */
  readRollupsReadyThrough(): Promise<string | null>;
  /** Moves the marker of {@link TelemetryStore.readRollupsReadyThrough} forward; an earlier day is ignored. Port 0.3.0. */
  markRollupsReady(day: string): Promise<void>;
  /** Deletes the aggregates of the days before `day` (exclusive); returns how many rows. Port 0.3.0. */
  deleteRollupsBefore(day: string): Promise<number>;
  health(): Promise<TelemetryHealth>;
  close(): Promise<void>;
}

/** Splits exact epoch nanoseconds in whole milliseconds and the remainder (0 to 999999). */
export function splitUnixNano(nanos: bigint): { readonly ms: number; readonly subNs: number } {
  const ms = nanos / 1_000_000n;
  const sub = nanos % 1_000_000n;
  // Truncated division rounds toward zero; telemetry times are positive, so this is a floor.
  return { ms: Number(ms), subNs: Number(sub) };
}

/** Joins what {@link splitUnixNano} split. */
export function joinUnixNano(ms: number, subNs: number): bigint {
  return BigInt(ms) * 1_000_000n + BigInt(subNs);
}
