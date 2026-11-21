// SPDX-License-Identifier: MPL-2.0
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  isOTheaterError,
  joinUnixNano,
  ROLLUP_DAY_PATTERN,
  splitUnixNano,
  TELEMETRY_STORE_PORT_VERSION,
  Transient,
  type Clock,
  type RollupFilter,
  type RollupRow,
  type TelemetryBatch,
  type TelemetryDeleteResult,
  type TelemetryFootprint,
  type TelemetryHealth,
  type TelemetryLogRecord,
  type TelemetryMetricPoint,
  type TelemetryReadFilter,
  type TelemetryRecordOf,
  type TelemetryRow,
  type TelemetrySignal,
  type TelemetrySpan,
  type TelemetryStore,
  type TelemetryStoreState,
  type TelemetryWriteReceipt,
} from '@otheater/core';
import { Kysely, sql, SqliteDialect, type RawBuilder } from 'kysely';
import { z } from 'zod';
import {
  SqliteTelemetryConfigSchema,
  type SqliteDriverName,
  type SqliteTelemetryConfig,
  type SqliteTelemetryConfigInput,
} from './config.js';
import { ImmediateSqliteDialect } from './dialect.js';
import { openRawDatabase, readPragma, type RawDatabase } from './driver.js';
import { resetReasonOf, toTelemetryError, type ResetReason } from './errors.js';
import { migrateToLatest } from './migrations.js';
import {
  logEntry,
  metricEntry,
  spanEntry,
  toLog,
  toMetric,
  toSpan,
  type LogRow,
  type MetricRow,
  type QueueEntry,
  type SpanRow,
} from './records.js';
import type { TelemetryDatabase } from './schema.js';

/** Pages per step that covers the whole file: one step, which cannot be interrupted. */
const ALL_PAGES_IN_ONE_STEP = 0x7fffffff;

/** The base is recreated at most this many times before a write succeeds; then it is given up. */
export const MAX_RESETS_IN_A_ROW = 3;

/** Default and ceiling of a read. */
export const DEFAULT_READ_LIMIT = 1000;
export const MAX_READ_LIMIT = 10_000;

/** The `meta` key of a producer cursor (`format` and the others of the file never clash). */
function cursorKey(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new InvalidInput('a cursor name must be a string of 1 to 128 characters');
  }
  return `cursor:${name}`;
}

/** The `meta` key of the day up to which the daily aggregates are ready. */
const ROLLUPS_READY_KEY = 'rollups:ready_through';

function assertDay(day: string): void {
  if (typeof day !== 'string' || !ROLLUP_DAY_PATTERN.test(day)) {
    throw new InvalidInput('a rollup day must be YYYY-MM-DD');
  }
}

function assertRollupRow(row: RollupRow): void {
  assertDay(row.day);
  if (!Number.isSafeInteger(row.count) || row.count < 0) {
    throw new InvalidInput('a rollup count must be an integer >= 0');
  }
  for (const value of [row.sum, row.p50, row.p95, row.max]) {
    if (value !== null && !Number.isFinite(value)) {
      throw new InvalidInput('a rollup value must be a finite number or null');
    }
  }
  if (row.metric.length === 0 || row.origin.length === 0) {
    throw new InvalidInput('a rollup row needs a metric and an origin');
  }
}

function toRollupColumns(row: RollupRow) {
  return {
    day: row.day,
    scenario_id: row.scenarioId,
    executor: row.executor,
    role: row.role,
    metric: row.metric,
    facet: row.facet,
    origin: row.origin,
    count: row.count,
    sum: row.sum,
    p50: row.p50,
    p95: row.p95,
    max: row.max,
  };
}

/** The table of each signal, for `readSince`. */
const SINCE_TABLE = {
  spans: 'spans',
  metrics: 'metric_points',
  logs: 'log_records',
} as const satisfies Record<TelemetrySignal, string>;

/** Rows per `INSERT`: well under SQLite's limit of bound variables (32766) for the widest table. */
const ROWS_PER_INSERT = 100;

/** Why the base was left or recreated (the event `telemetry.store_reset` carries it). */
export type TelemetryResetReason = ResetReason | 'io_error';

/**
 * What the adapter tells the daemon when it recreates the base, or cannot (the daemon logs it and
 * records `telemetry.store_reset`). Holds no telemetry content.
 */
