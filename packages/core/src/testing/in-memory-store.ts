// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { EventEnvelope, EventLog, NewEvent } from '../ports/event-log.js';
import type {
  AttemptListFilter,
  AttemptRecord,
  AttemptRecordInput,
  AttemptRegistry,
} from '../ports/attempt-registry.js';
import type { Store, StoreAggregates, StoreTransaction } from '../ports/store.js';
import { autoCommitAggregates, createStoreAggregates } from '../store-kit/index.js';
import { InMemoryAttemptRegistry } from './in-memory-attempt-registry.js';
import { InMemoryEventLog } from './in-memory-event-log.js';
import { InMemoryTables } from './in-memory-tables.js';

export interface InMemoryStoreOptions {
  /** Stamps the events. Pass a `FakeClock` to control it. */
  readonly clock: Pick<Clock, 'now'>;
}

/**
 * `Store` in memory, for tests. Honours the whole contract: serialized transactions, rollback that
 * rethrows the same error, atomic visibility, `Conflict` on a finished transaction handle and
 * `AdapterUnavailable` after `close()`.
 */
export class InMemoryStore implements Store {
  readonly events: EventLog;
  readonly attempts: AttemptRegistry;
  readonly scenarios: Store['scenarios'];
  readonly scenarioRepos: Store['scenarioRepos'];
  readonly attachments: Store['attachments'];
  readonly plays: Store['plays'];
  readonly stages: Store['stages'];
  readonly demands: Store['demands'];
  readonly decisions: Store['decisions'];
  readonly blackboard: Store['blackboard'];
  readonly promptQueue: Store['promptQueue'];
  readonly sideEffects: Store['sideEffects'];
  readonly sessions: Store['sessions'];
  readonly directives: Store['directives'];
  readonly ideas: Store['ideas'];
  readonly profiles: Store['profiles'];
  readonly executors: Store['executors'];
  readonly interruptions: Store['interruptions'];
  readonly quotaSnapshots: Store['quotaSnapshots'];
  readonly usage: Store['usage'];
  readonly wakeups: Store['wakeups'];
  readonly #clock: Pick<Clock, 'now'>;
  readonly #committed: InMemoryEventLog;
  readonly #committedAttempts: InMemoryAttemptRegistry;
  readonly #committedTables: InMemoryTables;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: InMemoryStoreOptions) {
    this.#clock = options.clock;
    this.#committed = new InMemoryEventLog(options.clock);
    this.#committedAttempts = new InMemoryAttemptRegistry(options.clock);
    this.#committedTables = new InMemoryTables();
    this.events = new AutoCommitEvents(this, this.#committed);
    this.attempts = new AutoCommitAttempts(this, this.#committedAttempts);
    const aggregates = autoCommitAggregates(
      createStoreAggregates(this.#committedTables.factory, options.clock),
      (fn) => this.transaction((tx) => fn(tx)),
      () => {
        this.assertOpen();
      },
    );
    this.scenarios = aggregates.scenarios;
    this.scenarioRepos = aggregates.scenarioRepos;
    this.attachments = aggregates.attachments;
    this.plays = aggregates.plays;
    this.stages = aggregates.stages;
    this.demands = aggregates.demands;
    this.decisions = aggregates.decisions;
    this.blackboard = aggregates.blackboard;
    this.promptQueue = aggregates.promptQueue;
    this.sideEffects = aggregates.sideEffects;
    this.sessions = aggregates.sessions;
    this.directives = aggregates.directives;
    this.ideas = aggregates.ideas;
    this.profiles = aggregates.profiles;
    this.executors = aggregates.executors;
    this.interruptions = aggregates.interruptions;
    this.quotaSnapshots = aggregates.quotaSnapshots;
    this.usage = aggregates.usage;
    this.wakeups = aggregates.wakeups;
  }

  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new AdapterUnavailable('The store is closed'));
    // A transaction accepted before `close()` runs to completion; `close()` waits for it.
    const run = this.#tail.then(async () => {
      const overlay = this.#committed.fork();
      const attempts = this.#committedAttempts.fork();
      const tables = this.#committedTables.fork();
      const aggregates: StoreAggregates = createStoreAggregates(tables.factory, this.#clock);
      try {
        const result = await fn({ events: overlay, attempts, ...aggregates });
        overlay.commit();
        attempts.commit();
        tables.commit();
        return result;
      } catch (error) {
        overlay.discard();
        attempts.discard();
        tables.discard();
        throw error;
      }
    });
    // The queue must keep flowing after a failed transaction.
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  /** @internal Shared with the auto-commit view of `events`. */
  assertOpen(): void {
    if (this.#closed) throw new AdapterUnavailable('The store is closed');
  }
}

/** `store.events` outside a transaction: appends are single-event transactions, reads see only committed data. */
class AutoCommitEvents implements EventLog {
  constructor(
    private readonly store: InMemoryStore,
    private readonly committed: InMemoryEventLog,
  ) {}

  append(event: NewEvent): Promise<EventEnvelope> {
    return this.store.transaction((tx) => tx.events.append(event));
  }

  readFrom(afterId: number, limit: number): Promise<readonly EventEnvelope[]> {
    return this.guarded(() => this.committed.readFrom(afterId, limit));
  }

  lastId(): Promise<number> {
    return this.guarded(() => this.committed.lastId());
  }

  private guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      this.store.assertOpen();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return fn();
  }
}

/** `store.attempts` outside a transaction: writes are single-record transactions, reads see only committed data. */
class AutoCommitAttempts implements AttemptRegistry {
  constructor(
    private readonly store: InMemoryStore,
    private readonly committed: InMemoryAttemptRegistry,
  ) {}

  get(attemptId: string): Promise<AttemptRecord | undefined> {
    return this.guarded(() => this.committed.get(attemptId));
  }

  put(record: AttemptRecordInput): Promise<AttemptRecord> {
    return this.store.transaction((tx) => tx.attempts.put(record));
  }

  list(filter?: AttemptListFilter): Promise<readonly AttemptRecord[]> {
    return this.guarded(() => this.committed.list(filter));
  }

  private guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      this.store.assertOpen();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return fn();
  }
}
