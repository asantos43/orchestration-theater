// SPDX-License-Identifier: MPL-2.0
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  AdapterUnavailable,
  DiskFull,
  autoCommitAggregates,
  createStoreAggregates,
  InvalidInput,
  isOTheaterError,
  transactionInstant,
  type AttemptListFilter,
  type AttemptRecord,
  type AttemptRecordInput,
  type AttemptRegistry,
  type Clock,
  type EventEnvelope,
  type EventLog,
  type NewEvent,
  type Store,
  type StoreAggregates,
  type StoreMaintenance,
  type StoreTransaction,
} from '@otheater/core';
import { Kysely, SqliteDialect } from 'kysely';
import { z } from 'zod';
import { selectAttempt, selectAttempts, TransactionAttemptRegistry } from './attempts.js';
import { backupDatabase, type BackupOptions, type BackupResult } from './backup.js';
import {
  SqliteStoreConfigSchema,
  type SqliteDriverName,
  type SqliteStoreConfig,
  type SqliteStoreConfigInput,
} from './config.js';
import { ImmediateSqliteDialect } from './dialect.js';
import { openRawDatabase, quickCheck, readPragma, type RawDatabase } from './driver.js';
import { toStoreError } from './errors.js';
import { selectEvents, selectLastId, TransactionEventLog } from './events.js';
import { migrateToLatest } from './migrations.js';
import type { StoreDatabase } from './schema.js';
import { committedTables, TransactionTables } from './tables.js';

/**
 * Pragmas of the write connection, in the order they are applied. `busy_timeout` goes first so
 * that the switch to WAL itself waits for a lock instead of failing.
 *
 * On macOS a plain `fsync` does not flush the disk cache, so `fullfsync` (and
 * `checkpoint_fullfsync`) are added there (architecture 5.21) **[a confirmar no macOS]**.
 */
