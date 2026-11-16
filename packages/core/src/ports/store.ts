// SPDX-License-Identifier: MPL-2.0
import type { EventLog } from './event-log.js';

/** Semver of the `Store` port contract. */
export const STORE_PORT_VERSION = '0.1.0';

/**
 * What a transaction body can touch. Aggregates (plays, demands, directives, ...) join it as the
 * phases that need them arrive; for now the only transactional resource is the event log, so the
 * domain can change state and record the event in one atomic step.
 */
export interface StoreTransaction {
  readonly events: EventLog;
}

/**
 * Persistence and transactions (architecture 5.18 and section 7). The rest of the daemon never
 * sees SQL: the default adapter is SQLite + Kysely (step 4), the test adapter is in memory.
 *
 * Contract (checked by `describeStoreConformance` in `@otheater/sdk`):
 * - `transaction(fn)` commits when `fn` resolves and returns its value. When `fn` rejects it rolls
 *   back everything done through `tx` and rethrows **the same error object** (typed errors cross
 *   the port untouched).
 * - Transactions are serialized, in call order: the body of one never runs concurrently with
 *   another. There is no nesting: the `tx` handle has no `transaction` method.
 * - Read-your-writes inside `fn`; outside it, only committed data is visible, and a transaction
 *   becomes visible all at once (never half of its events).
 * - Using `tx` after `fn` settled is a programming error and rejects with `Conflict`.
 * - `events` is the same log outside a transaction: each call there is its own transaction.
 * - After `close()` every operation rejects with `AdapterUnavailable`; `close()` is idempotent and
 *   waits for the transaction in flight.
 */
export interface Store {
  readonly events: EventLog;

  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * Outcome of {@link StoreMaintenance.backup}, neutral about the adapter. [proposta] The shape is
 * what the SQLite adapter already reports, so the daemon can log and record it without knowing
 * which store made the copy.
 */
export interface StoreBackupResult {
  /** Absolute path of the finished copy. */
  readonly path: string;
  readonly bytes: number;
  /** Name of the method the adapter used (`online_api`, `vacuum_into`...). */
  readonly method: string;
  readonly durationMs: number;
  /** Times an online copy started over because the store changed under it (0 when none). */
  readonly restarts: number;
}

/** Options of {@link StoreMaintenance.backup}; every adapter documents the names it accepts. */
export interface StoreBackupOptions {
  /** Adapter-specific method name. An unknown name rejects with `InvalidInput`. */
  readonly method?: string;
  /**
   * Adapter-specific: pages copied per step by an online copy. Omitted means the adapter's own
   * default (the SQLite adapter copies everything in one step). An adapter or method without
   * steps ignores it.
   */
  readonly pagesPerStep?: number;
}

/**
 * Optional capability of a `Store`: maintenance that only a real database offers (architecture
 * 5.21). It is **not** part of the `Store` port, so `STORE_PORT_VERSION` does not change and the
 * in-memory store simply does not have it. The daemon asks with {@link hasStoreMaintenance}.
 *
 * - `quickCheck()` is the cheap integrity check of start-up. It resolves with the problems found;
 *   an empty array means the check passed.
 * - `backup(dest)` makes a consistent copy of the store **while it is in use**, checks the copy
 *   (a failed check rejects and leaves nothing at `dest`), and refuses to overwrite (`Conflict`).
 *
 * Both reject with `AdapterUnavailable` after `close()`.
 */
export interface StoreMaintenance {
  quickCheck(): Promise<string[]>;
  backup(dest: string, options?: StoreBackupOptions): Promise<StoreBackupResult>;
}

/** Type guard for the optional {@link StoreMaintenance} capability of a store. */
export function hasStoreMaintenance(store: Store): store is Store & StoreMaintenance {
  const candidate = store as Partial<Record<keyof StoreMaintenance, unknown>>;
  return typeof candidate.quickCheck === 'function' && typeof candidate.backup === 'function';
}
