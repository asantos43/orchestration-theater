// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  type EventEnvelope,
  type EventLog,
  type NewEvent,
  type Store,
  type StoreTransaction,
} from '@otheater/core';
import type { Logger } from '../logger.js';

/** Events read from the log per page by {@link EventHub.follow} when the caller does not say. */
export const DEFAULT_FOLLOW_PAGE_SIZE = 500;

/**
 * What a subscriber wants to see. Both parts are optional and combine with "and". An omitted or
 * empty list means "no restriction" on that part.
 */
export interface EventFilter {
  /** Only events of these scenarios (`scenarioId`). Events without a scenario never match. */
  readonly scenarioIds?: readonly string[];
  /** Only events whose type starts with one of these prefixes (`play.`, `quota.`...). */
  readonly typePrefixes?: readonly string[];
}

export interface FollowOptions {
  /**
   * Cursor: the id of the last event the caller already has. The history after it comes first, then
   * the live events. Omitted means "from now": the current `lastId()` of the log, with no history.
   * An integer >= 0, else `InvalidInput`.
   */
  readonly afterId?: number;
  readonly filter?: EventFilter;
  /** Ends the iteration and releases the subscriber as soon as it aborts. */
  readonly signal: AbortSignal;
  /** Events read from the log per page. Default {@link DEFAULT_FOLLOW_PAGE_SIZE}. */
  readonly pageSize?: number;
}

export interface EventHubOptions {
  /**
   * `api.sse.buffer_events`: how many unseen live events one subscriber may accumulate. Past it the
   * subscriber stops counting live notices and catches up from the log (see {@link EventHub}).
   */
  readonly bufferEvents: number;
  /** Where the overflow of a subscriber is told. */
  readonly logger: Pick<Logger, 'warn'>;
}

/** The state of one `follow`. */
interface Subscriber {
  readonly matches: (event: EventEnvelope) => boolean;
  /** A matching event was committed since the last read started. */
  dirty: boolean;
  /** Matching notices counted since the last read started (while not `lapsed`). */
  unseen: number;
  /** The queue overflowed: the subscriber reads the log until it catches up. */
  lapsed: boolean;
  /** `follow` ended or was aborted. */
  ended: boolean;
  /** Resolver of the wait for a notice (set only while the subscriber waits). */
  wake: (() => void) | undefined;
}

/**
 * In-process notice of a new event (architecture 5.11, principle P6; Phase 6, P2). It decorates the
 * `Store` (like `validateEventsOf`) so every event the daemon writes is announced **after it is
 * committed**: an `append` outside a transaction when its promise resolves, the events of a
 * transaction all together after the commit, and nothing at all when the transaction is rolled back.
 * The `EventLog` port of the core does not change.
 *
 * The consumer is {@link EventHub.follow}, an `AsyncIterable` of envelopes (what the SSE and the
 * WebSocket of the API read from). [proposta] Its design, chosen so that it cannot skip or repeat
 * an event:
 * - the notice is only an **alarm clock**. The envelopes always come from `readFrom(cursor)`; the
 *   cursor is the id of the last event read, and nothing assumes `id === previous + 1` (the log
 *   admits holes). Delivering the announced envelope directly would be unsafe: two commits can be
 *   announced out of order, and nothing tells a hole from an event not announced yet;
 * - one read at a time per subscriber, and the notices that arrive during it coalesce into a single
 *   flag, so a burst of writes costs one extra read, not one per event;
 * - the history and the live part are the same loop, so there is no switch to get wrong: a stream
 *   that is behind is just a stream whose read still returns a full page;
 * - the filter is applied on what is read, and the cursor advances by the global id even over events
 *   the filter drops, so a resumed stream never rescans them;
 * - the writer never waits for a subscriber: announcing is setting a flag per subscriber.
 *
 * `bufferEvents` is the ceiling of the live events a subscriber may leave unseen. Past it, the
 * subscriber logs a warning once and stops counting until it catches up, and its next reads come
 * from the log. Memory is bounded either way, because nothing queues the envelopes themselves.
 */
export class EventHub {
  /** The store whose `append`s are announced. Hand this one to the daemon, not the original. */
  readonly store: Store;
  readonly #log: EventLog;
  readonly #options: EventHubOptions;
  readonly #subscribers = new Set<Subscriber>();
  #closed = false;

  constructor(inner: Store, options: EventHubOptions) {
    if (!Number.isSafeInteger(options.bufferEvents) || options.bufferEvents < 1) {
      throw new InvalidInput(
        `bufferEvents must be an integer >= 1, got ${String(options.bufferEvents)}`,
      );
    }
    this.#log = inner.events;
    this.#options = options;
    this.store = decorateStore(inner, (events) => {
      this.#announce(events);
    });
  }

