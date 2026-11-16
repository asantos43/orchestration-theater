// SPDX-License-Identifier: MPL-2.0
import { copyFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  backupDatabase,
  DEFAULT_BACKUP_TIMEOUT_MS,
  SqliteStore,
  type BackupOptions,
  type SqliteDriverName,
} from '@otheater/adapter-store-sqlite';
import { DRIVERS, scrub, systemClock, type Deadline, type Log } from './common.js';
import { at, maxOf, median, round, summarize } from './stats.js';
import { createRng, payloadPool, variedPayloadPool } from './workload.js';

export interface MethodSpec {
  readonly id: string;
  readonly label: string;
  readonly backup: BackupOptions;
}

export const METHODS: readonly MethodSpec[] = [
  { id: 'online-single', label: 'online_api, 1 step', backup: { method: 'online_api' } },
  {
    id: 'online-100',
    label: 'online_api, 100 pages/step',
    backup: { method: 'online_api', pagesPerStep: 100 },
  },
  {
    id: 'online-1000',
    label: 'online_api, 1000 pages/step',
    backup: { method: 'online_api', pagesPerStep: 1000 },
  },
  { id: 'vacuum', label: 'vacuum_into', backup: { method: 'vacuum_into' } },
];

export interface SizeSpec {
  readonly id: string;
  readonly targetBytes: number;
}

export const SIZES: readonly SizeSpec[] = [
  { id: '10MB', targetBytes: 10_000_000 },
  { id: '100MB', targetBytes: 100_000_000 },
];

/** The writer sleeps this long between transactions (one event each), like a busy daemon. */
export const WRITER_INTERVAL_MS = 5;
/** Hard ceiling on the writer's transactions in one run. */
export const WRITER_MAX_TRANSACTIONS = 20_000;
/** Time the writer runs alone before the backup starts, so it is in steady state. */
const WRITER_LEAD_IN_MS = 50;
const EVENTS_PER_FILL_TRANSACTION = 1000;
const FILL_PAYLOAD_MIN_BYTES = 200;
const FILL_PAYLOAD_MAX_BYTES = 2000;
const WRITER_PAYLOAD_BYTES = 200;

export interface ScenarioBOptions {
  readonly dir: string;
  readonly sizes: readonly SizeSpec[];
  readonly repetitions: number;
  readonly deadline: Deadline;
  readonly log: Log;
  /** Strings to hide from error messages that enter the report. */
  readonly secrets: readonly string[];
}

export interface WriterStats {
  /** Transactions that committed while the backup was running. */
  readonly transactions: number;
  readonly transactionsPerSecond: number;
  /** Time from calling `store.transaction` to its commit. */
  readonly latencyMaxMs: number;
  readonly latencyP99Ms: number;
  /** How late the 5 ms timer fired: the event loop was busy (or the timer was starved). */
  readonly wakeLatenessMaxMs: number;
  readonly wakeLatenessP99Ms: number;
  readonly errors: number;
}

export interface RunB {
  readonly driver: SqliteDriverName;
  readonly size: string;
  readonly dbBytes: number;
  readonly dbEvents: number;
  readonly writer: boolean;
  readonly method: string;
  readonly repetition: number;
  /** `finished`; `transient` (the adapter gave up, see {@link BackupOptions.timeoutMs}); `failed`. */
  readonly outcome: 'finished' | 'transient' | 'failed';
  readonly error: string | undefined;
  /** Wall time of the `backupDatabase` call, copy plus its integrity check. */
  readonly durationMs: number;
  readonly restarts: number | undefined;
  readonly backupBytes: number | undefined;
  /** `monitorEventLoopDelay` (1 ms sampling: an idle loop reads about 1 ms) during the call. */
  readonly eventLoop: {
    readonly maxMs: number;
    readonly p99Ms: number;
    readonly p50Ms: number;
    readonly samples: number;
  };
  readonly writerStats: WriterStats | undefined;
  /** `PRAGMA integrity_check` on the finished copy in a separate pass (`node:sqlite`). */
  readonly integrityCheckMs: number | undefined;
}

export interface SummaryB {
  readonly driver: SqliteDriverName;
  readonly size: string;
  readonly dbBytes: number;
  readonly writer: boolean;
  readonly method: string;
  readonly runs: number;
  readonly finished: number;
  readonly transient: number;
  readonly failed: number;
  /** Medians over the finished runs, except the `max*` fields (worst over all runs). */
  readonly durationMs: number | undefined;
  readonly eventLoopMaxMs: number;
  readonly eventLoopP99Ms: number;
  readonly writerTransactions: number | undefined;
  readonly writerLatencyMaxMs: number | undefined;
  readonly writerWakeLatenessMaxMs: number | undefined;
  readonly restartsMedian: number | undefined;
  readonly restartsMax: number | undefined;
  readonly backupBytes: number | undefined;
  readonly integrityCheckMs: number | undefined;
}

