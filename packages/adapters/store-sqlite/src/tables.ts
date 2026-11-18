// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  keyOfRecord,
  NotFound,
  type RecordKey,
  type RecordQuery,
  type RecordTable,
  type TableFactory,
  type TableSpec,
} from '@otheater/core';
import { sql, type QueryExecutorProvider, type RawBuilder } from 'kysely';
import { toStoreError } from './errors.js';

/** A value SQLite binds as is. */
type SqlValue = string | number | null;

/** `flowVersion` becomes `flow_version`: the column of a record field. */
function columnOf(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** `flow_version` becomes `flowVersion`: the field of a column. */
function fieldOf(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * [proposta] One generic table of the Phase 3 aggregates over SQLite: the columns of a record are
 * the snake case of its fields, fields listed in `spec.json` are stored as JSON text (the JSON
 * `null` as SQL `NULL`) and what is read back goes through `spec.schema`. The rules of each
 * aggregate live in `@otheater/core` (`store-kit`); this class only stores and finds records.
 */
export class SqliteTable<R extends object> implements RecordTable<R> {
  readonly #spec: TableSpec<R>;
  readonly #db: QueryExecutorProvider;
  readonly #assertLive: () => void;
  readonly #json: ReadonlySet<string>;
  readonly #boolean: ReadonlySet<string>;

  /**
   * @param db the connection of one view (a transaction, or the read-only connection)
   * @param assertLive throws when the view can no longer be used (`Conflict` or `AdapterUnavailable`)
   */
  constructor(spec: TableSpec<R>, db: QueryExecutorProvider, assertLive: () => void) {
    this.#spec = spec;
    this.#db = db;
    this.#assertLive = assertLive;
    this.#json = new Set(spec.json);
    this.#boolean = new Set(spec.boolean ?? []);
  }

  get(key: RecordKey): Promise<R | undefined> {
    return this.#run(async () => {
      const result = await sql<Record<string, unknown>>`
        select * from ${this.#table()} where ${this.#keyCondition(key)} limit 1
      `.execute(this.#db);
      const row = result.rows[0];
      return row === undefined ? undefined : this.#toRecord(row);
    });
  }

  insert(record: R): Promise<void> {
    return this.#run(async () => {
      const fields = Object.keys(record);
      await sql`
        insert into ${this.#table()}
          (${sql.join(fields.map((field) => sql.ref(columnOf(field))))})
          values (${sql.join(fields.map((field) => this.#encode(field, record)))})
      `.execute(this.#db);
    });
  }

  replace(record: R): Promise<void> {
    return this.#run(async () => {
      const keyFields = new Set<string>(this.#spec.key);
      const assignments = Object.keys(record)
        .filter((field) => !keyFields.has(field))
        .map((field) => sql`${sql.ref(columnOf(field))} = ${this.#encode(field, record)}`);
      const result = await sql`
        update ${this.#table()} set ${sql.join(assignments)}
        where ${this.#keyCondition(keyOfRecord(this.#spec, record))}
      `.execute(this.#db);
      if ((result.numAffectedRows ?? 0n) === 0n) {
        throw new NotFound(`${this.#spec.name} record does not exist`);
      }
    });
  }

  delete(key: RecordKey): Promise<boolean> {
    return this.#run(async () => {
      const result = await sql`
        delete from ${this.#table()} where ${this.#keyCondition(key)}
      `.execute(this.#db);
      return (result.numAffectedRows ?? 0n) > 0n;
    });
  }

  select(query: RecordQuery): Promise<R[]> {
    return this.#run(async () => {
      const conditions: RawBuilder<unknown>[] = [];
      for (const [field, value] of Object.entries(query.eq ?? {})) {
        conditions.push(
          value === null
            ? sql`${sql.ref(columnOf(field))} is null`
            : sql`${sql.ref(columnOf(field))} = ${value}`,
        );
      }
      for (const [field, values] of Object.entries(query.in ?? {})) {
        // `in ()` is invalid SQL: an empty list matches nothing.
        if (values.length === 0) return [];
        conditions.push(sql`${sql.ref(columnOf(field))} in (${sql.join([...values])})`);
      }
      for (const [field, bounds] of Object.entries(query.ranges ?? {})) {
        if (bounds.gte !== undefined) {
          conditions.push(sql`${sql.ref(columnOf(field))} >= ${bounds.gte}`);
        }
        if (bounds.lte !== undefined) {
          conditions.push(sql`${sql.ref(columnOf(field))} <= ${bounds.lte}`);
        }
      }
      const where =
        conditions.length === 0 ? sql`` : sql`where ${sql.join(conditions, sql` and `)}`;
      const order =
        query.orderBy.length === 0
          ? sql``
          : sql`order by ${sql.join(
              query.orderBy.map(
                (term) =>
                  sql`${sql.ref(columnOf(term.field))} ${sql.raw(term.desc === true ? 'desc' : 'asc')}`,
              ),
            )}`;
      const limit = query.limit === undefined ? sql`` : sql`limit ${query.limit}`;
      const result = await sql<Record<string, unknown>>`
        select * from ${this.#table()} ${where} ${order} ${limit}
      `.execute(this.#db);
      return result.rows.map((row) => this.#toRecord(row));
    });
  }

  #table(): RawBuilder<unknown> {
    return sql.table(this.#spec.name);
  }

  #keyCondition(key: RecordKey): RawBuilder<unknown> {
    const terms = this.#spec.key.map((field) => sql`${sql.ref(columnOf(field))} = ${key[field]}`);
    return sql.join(terms, sql` and `);
  }

  #encode(field: string, record: object): SqlValue {
    const value = (record as Record<string, unknown>)[field];
    if (value === null || value === undefined) return null;
    if (this.#json.has(field)) return JSON.stringify(value);
    if (typeof value === 'string' || typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    throw new TypeError(`${this.#spec.name}.${field} is not a value SQLite can store`);
  }

  #toRecord(row: Record<string, unknown>): R {
    const record: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      const field = fieldOf(column);
      if (this.#json.has(field) && typeof value === 'string') record[field] = JSON.parse(value);
      else if (this.#boolean.has(field) && typeof value === 'number') record[field] = value !== 0;
      else record[field] = value;
    }
    return this.#spec.schema.parse(record);
  }

  async #run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      this.#assertLive();
      return await fn();
    } catch (error) {
      throw toStoreError(error);
    }
  }
}

/**
 * The tables of one transaction of the writer: reads see its writes and, once the transaction
 * ended ({@link finish}), every call rejects with `Conflict`.
 */
export class TransactionTables {
  readonly #db: QueryExecutorProvider;
  #finished = false;

  constructor(db: QueryExecutorProvider) {
    this.#db = db;
  }

  readonly factory: TableFactory = <R extends object>(spec: TableSpec<R>): RecordTable<R> =>
    new SqliteTable(spec, this.#db, () => {
      if (this.#finished) throw new Conflict('The transaction already ended');
    });

  /** Called by the store as soon as the body settles, before the commit or the rollback. */
  finish(): void {
    this.#finished = true;
  }
}

/** The tables of the read-only connection (committed data); `assertOpen` throws once the store closed. */
export function committedTables(db: QueryExecutorProvider, assertOpen: () => void): TableFactory {
  return <R extends object>(spec: TableSpec<R>): RecordTable<R> =>
    new SqliteTable(spec, db, assertOpen);
}
