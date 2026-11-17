// SPDX-License-Identifier: MPL-2.0
import type { z } from 'zod';

/** Value of one key field of a record. */
export type RecordKeyValue = string | number;

/** Primary key of a record: the key fields of its {@link TableSpec}, by name. */
export type RecordKey = Readonly<Record<string, RecordKeyValue>>;

/** One term of the ordering of a {@link RecordQuery}. */
export interface OrderTerm {
  readonly field: string;
  readonly desc?: boolean;
}

/**
 * What the aggregates of the store ask of a table: fields equal to a value (`null` means "is
 * null"), fields in a list (an empty list matches nothing), a mandatory ordering (so every backend
 * answers in the same order) and an optional limit.
 */
export interface RecordQuery {
  readonly eq?: Readonly<Record<string, string | number | null>>;
  readonly in?: Readonly<Record<string, readonly (string | number)[]>>;
  readonly orderBy: readonly OrderTerm[];
  readonly limit?: number;
}

/**
 * Describes one table of the store to a backend. [proposta] The aggregates of the Phase 3 store
 * (plays, demands, side effects, ...) are written once, over {@link RecordTable}; a backend only
 * stores and finds records, and the same conformance suites run over each backend.
 */
export interface TableSpec<R extends object> {
  /** Table name, lower snake case. */
  readonly name: string;
  /** Validates a whole record; a backend runs it on what it reads back. */
  readonly schema: z.ZodType<R>;
  /** Fields of the primary key, in order. */
  readonly key: readonly (keyof R & string)[];
  /**
   * Fields that hold structured values (objects, arrays, any JSON). A backend with a native
   * representation may use it; SQLite stores them as JSON text, with `null` as SQL `NULL`.
   */
  readonly json: readonly (keyof R & string)[];
}

/**
 * Minimal storage of one kind of record, bound to one view of the data (a transaction, or the
 * committed data). Every method rejects with `Conflict` once its transaction ended and with
 * `AdapterUnavailable` once the store closed.
 */
export interface RecordTable<R extends object> {
  get(key: RecordKey): Promise<R | undefined>;
  /** Rejects with `Conflict` when a record with the same key exists. */
  insert(record: R): Promise<void>;
  /** Rejects with `NotFound` when no record has this key. */
  replace(record: R): Promise<void>;
  /** Resolves `true` when a record was removed. */
  delete(key: RecordKey): Promise<boolean>;
  select(query: RecordQuery): Promise<R[]>;
}

/** Gives the aggregates the table of a spec, in the view they are built for. */
export type TableFactory = <R extends object>(spec: TableSpec<R>) => RecordTable<R>;

/** The key of `record` as a {@link RecordKey}. */
export function keyOfRecord<R extends object>(spec: TableSpec<R>, record: R): RecordKey {
  const key: Record<string, RecordKeyValue> = {};
  for (const field of spec.key) key[field] = record[field] as RecordKeyValue;
  return key;
}
