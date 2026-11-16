// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  SqliteStore,
  type SqliteDriverName,
  type SqliteSynchronousMode,
} from '@otheater/adapter-store-sqlite';
import { DRIVERS, systemClock, type Deadline, type Log } from './common.js';
import { at, maxOf, median, round, summarize, type Summary } from './stats.js';
import { createRng, payloadPool } from './workload.js';

export const BATCH_SIZES = [1, 10] as const;
export const SYNCHRONOUS_MODES: readonly SqliteSynchronousMode[] = ['full', 'normal'];

export interface ScenarioAOptions {
  readonly dir: string;
  readonly repetitions: number;
  /** Per run: stop after this many transactions... */
  readonly maxTransactions: number;
  /** ...or after this many milliseconds, whichever comes first. */
  readonly maxMs: number;
  readonly payloadBytes: number;
  readonly deadline: Deadline;
  readonly log: Log;
}

export interface RunA {
  readonly driver: SqliteDriverName;
  readonly synchronous: SqliteSynchronousMode;
  readonly eventsPerTransaction: number;
  readonly repetition: number;
  readonly transactions: number;
  readonly stoppedBy: 'transactions' | 'time';
  readonly elapsedMs: number;
  readonly transactionsPerSecond: number;
  readonly eventsPerSecond: number;
  /** Latency of one transaction (call to commit), milliseconds. */
  readonly latencyMs: Summary;
  /** What SQLite reported for the write connection, to prove the pragma took effect. */
  readonly journalMode: string;
  /** `PRAGMA synchronous` as a number: 1 NORMAL, 2 FULL. */
  readonly synchronousPragma: number;
}

