// SPDX-License-Identifier: MPL-2.0
import type { AttemptRecord, AttemptRecordInput, Clock, NewEvent, Store } from '@otheater/core';

/** The fields of an attempt that change after it is created. */
export type AttemptPatch = Partial<
  Pick<
    AttemptRecordInput,
    | 'state'
    | 'cause'
    | 'sessionId'
    | 'lastCheckpoint'
    | 'lastCheckpointAt'
    | 'lastEventAt'
    | 'resumes'
    | 'freeResumes'
  >
>;

/**
 * The writes of one attempt (architecture 5.16 and section 7): every event and the change of the
 * registry it goes with are one store transaction, and the writes happen in the order they were
 * asked for, even though callers (the stream of updates, the timers) do not wait for each other.
 *
 * A failed write is kept, not thrown at the caller of `write` (which is often an event listener);
 * `flush()` rethrows the first one, and the runner calls it at the points where it can act on it.
 */
export class AttemptJournal {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #playId: string;
  readonly #attemptId: string;
  #current: AttemptRecordInput;
  #saved: AttemptRecord | undefined;
  #queue: Promise<void> = Promise.resolve();
  #failure: { error: unknown } | undefined;

  constructor(store: Store, clock: Clock, initial: AttemptRecordInput) {
    this.#store = store;
    this.#clock = clock;
    this.#playId = initial.playId;
    this.#attemptId = initial.attemptId;
    this.#current = initial;
  }

  /** The record as the next write will leave it (changes are applied when asked for). */
  get record(): AttemptRecordInput {
    return this.#current;
  }

  /** The last record the store confirmed. */
  get saved(): AttemptRecord | undefined {
    return this.#saved;
  }

  /**
   * Queues `patch` (and `event`, if any, with the correlation of the attempt on its envelope).
   * Without arguments it writes the record as it is, which is how an attempt is first registered.
   */
  write(event?: NewEvent, patch: AttemptPatch = {}): Promise<void> {
    this.#current = { ...this.#current, ...patch };
    const record = this.#current;
    const envelope =
      event === undefined
        ? undefined
        : { ...event, playId: this.#playId, attemptId: this.#attemptId };
    const run = async (): Promise<void> => {
      this.#saved = await this.#store.transaction(async (tx) => {
        if (envelope !== undefined) await tx.events.append(envelope);
        return tx.attempts.put(record);
      });
    };
    const next = this.#queue.then(run);
    this.#queue = next.catch((error: unknown) => {
      this.#failure ??= { error };
    });
    return this.#queue;
  }

  /** Marks the time of the last event of the attempt (what the stuck watch reads). */
  touch(): number {
    const now = this.#clock.now();
    this.#current = { ...this.#current, lastEventAt: now };
    return now;
  }

  /** Waits for the queued writes; rethrows the first failure of any of them. */
  async flush(): Promise<void> {
    await this.#queue;
    if (this.#failure !== undefined) {
      const { error } = this.#failure;
      this.#failure = undefined;
      throw error;
    }
  }
}
