// SPDX-License-Identifier: MPL-2.0
import {
  CompiledQuery,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type Driver,
  type SqliteDialectConfig,
} from 'kysely';

/**
 * Kysely's driver starts transactions with a plain `BEGIN` (deferred): the write lock is only
 * taken at the first write, so a transaction that reads first can fail with `SQLITE_BUSY_SNAPSHOT`
 * if anything else wrote in between. [proposta] The store's transactions take the write lock up
 * front with `BEGIN IMMEDIATE`: they are serialized anyway, and a lock conflict then shows at once
 * (and is waited out by `busy_timeout`) instead of half-way through the body.
 */
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }
}

/** `SqliteDialect` whose transactions are `BEGIN IMMEDIATE`. */
export class ImmediateSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }

  override createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#config);
  }
}