export interface SummaryA {
  readonly driver: SqliteDriverName;
  readonly synchronous: SqliteSynchronousMode;
  readonly eventsPerTransaction: number;
  readonly runs: number;
  /** Medians over the repetitions, except `maxMs` (the worst over the repetitions). */
  readonly transactionsPerSecond: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface RatioA {
  readonly driver: SqliteDriverName;
  readonly eventsPerTransaction: number;
  /** FULL tx/s divided by NORMAL tx/s (below 1: FULL is slower). */
  readonly throughput: number;
  /** FULL p99 divided by NORMAL p99 (above 1: FULL is slower). */
  readonly p99: number;
}

export interface ResultA {
  readonly config: {
    readonly repetitions: number;
    readonly maxTransactions: number;
    readonly maxMs: number;
    readonly payloadBytes: number;
    readonly warmupTransactions: number;
  };
  readonly runs: readonly RunA[];
  readonly summary: readonly SummaryA[];
  readonly ratios: readonly RatioA[];
  readonly skipped: number;
}

const WARMUP_TRANSACTIONS = 50;

async function runOne(
  options: ScenarioAOptions,
  driver: SqliteDriverName,
  synchronous: SqliteSynchronousMode,
  eventsPerTransaction: number,
  repetition: number,
  payloads: readonly string[],
): Promise<RunA> {
  const path = join(options.dir, `a-${driver}-${synchronous}-${String(eventsPerTransaction)}.db`);
  const store = await SqliteStore.open({ path, driver, synchronous }, systemClock);
  try {
    const diagnostics = await store.diagnostics();
    let counter = 0;
    const transaction = async (): Promise<void> => {
      await store.transaction(async (tx) => {
        for (let k = 0; k < eventsPerTransaction; k++) {
          const n = counter++;
          await tx.events.append({
            type: 'bench.event',
            schemaVersion: 1,
            payload: { n, text: at(payloads, n % payloads.length) },
          });
        }
      });
    };
    for (let i = 0; i < WARMUP_TRANSACTIONS; i++) await transaction();

    const latencies: number[] = [];
    const started = performance.now();
    let stoppedBy: RunA['stoppedBy'] = 'transactions';
    while (latencies.length < options.maxTransactions) {
      if (performance.now() - started >= options.maxMs) {
        stoppedBy = 'time';
        break;
      }
      const begin = performance.now();
      await transaction();
      latencies.push(performance.now() - begin);
    }
    const elapsedMs = performance.now() - started;
    const seconds = elapsedMs / 1000;
    return {
      driver,
      synchronous,
      eventsPerTransaction,
      repetition,
      transactions: latencies.length,
      stoppedBy,
      elapsedMs: round(elapsedMs, 1),
      transactionsPerSecond: round(latencies.length / seconds, 1),
      eventsPerSecond: round((latencies.length * eventsPerTransaction) / seconds, 1),
      latencyMs: roundSummary(summarize(latencies)),
      journalMode: diagnostics.journalMode,
      synchronousPragma: diagnostics.synchronous,
    };
  } finally {
    await store.close();
    await Promise.all(
      ['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })),
    );
  }
}

function roundSummary(summary: Summary): Summary {
  return {
    count: summary.count,
    mean: round(summary.mean),
    min: round(summary.min),
    p50: round(summary.p50),
    p95: round(summary.p95),
    p99: round(summary.p99),
    max: round(summary.max),
  };
}

export function summarizeA(runs: readonly RunA[]): { summary: SummaryA[]; ratios: RatioA[] } {
  const summary: SummaryA[] = [];
  for (const driver of DRIVERS) {
    for (const eventsPerTransaction of BATCH_SIZES) {
      for (const synchronous of SYNCHRONOUS_MODES) {
        const group = runs.filter(
          (run) =>
            run.driver === driver &&
            run.synchronous === synchronous &&
            run.eventsPerTransaction === eventsPerTransaction,
        );
        if (group.length === 0) continue;
        summary.push({
          driver,
          synchronous,
          eventsPerTransaction,
          runs: group.length,
          transactionsPerSecond: round(median(group.map((r) => r.transactionsPerSecond)), 1),
          p50Ms: round(median(group.map((r) => r.latencyMs.p50))),
          p95Ms: round(median(group.map((r) => r.latencyMs.p95))),
          p99Ms: round(median(group.map((r) => r.latencyMs.p99))),
          maxMs: round(maxOf(group.map((r) => r.latencyMs.max))),
        });
      }
    }
  }
  const ratios: RatioA[] = [];
  for (const driver of DRIVERS) {
    for (const eventsPerTransaction of BATCH_SIZES) {
      const find = (mode: SqliteSynchronousMode): SummaryA | undefined =>
        summary.find(
          (s) =>
            s.driver === driver &&
            s.eventsPerTransaction === eventsPerTransaction &&
            s.synchronous === mode,
        );
      const full = find('full');
      const normal = find('normal');
      if (full === undefined || normal === undefined) continue;
      ratios.push({
        driver,
        eventsPerTransaction,
        throughput: round(full.transactionsPerSecond / normal.transactionsPerSecond, 3),
        p99: round(full.p99Ms / normal.p99Ms, 3),
      });
    }
  }
  return { summary, ratios };
}

/** Scenario A: cost of `synchronous=FULL` against `NORMAL`, WAL, one writer, no concurrency. */
export async function runScenarioA(options: ScenarioAOptions): Promise<ResultA> {
  const payloads = payloadPool(createRng(1), options.payloadBytes, 64);
  const runs: RunA[] = [];
  let skipped = 0;
  // Repetitions are the outer loop, so slow drift of the machine hits every combination alike.
  for (let repetition = 1; repetition <= options.repetitions; repetition++) {
    for (const driver of DRIVERS) {
      for (const eventsPerTransaction of BATCH_SIZES) {
        for (const synchronous of SYNCHRONOUS_MODES) {
          if (options.deadline.expired) {
            skipped++;
            continue;
          }
          const run = await runOne(
            options,
            driver,
            synchronous,
            eventsPerTransaction,
            repetition,
            payloads,
          );
          runs.push(run);
          options.log(
            `A rep ${String(repetition)} ${driver} ${synchronous} x${String(eventsPerTransaction)}: ` +
              `${String(run.transactionsPerSecond)} tx/s, p99 ${String(run.latencyMs.p99)} ms ` +
              `(${String(run.transactions)} tx, stopped by ${run.stoppedBy})`,
          );
        }
      }
    }
  }
  return {
    config: {
      repetitions: options.repetitions,
      maxTransactions: options.maxTransactions,
      maxMs: options.maxMs,
      payloadBytes: options.payloadBytes,
      warmupTransactions: WARMUP_TRANSACTIONS,
    },
    runs,
    ...summarizeA(runs),
    skipped,
  };
}
