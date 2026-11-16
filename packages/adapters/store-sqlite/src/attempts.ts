// SPDX-License-Identifier: MPL-2.0
import {
  AttemptRecordSchema,
  Conflict,
  parseAttemptInput,
  type AttemptListFilter,
  type AttemptRecord,
  type AttemptRecordInput,
  type AttemptRegistry,
  type Clock,
} from '@otheater/core';
import type { Kysely, Selectable } from 'kysely';
import { toStoreError } from './errors.js';
import type { AttemptsTable, StoreDatabase } from './schema.js';

type Db = Kysely<StoreDatabase>;

function toRecord(row: Selectable<AttemptsTable>): AttemptRecord {
  return AttemptRecordSchema.parse({
    attemptId: row.attempt_id,
    playId: row.play_id,
    demandId: row.demand_id,
    attempt: row.attempt,
    client: row.client,
    profile: row.profile,
    state: row.state,
    cause: row.cause,
    sessionId: row.session_id,
    worktree: row.worktree,
    branch: row.branch,
    lastCheckpoint: row.last_checkpoint,
    lastCheckpointAt: row.last_checkpoint_at,
    lastEventAt: row.last_event_at,
    resumes: row.resumes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export async function selectAttempt(db: Db, attemptId: string): Promise<AttemptRecord | undefined> {
  try {
    const row = await db
      .selectFrom('attempts')
      .selectAll()
      .where('attempt_id', '=', attemptId)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  } catch (error) {
    throw toStoreError(error);
  }
}

export async function selectAttempts(
  db: Db,
  filter: AttemptListFilter = {},
): Promise<readonly AttemptRecord[]> {
  try {
    let query = db.selectFrom('attempts').selectAll();
    if (filter.states !== undefined) {
      // `in ()` is invalid SQL: an empty filter matches nothing.
      if (filter.states.length === 0) return [];
      query = query.where('state', 'in', [...filter.states]);
    }
    const rows = await query.orderBy('created_at').orderBy('attempt_id').execute();
    return rows.map(toRecord);
  } catch (error) {
    throw toStoreError(error);
  }
}

export async function upsertAttempt(
  db: Db,
  clock: Pick<Clock, 'now'>,
  record: AttemptRecordInput,
): Promise<AttemptRecord> {
  const input = parseAttemptInput(record);
  const now = clock.now();
  try {
    const values = {
      attempt_id: input.attemptId,
      play_id: input.playId,
      demand_id: input.demandId,
      attempt: input.attempt,
      client: input.client,
      profile: input.profile,
      state: input.state,
      cause: input.cause,
      session_id: input.sessionId,
      worktree: input.worktree,
      branch: input.branch,
      last_checkpoint: input.lastCheckpoint,
      last_checkpoint_at: input.lastCheckpointAt,
      last_event_at: input.lastEventAt,
      resumes: input.resumes,
      updated_at: now,
    };
    const row = await db
      .insertInto('attempts')
      .values({ ...values, created_at: now })
      .onConflict((oc) => oc.column('attempt_id').doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  } catch (error) {
    throw toStoreError(error);
  }
}

/**
 * `tx.attempts`: the attempt registry bound to one transaction. Reads see its own writes; once the
 * transaction ended every call rejects with `Conflict`.
 */
export class TransactionAttemptRegistry implements AttemptRegistry {
  readonly #db: Db;
  readonly #clock: Pick<Clock, 'now'>;
  #finished = false;

  constructor(db: Db, clock: Pick<Clock, 'now'>) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Called by the store as soon as the body settles, before the commit or the rollback. */
  finish(): void {
    this.#finished = true;
  }

  get(attemptId: string): Promise<AttemptRecord | undefined> {
    return this.#guarded(() => selectAttempt(this.#db, attemptId));
  }

  put(record: AttemptRecordInput): Promise<AttemptRecord> {
    return this.#guarded(() => upsertAttempt(this.#db, this.#clock, record));
  }

  list(filter?: AttemptListFilter): Promise<readonly AttemptRecord[]> {
    return this.#guarded(() => selectAttempts(this.#db, filter));
  }

  #guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#finished) return Promise.reject(new Conflict('The transaction already ended'));
    return fn();
  }
}
