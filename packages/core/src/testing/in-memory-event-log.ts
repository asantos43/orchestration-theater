// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  assertReadFromArgs,
  parseNewEvent,
  type EventEnvelope,
  type EventLog,
  type NewEvent,
} from '../ports/event-log.js';

/**
 * Event log in memory. On its own it commits each `append` immediately.
 *
 * `InMemoryStore` uses `fork()` to give every transaction a private overlay on top of the
 * committed log: the overlay's events are invisible to the base until `commit()`, and `discard()`
 * drops them, which is what makes the rollback of the in-memory store faithful.
 */
export class InMemoryEventLog implements EventLog {
  readonly #events: EventEnvelope[] = [];
  readonly #clock: Pick<Clock, 'now'>;
  readonly #base: InMemoryEventLog | undefined;
  #finished = false;

  constructor(clock: Pick<Clock, 'now'>, base?: InMemoryEventLog) {
    this.#clock = clock;
    this.#base = base;
  }

  append(event: NewEvent): Promise<EventEnvelope> {
    return this.#run(() => {
      const input = parseNewEvent(event);
      const stored: EventEnvelope = {
        ...structuredClone(input),
        id: this.#lastId() + 1,
        timestamp: this.#clock.now(),
      };
      this.#events.push(stored);
      return structuredClone(stored);
    });
  }

  readFrom(afterId: number, limit: number): Promise<readonly EventEnvelope[]> {
    return this.#run(() => {
      assertReadFromArgs(afterId, limit);
      const found = this.#all()
        .filter((e) => e.id > afterId)
        .slice(0, limit);
      return structuredClone(found);
    });
  }

  lastId(): Promise<number> {
    return this.#run(() => this.#lastId());
  }

  /** For `InMemoryStore`: a transaction overlay over this (committed) log, stamping with `clock`. */
  fork(clock: Pick<Clock, 'now'> = this.#clock): InMemoryEventLog {
    return new InMemoryEventLog(clock, this);
  }

  /** For `InMemoryStore`: publishes the overlay's events into its base and ends the overlay. */
  commit(): void {
    if (this.#base === undefined) throw new Conflict('Only a fork can be committed');
    this.#base.#events.push(...this.#events);
    this.#finish();
  }

  /** For `InMemoryStore`: drops the overlay's events and ends it. */
  discard(): void {
    this.#finish();
  }

  #finish(): void {
    this.#finished = true;
    this.#events.length = 0;
  }

  #all(): EventEnvelope[] {
    return this.#base === undefined ? this.#events : [...this.#base.#all(), ...this.#events];
  }

  #lastId(): number {
    const own = this.#events.at(-1);
    if (own !== undefined) return own.id;
    return this.#base === undefined ? 0 : this.#base.#lastId();
  }

  #run<T>(fn: () => T): Promise<T> {
    if (this.#finished) {
      return Promise.reject(new Conflict('The transaction already ended'));
    }
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
