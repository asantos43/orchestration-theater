// SPDX-License-Identifier: MPL-2.0
import { Conflict, NotFound } from '../errors.js';
import {
  keyOfRecord,
  type RecordKey,
  type RecordQuery,
  type RecordTable,
  type TableFactory,
  type TableSpec,
} from '../store-kit/record-table.js';

type Rows = Map<string, object>;

/** Stable text of a key, in the order of the spec (`["play-1","D1"]`). */
function keyText(fields: readonly string[], key: RecordKey): string {
  return JSON.stringify(fields.map((field) => key[field]));
}

/** SQLite order: `null` first, then numbers or text in their natural order. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

/**
 * The tables of {@link InMemoryStore}: plain maps of records, one per table name. On its own it
 * commits every write at once. `InMemoryStore` uses `fork()` to give each transaction a private
 * copy that `commit()` publishes and `discard()` drops, as `InMemoryEventLog` does, so the
 * rollback of the in-memory store is faithful.
 */
export class InMemoryTables {
  readonly #tables = new Map<string, Rows>();
  readonly #base: InMemoryTables | undefined;
  #finished = false;

  constructor(base?: InMemoryTables) {
    this.#base = base;
    if (base !== undefined) {
      // Records are never mutated in place (writes replace them), so copying the maps is enough.
      for (const [name, rows] of base.#tables) this.#tables.set(name, new Map(rows));
    }
  }

  /** The table of a spec in this view; it throws `Conflict` once the transaction ended. */
  readonly factory: TableFactory = <R extends object>(spec: TableSpec<R>): RecordTable<R> =>
    new MemoryTable(spec, this.#rows(spec.name), () => {
      if (this.#finished) throw new Conflict('The transaction already ended');
    });

  /** A transaction copy of these (committed) tables. */
  fork(): InMemoryTables {
    return new InMemoryTables(this);
  }

  /** Publishes the copy into its base and ends it. */
  commit(): void {
    if (this.#base === undefined) throw new Conflict('Only a fork can be committed');
    for (const [name, rows] of this.#tables) {
      const target = this.#base.#rows(name);
      target.clear();
      for (const [key, record] of rows) target.set(key, record);
    }
    this.#finish();
  }

  /** Drops the copy and ends it. */
  discard(): void {
    this.#finish();
  }

  #finish(): void {
    this.#finished = true;
    this.#tables.clear();
  }

  #rows(name: string): Rows {
    let rows = this.#tables.get(name);
    if (rows === undefined) {
      rows = new Map();
      this.#tables.set(name, rows);
    }
    return rows;
  }
}

class MemoryTable<R extends object> implements RecordTable<R> {
  constructor(
    private readonly spec: TableSpec<R>,
    private readonly rows: Rows,
    private readonly assertLive: () => void,
  ) {}

  get(key: RecordKey): Promise<R | undefined> {
    return this.run(() => {
      const found = this.rows.get(keyText(this.spec.key, key)) as R | undefined;
      return found === undefined ? undefined : structuredClone(found);
    });
  }

  insert(record: R): Promise<void> {
    return this.run(() => {
      const key = keyText(this.spec.key, keyOfRecord(this.spec, record));
      if (this.rows.has(key)) throw new Conflict(`${this.spec.name} ${key} already exists`);
      this.rows.set(key, structuredClone(record));
    });
  }

  replace(record: R): Promise<void> {
    return this.run(() => {
      const key = keyText(this.spec.key, keyOfRecord(this.spec, record));
      if (!this.rows.has(key)) throw new NotFound(`${this.spec.name} ${key} does not exist`);
      this.rows.set(key, structuredClone(record));
    });
  }

  delete(key: RecordKey): Promise<boolean> {
    return this.run(() => this.rows.delete(keyText(this.spec.key, key)));
  }

  select(query: RecordQuery): Promise<R[]> {
    return this.run(() => {
      const eq = Object.entries(query.eq ?? {});
      const within = Object.entries(query.in ?? {});
      const ranges = Object.entries(query.ranges ?? {});
      const matches = [...this.rows.values()].filter((row) => {
        const fields = row as Record<string, unknown>;
        return (
          eq.every(([field, value]) => fields[field] === value) &&
          within.every(([field, values]) => values.includes(fields[field] as string | number)) &&
          ranges.every(([field, bounds]) => {
            const value = fields[field];
            if (typeof value !== 'number') return false;
            return (
              (bounds.gte === undefined || value >= bounds.gte) &&
              (bounds.lte === undefined || value <= bounds.lte)
            );
          })
        );
      }) as R[];
      matches.sort((a, b) => {
        for (const { field, desc } of query.orderBy) {
          const order = compareValues(
            (a as Record<string, unknown>)[field],
            (b as Record<string, unknown>)[field],
          );
          if (order !== 0) return desc === true ? -order : order;
        }
        return 0;
      });
      return structuredClone(query.limit === undefined ? matches : matches.slice(0, query.limit));
    });
  }

  private run<T>(fn: () => T): Promise<T> {
    try {
      this.assertLive();
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