export interface ResultB {
  readonly config: {
    readonly repetitions: number;
    readonly sizes: readonly string[];
    readonly writerIntervalMs: number;
    readonly writerMaxTransactions: number;
    readonly writerPayloadBytes: number;
    readonly fillPayloadBytes: string;
    readonly backupTimeoutMs: number;
  };
  readonly databases: readonly {
    readonly size: string;
    readonly bytes: number;
    readonly events: number;
  }[];
  readonly runs: readonly RunB[];
  readonly summary: readonly SummaryB[];
  readonly skipped: number;
}

interface BaseDatabase {
  readonly spec: SizeSpec;
  readonly path: string;
  readonly bytes: number;
  readonly events: number;
}

async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all(
    ['', '-wal', '-shm', '-journal', '.partial', '.partial-wal', '.partial-shm'].map((suffix) =>
      rm(`${path}${suffix}`, { force: true }),
    ),
  );
}

/**
 * Fills a database with events (varied payloads of 200 to 2000 bytes) in large transactions
 * until the file reaches `spec.targetBytes`. The store is closed at the end: the file is whole
 * (no `-wal`), so it can be copied as a plain file.
 */
async function buildBase(options: ScenarioBOptions, spec: SizeSpec): Promise<BaseDatabase> {
  const path = join(options.dir, `base-${spec.id}.db`);
  const rng = createRng(2);
  const payloads = variedPayloadPool(rng, FILL_PAYLOAD_MIN_BYTES, FILL_PAYLOAD_MAX_BYTES, 256);
  const averagePayload = (FILL_PAYLOAD_MIN_BYTES + FILL_PAYLOAD_MAX_BYTES) / 2;
  // Row = payload + columns + four index entries; an estimate that the loop below corrects.
  let bytesPerEvent = averagePayload + 160;
  let events = 0;
  let bytes = 0;
  for (let round_ = 0; round_ < 8 && bytes < spec.targetBytes * 0.98; round_++) {
    const store = await SqliteStore.open(
      { path, driver: 'better-sqlite3', synchronous: 'normal' },
      systemClock,
    );
    try {
      const wanted = Math.ceil((spec.targetBytes - bytes) / bytesPerEvent);
      const chunks = Math.max(1, Math.ceil(wanted / EVENTS_PER_FILL_TRANSACTION));
      for (let chunk = 0; chunk < chunks; chunk++) {
        await store.transaction(async (tx) => {
          for (let k = 0; k < EVENTS_PER_FILL_TRANSACTION; k++) {
            const n = events++;
            await tx.events.append({
              type: 'bench.chunk',
              schemaVersion: 1,
              scenarioId: `scenario-${String(n % 40)}`,
              playId: `play-${String(n % 400)}`,
              payload: { n, text: at(payloads, n % payloads.length) },
            });
          }
        });
      }
    } finally {
      await store.close();
    }
    const before = bytes;
    bytes = (await stat(path)).size;
    if (events > 0 && bytes > before) bytesPerEvent = bytes / events;
  }
  const leftover = await stat(`${path}-wal`).catch(() => undefined);
  if (leftover !== undefined && leftover.size > 0) {
    throw new Error('The base database kept a non-empty -wal file after closing; cannot copy it');
  }
  options.log(`B base ${spec.id}: ${String(events)} events, ${String(bytes)} bytes`);
  return { spec, path, bytes, events };
}

interface WriterSample {
  readonly endedAt: number;
  readonly latencyMs: number;
  readonly lateMs: number;
}

/** One event per transaction every ~5 ms, in this process, until stopped (or the ceiling). */
function startWriter(
  store: SqliteStore,
  payloads: readonly string[],
): { stop: () => Promise<{ samples: WriterSample[]; errors: number }> } {
  const samples: WriterSample[] = [];
  let errors = 0;
  const state = { stopped: false };
  const isStopped = (): boolean => state.stopped;
  const loop = (async () => {
    for (let n = 0; !state.stopped && n < WRITER_MAX_TRANSACTIONS; n++) {
      const due = performance.now() + WRITER_INTERVAL_MS;
      await sleep(WRITER_INTERVAL_MS);
      const woke = performance.now();
      if (isStopped()) break;
      try {
        await store.transaction((tx) =>
          tx.events.append({
            type: 'bench.live',
            schemaVersion: 1,
            payload: { n, text: at(payloads, n % payloads.length) },
          }),
        );
        const ended = performance.now();
        samples.push({ endedAt: ended, latencyMs: ended - woke, lateMs: Math.max(0, woke - due) });
      } catch {
        errors++;
      }
    }
  })();
  return {
    stop: async () => {
      state.stopped = true;
      await loop;
      return { samples, errors };
    },
  };
}