export interface TelemetryResetInfo {
  readonly reason: TelemetryResetReason;
  /** `recreated`: a new empty base is in use. `unavailable`: there is none; writes are discards. */
  readonly outcome: 'recreated' | 'unavailable';
  /** Absolute path where the old file was kept; `null` when it was not moved. */
  readonly brokenFile: string | null;
  /** Message of the error that led here (for the log, not for the event). */
  readonly error: string;
  /** Times the base was recreated since this store opened, this one included. */
  readonly resets: number;
}

export interface TelemetryStoreDeps {
  /** Stamps the name of the kept file. */
  readonly clock: Pick<Clock, 'now'>;
  /** Called when the base is recreated or given up. Must not throw; a throw is swallowed. */
  readonly onReset?: ((info: TelemetryResetInfo) => void) | undefined;
}

/** Settings of the write connection as SQLite reports them (for a `doctor`-style check and the tests). */
export interface SqliteTelemetryDiagnostics {
  readonly driver: SqliteDriverName;
  readonly journalMode: string;
  /** `PRAGMA synchronous` as SQLite numbers it: 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA. */
  readonly synchronous: number;
  readonly busyTimeoutMs: number;
}

/** Pragmas of the write connection, in order; `busy_timeout` first so the switch to WAL waits. */
export function writerPragmas(
  config: Pick<SqliteTelemetryConfig, 'synchronous' | 'busyTimeoutMs'>,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return [
    `PRAGMA busy_timeout = ${String(config.busyTimeoutMs)}`,
    'PRAGMA journal_mode = WAL',
    `PRAGMA synchronous = ${config.synchronous === 'full' ? 'FULL' : 'NORMAL'}`,
    'PRAGMA foreign_keys = ON',
    ...(platform === 'darwin' ? ['PRAGMA fullfsync = ON', 'PRAGMA checkpoint_fullfsync = ON'] : []),
  ];
}

interface Connections {
  readonly writerRaw: RawDatabase;
  readonly readerRaw: RawDatabase;
  readonly writer: Kysely<TelemetryDatabase>;
  readonly reader: Kysely<TelemetryDatabase>;
}

const SIGNALS_IN_ORDER = ['spans', 'metrics', 'logs'] as const;

/** `20261121-153000` for 2026-11-21T15:30:00Z. */
function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The SQLite adapter of the `TelemetryStore` port (architecture 5.11, N54): Kysely on
 * `better-sqlite3` or `node:sqlite`, WAL, `synchronous = NORMAL`, versioned migrations, in a file
 * of its own.
 *
 * - **Queue.** `write` only pushes to a queue (ceiling `queueMax`; a full queue drops the oldest
 *   and counts them). The queue is written in transactions of `writeBatch` records when it fills
 *   up, after `flushIntervalMs`, before a read, and on `close`. One write at a time, in order.
 * - **Never in the way.** A failure here never reaches the orchestration. A corrupted, full or
 *   unmigratable file is renamed to `<file>.broken-<date>` (with its `-wal` and `-shm`), a new
 *   one is made and `onReset` is told. A base that cannot be had at all is `no_base`: writes are
 *   discards (counted) and the next write after `retryAfterMs` tries to open it again.
 * - **Two connections** to the file, as in the `Store`: the writer, and a read-only reader that
 *   never waits for a write.
 *
 * Open it with {@link SqliteTelemetryStore.open}; it does not reject for a bad file, only for a
 * bad config.
 */
export class SqliteTelemetryStore implements TelemetryStore {
  readonly config: SqliteTelemetryConfig;
  readonly #deps: TelemetryStoreDeps;
  #conn: Connections | undefined;
  #state: TelemetryStoreState = 'ok';
  #queue: QueueEntry[] = [];
  #timer: NodeJS.Timeout | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | undefined;
  #recovering = false;
  #noBaseSince: number | undefined;
  #lastReason: TelemetryResetReason = 'io_error';
  #resetsInARow = 0;
  #written = 0;
  #droppedOverflow = 0;
  #discarded = 0;
  #resets = 0;

  private constructor(config: SqliteTelemetryConfig, deps: TelemetryStoreDeps) {
    this.config = config;
    this.#deps = deps;
  }

