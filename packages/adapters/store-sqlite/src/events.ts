// SPDX-License-Identifier: MPL-2.0
import {
  assertReadFromArgs,
  Conflict,
  parseNewEvent,
  type Clock,
  type EventEnvelope,
  type EventLog,
  type JsonValue,
  type NewEvent,
} from '@otheater/core';
import type { Kysely, Selectable } from 'kysely';
import { toStoreError } from './errors.js';
import type { EventsTable, StoreDatabase } from './schema.js';

type Db = Kysely<StoreDatabase>;

function toEnvelope(row: Selectable<EventsTable>): EventEnvelope {
  return {
    id: row.id,
    type: row.type,
    timestamp: row.timestamp,
    schemaVersion: row.schema_version,
    payload: JSON.parse(row.payload) as Record<string, JsonValue>,
    // `exactOptionalPropertyTypes`: an absent id is an absent key, never `undefined`.
    ...(row.scenario_id === null ? {} : { scenarioId: row.scenario_id }),
    ...(row.play_id === null ? {} : { playId: row.play_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
  };
}

/** Validates, inserts and returns the stored envelope. Runs on whatever connection `db` is. */
export async function insertEvent(
  db: Db,
  clock: Pick<Clock, 'now'>,
  event: NewEvent,
): Promise<EventEnvelope> {
  const input = parseNewEvent(event);
  try {
    const row = await db
      .insertInto('events')
      .values({
        type: input.type,
        timestamp: clock.now(),
        schema_version: input.schemaVersion,
        scenario_id: input.scenarioId ?? null,
        play_id: input.playId ?? null,
        attempt_id: input.attemptId ?? null,
        payload: JSON.stringify(input.payload),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEnvelope(row);
  } catch (error) {
    throw toStoreError(error);
  }
}

export async function selectEvents(
  db: Db,
  afterId: number,
  limit: number,
): Promise<readonly EventEnvelope[]> {
  assertReadFromArgs(afterId, limit);
  try {
    const rows = await db
      .selectFrom('events')
      .selectAll()
      .where('id', '>', afterId)
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows.map(toEnvelope);
  } catch (error) {
    throw toStoreError(error);
  }
}

export async function selectLastId(db: Db): Promise<number> {
  try {
    const row = await db
      .selectFrom('events')
      .select((eb) => eb.fn.max('id').as('last'))
      .executeTakeFirst();
    return row?.last ?? 0;
  } catch (error) {
    throw toStoreError(error);
  }
}

/**
 * `tx.events`: the event log bound to one transaction. Reads see its own writes; once the
 * transaction ended every call rejects with `Conflict` (the handle must not outlive the body).
 */
export class TransactionEventLog implements EventLog {
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

  append(event: NewEvent): Promise<EventEnvelope> {
    return this.#guarded(() => insertEvent(this.#db, this.#clock, event));
  }

  readFrom(afterId: number, limit: number): Promise<readonly EventEnvelope[]> {
    return this.#guarded(() => selectEvents(this.#db, afterId, limit));
  }

  lastId(): Promise<number> {
    return this.#guarded(() => selectLastId(this.#db));
  }

  #guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#finished) return Promise.reject(new Conflict('The transaction already ended'));
    return fn();
  }
}