/** `PRAGMA integrity_check` time on a finished copy, with `node:sqlite` (same SQLite engine). */
async function timeIntegrityCheck(path: string): Promise<number> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const begin = performance.now();
    db.prepare('PRAGMA integrity_check').all();
    return performance.now() - begin;
  } finally {
    db.close();
  }
}

async function runOne(
  options: ScenarioBOptions,
  base: BaseDatabase,
  driver: SqliteDriverName,
  writer: boolean,
  method: MethodSpec,
  repetition: number,
  writerPayloads: readonly string[],
): Promise<RunB> {
  const workPath = join(options.dir, `work-${driver}.db`);
  const backupPath = join(options.dir, `backup-${driver}.db`);
  await removeDatabaseFiles(workPath);
  await removeDatabaseFiles(backupPath);
  await copyFile(base.path, workPath);
  // The store opens as the daemon would: FULL, WAL.
  const store = await SqliteStore.open({ path: workPath, driver }, systemClock);
  try {
    const live = writer ? startWriter(store, writerPayloads) : undefined;
    if (live !== undefined) await sleep(WRITER_LEAD_IN_MS);

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const begin = performance.now();
    let outcome: RunB['outcome'] = 'finished';
    let error: string | undefined;
    let restarts: number | undefined;
    let backupBytes: number | undefined;
    try {
      const result = await backupDatabase({
        ...method.backup,
        driver,
        sourcePath: workPath,
        destPath: backupPath,
      });
      restarts = result.restarts;
      backupBytes = result.bytes;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      outcome = caught instanceof Error && caught.name === 'Transient' ? 'transient' : 'failed';
      error = scrub(
        `${caught instanceof Error ? caught.name : 'Error'}: ${message}`,
        options.secrets,
      );
      const found = /\((\d+) restarts\)/.exec(message);
      if (found?.[1] !== undefined) restarts = Number(found[1]);
    }
    const end = performance.now();
    histogram.disable();

    let writerStats: WriterStats | undefined;
    if (live !== undefined) {
      const { samples, errors } = await live.stop();
      const inside = samples.filter((s) => s.endedAt >= begin && s.endedAt <= end);
      const latencies = inside.map((s) => s.latencyMs);
      const lates = inside.map((s) => s.lateMs);
      writerStats =
        inside.length === 0
          ? {
              transactions: 0,
              transactionsPerSecond: 0,
              latencyMaxMs: 0,
              latencyP99Ms: 0,
              wakeLatenessMaxMs: 0,
              wakeLatenessP99Ms: 0,
              errors,
            }
          : {
              transactions: inside.length,
              transactionsPerSecond: round(inside.length / ((end - begin) / 1000), 1),
              latencyMaxMs: round(summarize(latencies).max),
              latencyP99Ms: round(summarize(latencies).p99),
              wakeLatenessMaxMs: round(summarize(lates).max),
              wakeLatenessP99Ms: round(summarize(lates).p99),
              errors,
            };
    }

    let integrityCheckMs: number | undefined;
    if (outcome === 'finished') integrityCheckMs = round(await timeIntegrityCheck(backupPath), 1);

    return {
      driver,
      size: base.spec.id,
      dbBytes: base.bytes,
      dbEvents: base.events,
      writer,
      method: method.id,
      repetition,
      outcome,
      error,
      durationMs: round(end - begin, 1),
      restarts,
      backupBytes,
      eventLoop: {
        maxMs: round(histogram.max / 1e6),
        p99Ms: round(histogram.percentile(99) / 1e6),
        p50Ms: round(histogram.percentile(50) / 1e6),
        samples: histogram.count,
      },
      writerStats,
      integrityCheckMs,
    };
  } finally {
    await store.close();
    await removeDatabaseFiles(workPath);
    await removeDatabaseFiles(backupPath);
  }
}

function medianOrUndefined(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : round(median(values), 1);
}

function maxOrUndefined(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : maxOf(values);
}