export function writerPragmas(
  config: Pick<SqliteStoreConfig, 'synchronous' | 'busyTimeoutMs'>,
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

/** Settings of the write connection as SQLite reports them (for `doctor`-style diagnostics). */
export interface SqliteStoreDiagnostics {
  readonly driver: SqliteDriverName;
  readonly sqliteVersion: string;
  readonly journalMode: string;
  /** `PRAGMA synchronous` as SQLite numbers it: 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA. */
  readonly synchronous: number;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  readonly fullfsync: boolean;
  readonly checkpointFullfsync: boolean;
}

/**
 * Callbacks around the commit of every transaction, for the chaos tests of Phase 11: the daemon
 * passes them only when `faults.inject` armed a plan, so a normal start hands the store nothing.
 * `beforeCommit` runs after the body of the transaction and before Kysely commits it (a kill there
 * leaves the transaction uncommitted); `afterCommit` runs once the commit has returned. A hook that
 * rejects rolls the transaction back (`beforeCommit`) or rejects the call (`afterCommit`).
 */
export interface StoreCommitHooks {
  readonly beforeCommit?: (() => Promise<void>) | undefined;
  readonly afterCommit?: (() => Promise<void>) | undefined;
  /**
   * Told, after the transaction rolled back, of the typed error the call rejects with (Phase 11,
   * P5): the daemon hears a `DiskFull` here, whoever made the write. It must not throw nor wait.
   * Unlike the two above, the daemon passes it on every start.
   */
  readonly onFailure?: ((error: unknown) => void) | undefined;
}

/**
 * The SQLite adapter of the `Store` port (architecture 5.18 and section 7): Kysely on
 * `better-sqlite3` or `node:sqlite`, WAL, versioned migrations.
 *
 * Two connections to the same file [proposta]:
 * - the **writer** runs every transaction, one at a time, in call order (a promise queue), so the
 *   body of one never overlaps another and there is no nesting;
 * - the **reader** is read-only and answers `store.events.readFrom/lastId` outside a transaction.
 *   In WAL mode it sees only committed data, never blocks the writer and is never blocked by a
 *   transaction waiting on the caller (a single connection would show uncommitted rows to an
 *   outside read, or deadlock it behind the open transaction).
 *
 * Open it with {@link SqliteStore.open}.
 */
export class SqliteStore implements Store, StoreMaintenance {
  readonly events: EventLog;
  readonly attempts: AttemptRegistry;
  readonly scenarios: StoreAggregates['scenarios'];
  readonly scenarioRepos: StoreAggregates['scenarioRepos'];
  readonly attachments: StoreAggregates['attachments'];
  readonly plays: StoreAggregates['plays'];
  readonly stages: StoreAggregates['stages'];
  readonly demands: StoreAggregates['demands'];
  readonly decisions: StoreAggregates['decisions'];
  readonly blackboard: StoreAggregates['blackboard'];
  readonly promptQueue: StoreAggregates['promptQueue'];
  readonly sideEffects: StoreAggregates['sideEffects'];
  readonly sessions: StoreAggregates['sessions'];
  readonly directives: StoreAggregates['directives'];
  readonly ideas: StoreAggregates['ideas'];
  readonly profiles: StoreAggregates['profiles'];
  readonly executors: StoreAggregates['executors'];
  readonly interruptions: StoreAggregates['interruptions'];
  readonly quotaSnapshots: StoreAggregates['quotaSnapshots'];
  readonly usage: StoreAggregates['usage'];
  readonly wakeups: StoreAggregates['wakeups'];
  readonly setupRuns: StoreAggregates['setupRuns'];
  readonly workflowDefinitions: StoreAggregates['workflowDefinitions'];
  readonly workflowBindings: StoreAggregates['workflowBindings'];
  readonly config: SqliteStoreConfig;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #writerRaw: RawDatabase;
  readonly #readerRaw: RawDatabase;
  readonly #writer: Kysely<StoreDatabase>;
  readonly #reader: Kysely<StoreDatabase>;
  readonly #backups = new Set<Promise<unknown>>();
  #tail: Promise<unknown> = Promise.resolve();
  readonly #hooks: StoreCommitHooks | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  private constructor(
    config: SqliteStoreConfig,
    clock: Pick<Clock, 'now'>,
    connections: {
      writerRaw: RawDatabase;
      readerRaw: RawDatabase;
      writer: Kysely<StoreDatabase>;
      reader: Kysely<StoreDatabase>;
    },
    hooks?: StoreCommitHooks,
  ) {
    this.config = config;
    this.#clock = clock;
    this.#hooks = hooks;
    this.#writerRaw = connections.writerRaw;
    this.#readerRaw = connections.readerRaw;
    this.#writer = connections.writer;
    this.#reader = connections.reader;
    this.events = new StoreEventLog(this, (event) => this.#appendOutside(event));
    this.attempts = new StoreAttempts(this, (record) =>
      this.transaction((tx) => tx.attempts.put(record)),
    );
    // Outside a transaction a read goes to the read-only connection (committed data, never
    // waiting for a transaction) and a write is a transaction of its own.
    const aggregates = autoCommitAggregates(
      createStoreAggregates(
        committedTables(this.#reader, () => {
          if (this.#closed) throw this.#closedError();
        }),
        clock,
      ),
      (fn) => this.transaction((tx) => fn(tx)),
      () => {
        if (this.#closed) throw this.#closedError();
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
    this.setupRuns = aggregates.setupRuns;
    this.workflowDefinitions = aggregates.workflowDefinitions;
    this.workflowBindings = aggregates.workflowBindings;
  }

  /**
   * Opens (creating if needed) the database, applies the pragmas and the pending migrations and
   * returns the store. [proposta] API shape. `clock` stamps the events.
   *
   * Rejects with `InvalidInput` for a bad config and `AdapterUnavailable` when the file cannot be
   * opened or migrated (including a database written by a newer version of this code).
   */
  static async open(
    input: SqliteStoreConfigInput,
    clock: Pick<Clock, 'now'>,
    hooks?: StoreCommitHooks,
  ): Promise<SqliteStore> {
    const parsed = SqliteStoreConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidInput(`Invalid SQLite store config: ${z.prettifyError(parsed.error)}`, {
        cause: parsed.error,
      });
    }
    const config = parsed.data;
    const path = resolve(config.path);
    const { driver, busyTimeoutMs } = config;

    let writerRaw: RawDatabase | undefined;
    let readerRaw: RawDatabase | undefined;
    let writer: Kysely<StoreDatabase> | undefined;
    let reader: Kysely<StoreDatabase> | undefined;
    try {
      await mkdir(dirname(path), { recursive: true });
      writerRaw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs });
      for (const pragma of writerPragmas(config)) writerRaw.exec(pragma);
      const journalMode = readPragma(writerRaw, 'journal_mode');
      if (journalMode !== 'wal') {
        throw new AdapterUnavailable(
          `Could not switch the database to WAL mode (journal_mode is ${String(journalMode)}); ` +
            'is the file on a filesystem without shared-memory support?',
        );
      }
      writer = new Kysely<StoreDatabase>({
        dialect: new ImmediateSqliteDialect({ database: writerRaw }),
      });
      await migrateToLatest(writer);

      readerRaw = await openRawDatabase(driver, path, { readonly: true, busyTimeoutMs });
      readerRaw.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
      reader = new Kysely<StoreDatabase>({ dialect: new SqliteDialect({ database: readerRaw }) });

      return new SqliteStore(
        { ...config, path },
        clock,
        { writerRaw, readerRaw, writer, reader },
        hooks,
      );
    } catch (error) {
      // `destroy()` only closes a database whose Kysely driver already started: close both here.
      await Promise.allSettled([writer?.destroy(), reader?.destroy()]);
      readerRaw?.close();
      writerRaw?.close();
      const mapped = toStoreError(error);
      if (isOTheaterError(mapped)) throw mapped;
      throw new AdapterUnavailable(`Could not open the SQLite store at ${path}`, { cause: error });
    }
  }

  /** Absolute path of the database file. */
  get path(): string {
    return this.config.path;
  }

  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError());
    // A transaction accepted before `close()` runs to completion; `close()` waits for it.
    return this.#enqueue(() => this.#runTransaction(fn));
  }

  async #runTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    try {
      // Kysely commits when the callback resolves, and on a rejection rolls back and rethrows the
      // very same error object (typed errors cross the port untouched).
      const result = await this.#writer.transaction().execute(async (trx) => {
        // One reading of the clock for everything the transaction writes (N177).
        const instant = transactionInstant(this.#clock);
        const events = new TransactionEventLog(trx, instant);
        const attempts = new TransactionAttemptRegistry(trx, instant);
        const tables = new TransactionTables(trx);
        const aggregates = createStoreAggregates(tables.factory, instant);
        try {
          const value = await fn({ events, attempts, now: () => instant.now(), ...aggregates });
          await this.#hooks?.beforeCommit?.();
          return value;
        } finally {
          // From here on a leaked handle is refused, even while the commit is still running.
          events.finish();
          attempts.finish();
          tables.finish();
        }
      });
      await this.#hooks?.afterCommit?.();
      return result;
    } catch (error) {
      const typed = toStoreError(error);
      this.#told(typed);
      throw typed;
    }
  }

  #told(error: unknown): void {
    try {
      this.#hooks?.onFailure?.(error);
    } catch {
      // The hook must not change what the caller gets.
    }
  }

  /** `store.events.append` outside a transaction: a transaction of its own. */
  #appendOutside(event: NewEvent): Promise<EventEnvelope> {
    return this.transaction((tx) => tx.events.append(event));
  }

  /** @internal Reads for `store.events` outside a transaction (the read-only connection). */
  readCommitted<T>(read: (db: Kysely<StoreDatabase>) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError());
    return read(this.#reader);
  }

  /** What the write connection reports for the settings this adapter applies. */
  diagnostics(): Promise<SqliteStoreDiagnostics> {
    if (this.#closed) return Promise.reject(this.#closedError());
    return this.#enqueue(() => {
      const db = this.#writerRaw;
      const text = (name: string): string => String(readPragma(db, name));
      const number = (name: string): number => Number(readPragma(db, name));
      return Promise.resolve({
        driver: this.config.driver,
        sqliteVersion: String(
          (db.prepare('SELECT sqlite_version() AS v').all([])[0] as { v: unknown } | undefined)?.v,
        ),
        journalMode: text('journal_mode'),
        synchronous: number('synchronous'),
        foreignKeys: number('foreign_keys') === 1,
        busyTimeoutMs: number('busy_timeout'),
        fullfsync: number('fullfsync') === 1,
        checkpointFullfsync: number('checkpoint_fullfsync') === 1,
      });
    });
  }

  /**
   * Asks whether a write would find room now, without leaving anything behind (Phase 11, P5): it
   * checks the pages the cap (`max_page_count`) still allows, then commits a write of one value
   * the database already has (`user_version`), which makes SQLite write to the WAL and the file
   * system. Resolves when both pass; rejects with `DiskFull` (or the error of the failed write).
   */
  probeWrite(minFreePages = 16): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closedError());
    return this.#enqueue(() => {
      const db = this.#writerRaw;
      const room =
        Number(readPragma(db, 'max_page_count')) -
        Number(readPragma(db, 'page_count')) +
        Number(readPragma(db, 'freelist_count'));
      if (room < minFreePages) {
        return Promise.reject(
          new DiskFull(`The database has room for ${String(room)} more pages (max_page_count)`),
        );
      }
      const version = Number(readPragma(db, 'user_version'));
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(`PRAGMA user_version = ${String(version)}`);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // No transaction was left open.
        }
        const translated = toStoreError(error);
        return Promise.reject(
          translated instanceof Error ? translated : new Error(String(translated)),
        );
      }
      return Promise.resolve();
    });
  }

  /**
   * Lets the database grow by `pages` more pages and no further (`PRAGMA max_page_count` set to the
   * size it has now plus `pages`), or lifts the cap with `undefined`. A write that needs more pages
   * fails with `SQLITE_FULL`, which {@link toStoreError} turns into `DiskFull`. The cap is per
   * connection, so it is set on the write connection: the one every write goes through. It is how
   * the chaos tests of Phase 11 (P5) fill a database without a full disk. Resolves with the cap
   * now in force, in pages.
   */
  limitGrowth(pages: number | undefined): Promise<number> {
    if (this.#closed) return Promise.reject(this.#closedError());
    return this.#enqueue(() => {
      const db = this.#writerRaw;
      this.#defaultMaxPages ??= Number(readPragma(db, 'max_page_count'));
      const wanted =
        pages === undefined
          ? this.#defaultMaxPages
          : Number(readPragma(db, 'page_count')) + Math.max(0, Math.floor(pages));
      db.exec(`PRAGMA max_page_count = ${String(wanted)}`);
      return Promise.resolve(Number(readPragma(db, 'max_page_count')));
    });
  }

  /**
   * `PRAGMA quick_check` (architecture 5.21: the cheap check of start-up). Resolves with the
   * problems SQLite found; an empty array means the check passed. It reads through the read-only
   * connection, so it sees committed data and does not queue behind transactions. Rejects with
   * `AdapterUnavailable` after `close()`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- the check is synchronous; async maps a throw to a rejection
  async quickCheck(): Promise<string[]> {
    if (this.#closed) throw this.#closedError();
    try {
      return quickCheck(this.#readerRaw);
    } catch (error) {
      throw toStoreError(error);
    }
  }

  /**
   * Consistent copy of the database while the store is in use, checked with `PRAGMA
   * integrity_check` (see {@link backupDatabase}). Writes made while it runs are not blocked; the
   * copy holds a snapshot of committed data. Rejects with `AdapterUnavailable` after `close()`;
   * `close()` waits for a backup in progress.
   */
  backup(destPath: string, options: BackupOptions = {}): Promise<BackupResult> {
    if (this.#closed) return Promise.reject(this.#closedError());
    const running = backupDatabase({
      ...options,
      driver: this.config.driver,
      sourcePath: this.path,
      destPath,
      busyTimeoutMs: this.config.busyTimeoutMs,
    });
    this.#backups.add(running);
    const forget = (): void => {
      this.#backups.delete(running);
    };
    running.then(forget, forget);
    return running;
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    await Promise.allSettled([...this.#backups]);
    await Promise.allSettled([this.#reader.destroy(), this.#writer.destroy()]);
    // Idempotent: closes what Kysely did not (a connection it never used).
    this.#readerRaw.close();
    this.#writerRaw.close();
  }

  #closedError(): AdapterUnavailable {
    return new AdapterUnavailable('The store is closed');
  }

  #defaultMaxPages: number | undefined;

  /** Runs `job` after everything queued before it, whatever their outcome. */
  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(job);
    // The queue must keep flowing after a failed job.
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

/** `store.events` outside a transaction: appends are transactions of their own; reads see only committed data. */
class StoreEventLog implements EventLog {
  constructor(
    private readonly store: SqliteStore,
    private readonly appendOutside: (event: NewEvent) => Promise<EventEnvelope>,
  ) {}

  append(event: NewEvent): Promise<EventEnvelope> {
    return this.appendOutside(event);
  }

  readFrom(afterId: number, limit: number): Promise<readonly EventEnvelope[]> {
    return this.store.readCommitted((db) => selectEvents(db, afterId, limit));
  }

  lastId(): Promise<number> {
    return this.store.readCommitted((db) => selectLastId(db));
  }
}

/** `store.attempts` outside a transaction: writes are transactions of their own; reads see only committed data. */
class StoreAttempts implements AttemptRegistry {
  constructor(
    private readonly store: SqliteStore,
    private readonly putOutside: (record: AttemptRecordInput) => Promise<AttemptRecord>,
  ) {}

  get(attemptId: string): Promise<AttemptRecord | undefined> {
    return this.store.readCommitted((db) => selectAttempt(db, attemptId));
  }

  put(record: AttemptRecordInput): Promise<AttemptRecord> {
    return this.putOutside(record);
  }

  list(filter?: AttemptListFilter): Promise<readonly AttemptRecord[]> {
    return this.store.readCommitted((db) => selectAttempts(db, filter));
  }
}