  /** How many `follow` iterations are active (0 once every one ended or aborted). */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * Ends every `follow` (their iterators complete) and stops announcing. Idempotent. The daemon
   * calls it before it closes the store.
   */
  close(): void {
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) {
      this.#release(subscriber);
    }
  }

  /**
   * The history after the cursor, then the live events, in id order, each id exactly once. Ends when
   * `signal` aborts (or the hub closes) and releases the subscriber then, even if the consumer is not
   * pulling. A failure of the log (a closed store) rejects the iteration.
   *
   * The subscriber exists from the first `next()` on; an iterable never iterated holds nothing.
   */
  async *follow(options: FollowOptions): AsyncGenerator<EventEnvelope, void, undefined> {
    const { signal } = options;
    const pageSize = options.pageSize ?? DEFAULT_FOLLOW_PAGE_SIZE;
    if (
      options.afterId !== undefined &&
      (!Number.isSafeInteger(options.afterId) || options.afterId < 0)
    ) {
      throw new InvalidInput(`afterId must be an integer >= 0, got ${String(options.afterId)}`);
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new InvalidInput(`pageSize must be an integer >= 1, got ${String(pageSize)}`);
    }
    if (signal.aborted || this.#closed) return;

    const subscriber: Subscriber = {
      matches: compileFilter(options.filter),
      dirty: false,
      unseen: 0,
      lapsed: false,
      ended: false,
      wake: undefined,
    };
    this.#subscribers.add(subscriber);
    const onAbort = (): void => {
      this.#release(subscriber);
    };
    // Read through a function: `ended` changes in other closures, which narrowing cannot see.
    const ended = (): boolean => subscriber.ended;
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let cursor = options.afterId ?? (await this.#log.lastId());
      while (!ended()) {
        // Cleared before the read: a commit announced from here on sets it again, and one announced
        // before it was already committed, so the read below sees it.
        subscriber.dirty = false;
        subscriber.unseen = 0;
        const page = await this.#log.readFrom(cursor, pageSize);
        if (ended()) return;
        if (page.length === 0) {
          subscriber.lapsed = false;
          // Returns at once when a notice arrived during the read.
          await waitForNotice(subscriber);
          continue;
        }
        for (const event of page) {
          cursor = event.id;
          if (!subscriber.matches(event)) continue;
          yield event;
          if (ended()) return;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.#release(subscriber);
    }
  }

  #release(subscriber: Subscriber): void {
    subscriber.ended = true;
    this.#subscribers.delete(subscriber);
    subscriber.wake?.();
  }

  /** Never throws and never waits: it sets a flag per subscriber. */
  #announce(events: readonly EventEnvelope[]): void {
    if (this.#closed || events.length === 0) return;
    for (const subscriber of this.#subscribers) {
      let matched = 0;
      for (const event of events) {
        if (subscriber.matches(event)) matched += 1;
      }
      if (matched === 0) continue;
      subscriber.dirty = true;
      if (!subscriber.lapsed) {
        subscriber.unseen += matched;
        if (subscriber.unseen > this.#options.bufferEvents) {
          subscriber.lapsed = true;
          this.#warnOverflow(subscriber);
        }
      }
      const wake = subscriber.wake;
      if (wake !== undefined) {
        subscriber.wake = undefined;
        wake();
      }
    }
  }

  #warnOverflow(subscriber: Subscriber): void {
    try {
      this.#options.logger.warn(
        { bufferEvents: this.#options.bufferEvents, unseen: subscriber.unseen },
        'event subscriber is behind the live events; it catches up from the log',
      );
    } catch {
      // A logger that fails must not reach the writer.
    }
  }
}

/** Builds the hub over `store`; the daemon uses `hub.store` from then on. */
export function createEventHub(store: Store, options: EventHubOptions): EventHub {
  return new EventHub(store, options);
}

function waitForNotice(subscriber: Subscriber): Promise<void> {
  if (subscriber.dirty || subscriber.ended) return Promise.resolve();
  return new Promise<void>((resolve) => {
    subscriber.wake = resolve;
  });
}

function compileFilter(filter: EventFilter | undefined): (event: EventEnvelope) => boolean {
  const scenarios =
    filter?.scenarioIds !== undefined && filter.scenarioIds.length > 0
      ? new Set(filter.scenarioIds)
      : undefined;
  const prefixes =
    filter?.typePrefixes !== undefined && filter.typePrefixes.length > 0
      ? [...filter.typePrefixes]
      : undefined;
  return (event) => {
    if (
      scenarios !== undefined &&
      (event.scenarioId === undefined || !scenarios.has(event.scenarioId))
    ) {
      return false;
    }
    return prefixes === undefined || prefixes.some((prefix) => event.type.startsWith(prefix));
  };
}

/** Wraps an `EventLog` so what `append` returns also goes to `record`. */
function recordingLog(log: EventLog, record: (event: EventEnvelope) => void): EventLog {
  return {
    append: async (event: NewEvent) => {
      const stored = await log.append(event);
      record(stored);
      return stored;
    },
    readFrom: (afterId, limit) => log.readFrom(afterId, limit),
    lastId: () => log.lastId(),
  };
}

/**
 * Decorates the store: `events` announces each stored event once its promise resolves; inside
 * `transaction` the events are collected and announced together after the commit. Everything else
 * passes through, bound to the real store (the same technique as `validateEventsOf`).
 */
function decorateStore(store: Store, announce: (events: readonly EventEnvelope[]) => void): Store {
  const events = recordingLog(store.events, (event) => {
    announce([event]);
  });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'events') return events;
      if (property === 'transaction') {
        return <T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> => {
          const stored: EventEnvelope[] = [];
          return target
            .transaction((tx) => {
              const log = recordingLog(tx.events, (event) => {
                stored.push(event);
              });
              return work(
                new Proxy(tx, {
                  get: (txTarget, txProperty) =>
                    txProperty === 'events' ? log : bound(txTarget, txProperty),
                }),
              );
            })
            .then((result) => {
              announce(stored);
              return result;
            });
        };
      }
      return bound(target, property);
    },
  });
}

function bound(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}