  /**
   * Opens (creating if needed) the base. Rejects with `InvalidInput` for a bad config; a file
   * that cannot be used is recreated, and when even that fails the store opens in `no_base`.
   */
  static async open(
    input: SqliteTelemetryConfigInput,
    deps: TelemetryStoreDeps,
  ): Promise<SqliteTelemetryStore> {
    const parsed = SqliteTelemetryConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidInput(`Invalid SQLite telemetry config: ${z.prettifyError(parsed.error)}`, {
        cause: parsed.error,
      });
    }
    const store = new SqliteTelemetryStore(
      { ...parsed.data, path: resolve(parsed.data.path) },
      deps,
    );
    await store.#establish();
    return store;
  }

  /** Absolute path of the database file. */
  get path(): string {
    return this.config.path;
  }

  // ---- write ----------------------------------------------------------------------------------

  write(batch: TelemetryBatch): TelemetryWriteReceipt {
    const entries: QueueEntry[] = [];
    let invalid = 0;
    const convert = <T>(items: readonly T[] | undefined, make: (item: T) => QueueEntry): void => {
      for (const item of items ?? []) {
        try {
          entries.push(make(item));
        } catch {
          invalid += 1;
        }
      }
    };
    convert<TelemetrySpan>(batch.spans, spanEntry);
    convert<TelemetryMetricPoint>(batch.metrics, metricEntry);
    convert<TelemetryLogRecord>(batch.logs, logEntry);
    this.#discarded += invalid;

    if (this.#closed || this.#state === 'no_base') {
      this.#discarded += entries.length;
      if (!this.#closed) this.#maybeRecover();
      return { accepted: 0, dropped: invalid + entries.length };
    }

    this.#queue.push(...entries);
    const over = Math.max(0, this.#queue.length - this.config.queueMax);
    if (over > 0) {
      this.#queue.splice(0, over);
      this.#droppedOverflow += over;
    }
    if (entries.length > 0) this.#schedule(false);
    return { accepted: entries.length, dropped: invalid + over };
  }

  flush(): Promise<void> {
    return this.#enqueue(() => this.#drain());
  }

  #schedule(slow: boolean): void {
    const full = !slow && this.#queue.length >= this.config.writeBatch;
    if (this.#timer !== undefined && !full) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.flush().catch(() => undefined);
      },
      full ? 0 : this.config.flushIntervalMs,
    );
    this.#timer.unref();
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /** Writes the queue, a batch at a time. Runs inside the promise queue. */
  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      if (this.#state === 'no_base') {
        // Nothing to write to: what is queued is lost, and counted.
        this.#discarded += this.#queue.length;
        this.#queue = [];
        return;
      }
      const chunk = this.#queue.splice(0, this.config.writeBatch);
      try {
        await this.#writeChunk(chunk);
      } catch (error) {
        const reason = resetReasonOf(error);
        if (reason !== undefined) {
          this.#discarded += chunk.length;
          await this.#reset(reason, error);
          continue;
        }
        const mapped = toTelemetryError(error);
        this.#state = 'degraded';
        if (mapped instanceof Transient) {
          // A lock: keep the records for the next round, within the ceiling.
          this.#queue.unshift(...chunk);
          const over = Math.max(0, this.#queue.length - this.config.queueMax);
          if (over > 0) {
            this.#queue.splice(0, over);
            this.#droppedOverflow += over;
          }
          this.#schedule(true);
        } else {
          this.#discarded += chunk.length;
        }
        throw mapped;
      }
      this.#written += chunk.length;
      this.#resetsInARow = 0;
      this.#state = 'ok';
    }
  }

  async #writeChunk(chunk: readonly QueueEntry[]): Promise<void> {
    const conn = this.#conn;
    if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not open');
    await conn.writer.transaction().execute(async (trx) => {
      const resourceIds = new Map<string, number>();
      for (const entry of chunk) {
        if (resourceIds.has(entry.resource.hash)) continue;
        await trx
          .insertInto('resources')
          .values({ hash: entry.resource.hash, attributes: entry.resource.json })
          .onConflict((conflict) => conflict.column('hash').doNothing())
          .execute();
        const found = await trx
          .selectFrom('resources')
          .select('id')
          .where('hash', '=', entry.resource.hash)
          .executeTakeFirstOrThrow();
        resourceIds.set(entry.resource.hash, found.id);
      }
      for (const signal of SIGNALS_IN_ORDER) {
        const rows = chunk
          .filter((entry) => entry.signal === signal)
          .map((entry) => ({
            ...entry.row,
            resource_id: resourceIds.get(entry.resource.hash) ?? 0,
          }));
        for (let at = 0; at < rows.length; at += ROWS_PER_INSERT) {
          const part = rows.slice(at, at + ROWS_PER_INSERT);
          if (signal === 'spans') {
            // A span is identified by (trace_id, span_id): writing one again keeps the first.
            await trx
              .insertInto('spans')
              .values(part as never)
              .onConflict((conflict) => conflict.columns(['trace_id', 'span_id']).doNothing())
              .execute();
          } else if (signal === 'metrics') {
            await trx
              .insertInto('metric_points')
              .values(part as never)
              .execute();
          } else {
            await trx
              .insertInto('log_records')
              .values(part as never)
              .execute();
          }
        }
      }
    });
  }

  // ---- read -----------------------------------------------------------------------------------

  readSpans(filter: TelemetryReadFilter = {}): Promise<readonly TelemetrySpan[]> {
    return this.#read(filter, 'spans', 'start', (rows: SpanRow[]) => rows.map(toSpan));
  }

  readMetrics(filter: TelemetryReadFilter = {}): Promise<readonly TelemetryMetricPoint[]> {
    return this.#read(filter, 'metric_points', 'time', (rows: MetricRow[]) => rows.map(toMetric));
  }

  readLogs(filter: TelemetryReadFilter = {}): Promise<readonly TelemetryLogRecord[]> {
    return this.#read(filter, 'log_records', 'time', (rows: LogRow[]) => rows.map(toLog));
  }

  async #read<Out>(
    filter: TelemetryReadFilter,
    table: 'spans' | 'metric_points' | 'log_records',
    timeColumn: 'start' | 'time',
    map: (rows: never[]) => Out[],
  ): Promise<readonly Out[]> {
    const limit = filter.limit ?? DEFAULT_READ_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
      throw new InvalidInput(`limit must be an integer from 1 to ${String(MAX_READ_LIMIT)}`);
    }
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    // What was just written is there to read; a failed write does not stop the read.
    await this.flush().catch(() => undefined);
    const conn = this.#conn;
    if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');

    const ms = sql.ref(`t.${timeColumn}_ms`);
    const sub = sql.ref(`t.${timeColumn}_sub_ns`);
    const where: RawBuilder<unknown>[] = [];
    const ids = [
      ['scenario_id', filter.scenarioId],
      ['play_id', filter.playId],
      ['attempt_id', filter.attemptId],
      ['session_id', filter.sessionId],
    ] as const;
    for (const [column, value] of ids) {
      if (value !== undefined) where.push(sql`${sql.ref(`t.${column}`)} = ${value}`);
    }
    if (filter.fromUnixNano !== undefined) {
      const from = splitUnixNano(filter.fromUnixNano);
      where.push(sql`(${ms} > ${from.ms} or (${ms} = ${from.ms} and ${sub} >= ${from.subNs}))`);
    }
    if (filter.toUnixNano !== undefined) {
      const to = splitUnixNano(filter.toUnixNano);
      where.push(sql`(${ms} < ${to.ms} or (${ms} = ${to.ms} and ${sub} < ${to.subNs}))`);
    }
    if (table === 'spans') {
      const endMs = sql.ref('t.end_ms');
      const endSub = sql.ref('t.end_sub_ns');
      if (filter.endedFromUnixNano !== undefined) {
        const from = splitUnixNano(filter.endedFromUnixNano);
        where.push(
          sql`(${endMs} > ${from.ms} or (${endMs} = ${from.ms} and ${endSub} >= ${from.subNs}))`,
        );
      }
      if (filter.endedToUnixNano !== undefined) {
        const to = splitUnixNano(filter.endedToUnixNano);
        where.push(sql`(${endMs} < ${to.ms} or (${endMs} = ${to.ms} and ${endSub} < ${to.subNs}))`);
      }
    }
    const clause = where.length === 0 ? sql`` : sql`where ${sql.join(where, sql` and `)}`;
    try {
      const result = await sql<never>`
        select t.*, r.attributes as resource_attributes
        from ${sql.table(table)} t join resources r on r.id = t.resource_id
        ${clause}
        order by ${ms}, ${sub}, t.id
        limit ${limit}`.execute(conn.reader);
      return map(result.rows);
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  /**
   * `readSince` (port 0.3.0): the rows after a position, by row id (`integer primary key
   * autoincrement`, so ids grow with the insertion and are never reused), with no time filter.
   */
  async readSince<S extends TelemetrySignal>(
    signal: S,
    afterRowId: number,
    limit: number = DEFAULT_READ_LIMIT,
  ): Promise<readonly TelemetryRow<TelemetryRecordOf[S]>[]> {
    if (!Number.isSafeInteger(afterRowId) || afterRowId < 0) {
      throw new InvalidInput('afterRowId must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
      throw new InvalidInput(`limit must be an integer from 1 to ${String(MAX_READ_LIMIT)}`);
    }
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    await this.flush().catch(() => undefined);
    const conn = this.#conn;
    if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
    const table = SINCE_TABLE[signal];
    try {
      const result = await sql<{ id: number }>`
        select t.*, r.attributes as resource_attributes
        from ${sql.table(table)} t join resources r on r.id = t.resource_id
        where t.id > ${afterRowId}
        order by t.id
        limit ${limit}`.execute(conn.reader);
      const rows = result.rows as unknown as never[];
      const records: unknown[] =
        signal === 'spans'
          ? (rows as SpanRow[]).map(toSpan)
          : signal === 'metrics'
            ? (rows as MetricRow[]).map(toMetric)
            : (rows as LogRow[]).map(toLog);
      return result.rows.map((row, index) => ({
        rowId: row.id,
        record: records[index],
      })) as unknown as readonly TelemetryRow<TelemetryRecordOf[S]>[];
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  /** A read or a delete failed: a broken file is recreated now, so the next call finds a base. */
  async #afterFailure(error: unknown): Promise<void> {
    const reason = resetReasonOf(error);
    if (reason === undefined) return;
    await this.#enqueue(() => this.#reset(reason, error)).catch(() => undefined);
  }

  // ---- delete, health, backup -----------------------------------------------------------------

  async deleteOlderThan(cutoffUnixNano: bigint): Promise<TelemetryDeleteResult> {
    if (typeof cutoffUnixNano !== 'bigint' || cutoffUnixNano < 0n) {
      throw new InvalidInput('cutoffUnixNano must be a bigint >= 0');
    }
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    await this.flush().catch(() => undefined);
    const cut = splitUnixNano(cutoffUnixNano);
    try {
      return await this.#enqueue(async () => {
        const conn = this.#conn;
        if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
        return conn.writer.transaction().execute(async (trx) => {
          const before = (ms: string, sub: string): RawBuilder<unknown> =>
            sql`${sql.ref(ms)} < ${cut.ms} or (${sql.ref(ms)} = ${cut.ms} and ${sql.ref(sub)} < ${cut.subNs})`;
          const spans =
            await sql`delete from spans where ${before('end_ms', 'end_sub_ns')}`.execute(trx);
          const metrics =
            await sql`delete from metric_points where ${before('time_ms', 'time_sub_ns')}`.execute(
              trx,
            );
          const logs =
            await sql`delete from log_records where ${before('time_ms', 'time_sub_ns')}`.execute(
              trx,
            );
          // A resource nothing refers to any more goes too.
          await sql`
            delete from resources
            where id not in (select resource_id from spans)
              and id not in (select resource_id from metric_points)
              and id not in (select resource_id from log_records)`.execute(trx);
          const count = (result: { numAffectedRows?: bigint | undefined }): number =>
            Number(result.numAffectedRows ?? 0n);
          return { spans: count(spans), metrics: count(metrics), logs: count(logs) };
        });
      });
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  // ---- size and compaction (port 0.4.0) ----------------------------------------------------------

  async footprint(): Promise<TelemetryFootprint> {
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    await this.flush().catch(() => undefined);
    try {
      return await this.#enqueue(async () => {
        const conn = this.#conn;
        if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
        const raw = conn.writerRaw;
        // What the log of the WAL holds is folded into the file first, so the size of the file is
        // the size of the data and not what happens to be waiting in the log. A reader that holds
        // the log makes this a partial checkpoint; that is not an error.
        try {
          raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
          // The sizes below are still right, only the file may look smaller than it will be.
        }
        const pageSize = Number(readPragma(raw, 'page_size'));
        const pages = Number(readPragma(raw, 'page_count'));
        const free = Number(readPragma(raw, 'freelist_count'));
        // The oldest raw record, by what `deleteOlderThan` compares (the end of a span).
        let oldestMs: number | null = null;
        for (const query of [
          'select min(end_ms) as ms from spans',
          'select min(time_ms) as ms from metric_points',
          'select min(time_ms) as ms from log_records',
        ]) {
          const [row] = raw.prepare(query).all([]) as { ms: number | null }[];
          if (row?.ms !== null && row?.ms !== undefined) {
            oldestMs = oldestMs === null ? row.ms : Math.min(oldestMs, row.ms);
          }
        }
        const main = await stat(this.config.path).then(
          (info) => info.size,
          () => null,
        );
        const wal = await stat(`${this.config.path}-wal`).then(
          (info) => info.size,
          () => 0,
        );
        const fileBytes = main === null ? null : main + wal;
        return {
          usedBytes: Math.max(0, pages - free) * pageSize,
          fileBytes,
          oldestUnixNano: oldestMs === null ? null : joinUnixNano(oldestMs, 0),
        };
      });
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async compact(): Promise<void> {
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    await this.flush().catch(() => undefined);
    try {
      await this.#enqueue(() => {
        const conn = this.#conn;
        if (conn === undefined) {
          return Promise.reject(new AdapterUnavailable('The telemetry base is not available'));
        }
        const raw = conn.writerRaw;
        if (Number(readPragma(raw, 'freelist_count')) === 0) return Promise.resolve();
        // VACUUM goes through the WAL: what it wrote is folded back, and the log truncated, so the
        // files really are smaller when it ends.
        raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        raw.exec('VACUUM');
        raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        return Promise.resolve();
      });
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async readCursor(name: string): Promise<number | null> {
    const key = cursorKey(name);
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    const conn = this.#conn;
    if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
    try {
      const row = await conn.reader
        .selectFrom('meta')
        .select('value')
        .where('key', '=', key)
        .executeTakeFirst();
      if (row === undefined) return null;
      const value = Number(row.value);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async writeCursor(name: string, value: number): Promise<void> {
    const key = cursorKey(name);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InvalidInput('a cursor must be an integer >= 0');
    }
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    // The cursor never runs ahead of the spans written before it.
    await this.flush();
    try {
      await this.#enqueue(async () => {
        const conn = this.#conn;
        if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
        await conn.writer
          .insertInto('meta')
          .values({ key, value: String(value) })
          .onConflict((conflict) => conflict.column('key').doUpdateSet({ value: String(value) }))
          .execute();
      });
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  // ---- the daily aggregates (port 0.3.0) --------------------------------------------------------

  async replaceRollupDay(day: string, rows: readonly RollupRow[]): Promise<void> {
    assertDay(day);
    const seen = new Set<string>();
    for (const row of rows) {
      assertRollupRow(row);
      if (row.day !== day)
        throw new InvalidInput(`a row of day ${row.day} cannot go in day ${day}`);
      const key = [row.scenarioId, row.executor, row.role, row.metric, row.facet, row.origin].join(
        '\u0000',
      );
      if (seen.has(key)) throw new InvalidInput('two rollup rows share one key');
      seen.add(key);
    }
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    try {
      await this.#enqueue(async () => {
        const conn = this.#conn;
        if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
        await conn.writer.transaction().execute(async (trx) => {
          await trx.deleteFrom('rollups_daily').where('day', '=', day).execute();
          for (let at = 0; at < rows.length; at += ROWS_PER_INSERT) {
            const part = rows.slice(at, at + ROWS_PER_INSERT).map(toRollupColumns);
            await trx.insertInto('rollups_daily').values(part).execute();
          }
        });
      });
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async readRollups(filter: RollupFilter = {}): Promise<readonly RollupRow[]> {
    if (filter.fromDay !== undefined) assertDay(filter.fromDay);
    if (filter.toDay !== undefined) assertDay(filter.toDay);
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    const conn = this.#conn;
    if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
    try {
      let query = conn.reader.selectFrom('rollups_daily').selectAll();
      if (filter.fromDay !== undefined) query = query.where('day', '>=', filter.fromDay);
      if (filter.toDay !== undefined) query = query.where('day', '<=', filter.toDay);
      if (filter.scenarioId !== undefined)
        query = query.where('scenario_id', '=', filter.scenarioId);
      if (filter.executor !== undefined) query = query.where('executor', '=', filter.executor);
      if (filter.role !== undefined) query = query.where('role', '=', filter.role);
      const rows = await query
        .orderBy('day')
        .orderBy('scenario_id')
        .orderBy('executor')
        .orderBy('role')
        .orderBy('metric')
        .orderBy('facet')
        .orderBy('origin')
        .execute();
      return rows.map((row) => ({
        day: row.day,
        scenarioId: row.scenario_id,
        executor: row.executor,
        role: row.role,
        metric: row.metric,
        facet: row.facet,
        origin: row.origin,
        count: row.count,
        sum: row.sum,
        p50: row.p50,
        p95: row.p95,
        max: row.max,
      }));
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async readRollupsReadyThrough(): Promise<string | null> {
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    const conn = this.#conn;
    if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
    try {
      const row = await conn.reader
        .selectFrom('meta')
        .select('value')
        .where('key', '=', ROLLUPS_READY_KEY)
        .executeTakeFirst();
      return row !== undefined && ROLLUP_DAY_PATTERN.test(row.value) ? row.value : null;
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async markRollupsReady(day: string): Promise<void> {
    assertDay(day);
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    try {
      await this.#enqueue(async () => {
        const conn = this.#conn;
        if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
        // The day strings sort as dates, so "keep the later one" is a string comparison.
        await sql`
          insert into meta (key, value) values (${ROLLUPS_READY_KEY}, ${day})
          on conflict (key) do update set value = excluded.value
          where excluded.value > meta.value`.execute(conn.writer);
      });
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async deleteRollupsBefore(day: string): Promise<number> {
    assertDay(day);
    if (this.#closed) throw new AdapterUnavailable('The telemetry store is closed');
    try {
      return await this.#enqueue(async () => {
        const conn = this.#conn;
        if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
        const result = await conn.writer
          .deleteFrom('rollups_daily')
          .where('day', '<', day)
          .execute();
        return Number(result[0]?.numDeletedRows ?? 0n);
      });
    } catch (error) {
      await this.#afterFailure(error);
      throw toTelemetryError(error);
    }
  }

  async health(): Promise<TelemetryHealth> {
    let fileBytes: number | null = null;
    if (this.#conn !== undefined) {
      fileBytes = await stat(this.config.path).then(
        (info) => info.size,
        () => null,
      );
    }
    return {
      state: this.#state,
      queued: this.#queue.length,
      written: this.#written,
      droppedOverflow: this.#droppedOverflow,
      discarded: this.#discarded,
      resets: this.#resets,
      fileBytes,
    };
  }

  /** What the write connection reports for the settings this adapter applies. */
  diagnostics(): Promise<SqliteTelemetryDiagnostics> {
    return this.#enqueue(() => {
      const conn = this.#conn;
      if (conn === undefined) {
        return Promise.reject(new AdapterUnavailable('The telemetry base is not available'));
      }
      const db = conn.writerRaw;
      return Promise.resolve({
        driver: this.config.driver,
        journalMode: String(readPragma(db, 'journal_mode')),
        synchronous: Number(readPragma(db, 'synchronous')),
        busyTimeoutMs: Number(readPragma(db, 'busy_timeout')),
      });
    });
  }

  /**
   * Consistent copy of the base into `destPath` (SQLite's backup API), after the queue is written.
   * Used by `backup.telemetry: include`. Rejects with `AdapterUnavailable` when there is no base.
   */
  async backupTo(destPath: string): Promise<void> {
    await this.flush().catch(() => undefined);
    await this.#enqueue(async () => {
      const conn = this.#conn;
      if (conn === undefined) throw new AdapterUnavailable('The telemetry base is not available');
      try {
        await conn.writerRaw.backupTo(destPath, { pagesPerStep: ALL_PAGES_IN_ONE_STEP });
      } catch (error) {
        throw toTelemetryError(error);
      }
    });
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.flush().catch(() => undefined);
    await this.#enqueue(() => this.#disconnect());
  }

  // ---- connections, reset ---------------------------------------------------------------------

  /** Connects, or recreates the base, or gives up: never throws. Runs inside the queue or at open. */
  async #establish(): Promise<boolean> {
    try {
      this.#conn = await this.#connect();
      this.#state = 'ok';
      this.#noBaseSince = undefined;
      return true;
    } catch (error) {
      const reason = resetReasonOf(error);
      if (reason !== undefined && this.#resetsInARow < MAX_RESETS_IN_A_ROW) {
        return this.#reset(reason, error);
      }
      this.#giveUp(reason ?? 'io_error', error, null);
      return false;
    }
  }

  async #reset(reason: ResetReason, error: unknown): Promise<boolean> {
    await this.#disconnect();
    if (this.#resetsInARow >= MAX_RESETS_IN_A_ROW) {
      this.#giveUp(reason, error, null);
      return false;
    }
    this.#resetsInARow += 1;
    let broken: string | null;
    try {
      broken = await this.#moveAside();
    } catch (moveError) {
      this.#giveUp(reason, moveError, null);
      return false;
    }
    try {
      this.#conn = await this.#connect();
    } catch (connectError) {
      this.#giveUp(reason, connectError, broken);
      return false;
    }
    this.#resets += 1;
    this.#state = 'ok';
    this.#noBaseSince = undefined;
    this.#tell({ reason, outcome: 'recreated', brokenFile: broken, error: message(error) });
    return true;
  }

  #giveUp(reason: TelemetryResetReason, error: unknown, brokenFile: string | null): void {
    const wasOut = this.#state === 'no_base';
    this.#state = 'no_base';
    this.#noBaseSince = this.#deps.clock.now();
    this.#lastReason = reason;
    if (!wasOut) {
      this.#tell({ reason, outcome: 'unavailable', brokenFile, error: message(error) });
    }
  }

  #tell(info: Omit<TelemetryResetInfo, 'resets'>): void {
    try {
      this.#deps.onReset?.({ ...info, resets: this.#resets });
    } catch {
      // The daemon's report must never break the telemetry path.
    }
  }

  /** With no base, the first write after `retryAfterMs` tries to open it again, in the background. */
  #maybeRecover(): void {
    if (this.#recovering || this.#noBaseSince === undefined) return;
    if (this.#deps.clock.now() - this.#noBaseSince < this.config.retryAfterMs) return;
    this.#recovering = true;
    this.#enqueue(async () => {
      if (this.#state !== 'no_base' || this.#closed) return;
      const resetsBefore = this.#resets;
      const reason = this.#lastReason;
      this.#noBaseSince = this.#deps.clock.now();
      if ((await this.#establish()) && this.#resets === resetsBefore) {
        // The old file opened as it was (or there was none): the base is back.
        this.#tell({
          reason,
          outcome: 'recreated',
          brokenFile: null,
          error: 'base available again',
        });
      }
    })
      .catch(() => undefined)
      .finally(() => {
        this.#recovering = false;
      });
  }

  /** Renames the file and its `-wal` and `-shm` to `<file>.broken-<date>`; returns the new name. */
  async #moveAside(): Promise<string | null> {
    const { path } = this.config;
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) return null;
    const base = `${path}.broken-${utcStamp(this.#deps.clock.now())}`;
    let target = base;
    for (
      let n = 1;
      await stat(target).then(
        () => true,
        () => false,
      );
      n += 1
    ) {
      target = `${base}-${String(n)}`;
    }
    await rename(path, target);
    for (const suffix of ['-wal', '-shm']) {
      await rename(`${path}${suffix}`, `${target}${suffix}`).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    return target;
  }

  async #connect(): Promise<Connections> {
    const { path, driver, busyTimeoutMs } = this.config;
    let writerRaw: RawDatabase | undefined;
    let readerRaw: RawDatabase | undefined;
    let writer: Kysely<TelemetryDatabase> | undefined;
    let reader: Kysely<TelemetryDatabase> | undefined;
    try {
      await mkdir(dirname(path), { recursive: true });
      writerRaw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs });
      for (const pragma of writerPragmas(this.config)) writerRaw.exec(pragma);
      const journalMode = readPragma(writerRaw, 'journal_mode');
      if (journalMode !== 'wal') {
        throw new AdapterUnavailable(
          `Could not switch the telemetry database to WAL mode (journal_mode is ${String(journalMode)})`,
        );
      }
      writer = new Kysely<TelemetryDatabase>({
        dialect: new ImmediateSqliteDialect({ database: writerRaw }),
      });
      await migrateToLatest(writer);
      await sql`insert into meta (key, value) values ('port_version', ${TELEMETRY_STORE_PORT_VERSION})
        on conflict (key) do update set value = excluded.value`.execute(writer);

      readerRaw = await openRawDatabase(driver, path, { readonly: true, busyTimeoutMs });
      readerRaw.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
      reader = new Kysely<TelemetryDatabase>({
        dialect: new SqliteDialect({ database: readerRaw }),
      });
      return { writerRaw, readerRaw, writer, reader };
    } catch (error) {
      await Promise.allSettled([writer?.destroy(), reader?.destroy()]);
      readerRaw?.close();
      writerRaw?.close();
      throw isOTheaterError(error) && resetReasonOf(error) === undefined ? error : error;
    }
  }

  async #disconnect(): Promise<void> {
    const conn = this.#conn;
    this.#conn = undefined;
    if (conn === undefined) return;
    await Promise.allSettled([conn.writer.destroy(), conn.reader.destroy()]);
    conn.readerRaw.close();
    conn.writerRaw.close();
  }
}

/**
 * Copies a telemetry file that nobody has open (or that a daemon in another process owns: the copy
 * reads a consistent snapshot) into `destPath`. Resolves `false` when there is no file to copy.
 * Used by `ot backup` with `backup.telemetry: include`.
 */
export async function backupTelemetryFile(input: {
  readonly path: string;
  readonly destPath: string;
  readonly driver?: SqliteDriverName | undefined;
}): Promise<boolean> {
  const exists = await stat(input.path).then(
    () => true,
    () => false,
  );
  if (!exists) return false;
  const db = await openRawDatabase(input.driver ?? 'better-sqlite3', input.path, {
    readonly: true,
    busyTimeoutMs: 5000,
  });
  try {
    await db.backupTo(input.destPath, { pagesPerStep: ALL_PAGES_IN_ONE_STEP });
  } catch (error) {
    throw toTelemetryError(error);
  } finally {
    db.close();
  }
  return true;
}