export function summarizeB(runs: readonly RunB[]): SummaryB[] {
  const summary: SummaryB[] = [];
  const sizes = [...new Set(runs.map((r) => r.size))];
  for (const size of sizes) {
    for (const writer of [false, true]) {
      for (const method of METHODS) {
        for (const driver of DRIVERS) {
          const group = runs.filter(
            (r) =>
              r.size === size &&
              r.writer === writer &&
              r.method === method.id &&
              r.driver === driver,
          );
          const first = group[0];
          if (first === undefined) continue;
          const done = group.filter((r) => r.outcome === 'finished');
          const stats = group.flatMap((r) => (r.writerStats === undefined ? [] : [r.writerStats]));
          const restarts = group.flatMap((r) => (r.restarts === undefined ? [] : [r.restarts]));
          summary.push({
            driver,
            size,
            dbBytes: first.dbBytes,
            writer,
            method: method.id,
            runs: group.length,
            finished: done.length,
            transient: group.filter((r) => r.outcome === 'transient').length,
            failed: group.filter((r) => r.outcome === 'failed').length,
            durationMs: medianOrUndefined(done.map((r) => r.durationMs)),
            eventLoopMaxMs: maxOf(group.map((r) => r.eventLoop.maxMs)),
            eventLoopP99Ms: round(median(group.map((r) => r.eventLoop.p99Ms))),
            writerTransactions: medianOrUndefined(stats.map((s) => s.transactions)),
            writerLatencyMaxMs: maxOrUndefined(stats.map((s) => s.latencyMaxMs)),
            writerWakeLatenessMaxMs: maxOrUndefined(stats.map((s) => s.wakeLatenessMaxMs)),
            restartsMedian: medianOrUndefined(restarts),
            restartsMax: maxOrUndefined(restarts),
            backupBytes: medianOrUndefined(
              done.flatMap((r) => (r.backupBytes === undefined ? [] : [r.backupBytes])),
            ),
            integrityCheckMs: medianOrUndefined(
              done.flatMap((r) => (r.integrityCheckMs === undefined ? [] : [r.integrityCheckMs])),
            ),
          });
        }
      }
    }
  }
  return summary;
}

/** Scenario B: how the backup methods behave on a database of ~10 MB and ~100 MB. */
export async function runScenarioB(options: ScenarioBOptions): Promise<ResultB> {
  const writerPayloads = payloadPool(createRng(3), WRITER_PAYLOAD_BYTES, 64);
  const bases: BaseDatabase[] = [];
  const runs: RunB[] = [];
  let skipped = 0;
  try {
    for (const spec of options.sizes) bases.push(await buildBase(options, spec));
    // Repetitions outermost, so drift of the machine hits every combination alike.
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      for (const base of bases) {
        for (const driver of DRIVERS) {
          for (const writer of [false, true]) {
            for (const method of METHODS) {
              if (options.deadline.expired) {
                skipped++;
                continue;
              }
              const run = await runOne(
                options,
                base,
                driver,
                writer,
                method,
                repetition,
                writerPayloads,
              );
              runs.push(run);
              options.log(
                `B rep ${String(repetition)} ${base.spec.id} ${driver} ${writer ? 'writer' : 'idle  '} ` +
                  `${method.id}: ${run.outcome} in ${String(run.durationMs)} ms, loop max ` +
                  `${String(run.eventLoop.maxMs)} ms` +
                  (run.writerStats === undefined
                    ? ''
                    : `, writer ${String(run.writerStats.transactions)} tx`) +
                  (run.restarts === undefined ? '' : `, ${String(run.restarts)} restarts`),
              );
            }
          }
        }
      }
    }
  } finally {
    for (const base of bases) await removeDatabaseFiles(base.path);
  }
  return {
    config: {
      repetitions: options.repetitions,
      sizes: options.sizes.map((s) => s.id),
      writerIntervalMs: WRITER_INTERVAL_MS,
      writerMaxTransactions: WRITER_MAX_TRANSACTIONS,
      writerPayloadBytes: WRITER_PAYLOAD_BYTES,
      fillPayloadBytes: `${String(FILL_PAYLOAD_MIN_BYTES)}-${String(FILL_PAYLOAD_MAX_BYTES)}`,
      backupTimeoutMs: DEFAULT_BACKUP_TIMEOUT_MS,
    },
    databases: bases.map((b) => ({ size: b.spec.id, bytes: b.bytes, events: b.events })),
    runs,
    summary: summarizeB(runs),
    skipped,
  };
}
