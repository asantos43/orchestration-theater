// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '../errors.js';
import {
  compareAttempts,
  parseAttemptInput,
  type AttemptListFilter,
  type AttemptRecord,
  type AttemptRecordInput,
  type AttemptRegistry,
} from '../ports/attempt-registry.js';
import type { Clock } from '../ports/clock.js';

/**
 * Attempt registry in memory. On its own it commits each `put` immediately. `InMemoryStore` uses
 * `fork()` to give every transaction a private copy that `commit()` publishes and `discard()`
 * drops, which is what makes the rollback of the in-memory store faithful.
 */
export class InMemoryAttemptRegistry implements AttemptRegistry {
  readonly #records: Map<string, AttemptRecord>;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #base: InMemoryAttemptRegistry | undefined;
  #finished = false;

  constructor(clock: Pick<Clock, 'now'>, base?: InMemoryAttemptRegistry) {
    this.#clock = clock;
    this.#base = base;
    this.#records = new Map<string, AttemptRecord>(base === undefined ? [] : base.#records);
  }

  get(attemptId: string): Promise<AttemptRecord | undefined> {
    return this.#run(() => {
      const found = this.#records.get(attemptId);
      return found === undefined ? undefined : structuredClone(found);
    });
  }

  put(record: AttemptRecordInput): Promise<AttemptRecord> {
    return this.#run(() => {
      const input = parseAttemptInput(record);
      const now = this.#clock.now();
      const stored: AttemptRecord = {
        ...structuredClone(input),
        createdAt: this.#records.get(input.attemptId)?.createdAt ?? now,
        updatedAt: now,
      };
      this.#records.set(stored.attemptId, stored);
      return structuredClone(stored);
    });
  }

  list(filter: AttemptListFilter = {}): Promise<readonly AttemptRecord[]> {
    return this.#run(() => {
      const states = filter.states;
      return structuredClone(
        [...this.#records.values()]
          .filter((r) => states === undefined || states.includes(r.state))
          .sort(compareAttempts),
      );
    });
  }

  /** For `InMemoryStore`: a transaction copy of this (committed) registry. */
  fork(clock: Pick<Clock, 'now'> = this.#clock): InMemoryAttemptRegistry {
    return new InMemoryAttemptRegistry(clock, this);
  }

  /** For `InMemoryStore`: publishes the copy into its base and ends it. */
  commit(): void {
    if (this.#base === undefined) throw new Conflict('Only a fork can be committed');
    this.#base.#records.clear();
    for (const [id, record] of this.#records) this.#base.#records.set(id, record);
    this.#finish();
  }

  /** For `InMemoryStore`: drops the copy and ends it. */
  discard(): void {
    this.#finish();
  }

  #finish(): void {
    this.#finished = true;
    this.#records.clear();
  }

  #run<T>(fn: () => T): Promise<T> {
    if (this.#finished) return Promise.reject(new Conflict('The transaction already ended'));
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
