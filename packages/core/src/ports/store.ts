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
