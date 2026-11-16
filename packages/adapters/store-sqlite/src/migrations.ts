// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '@otheater/core';
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import type { StoreDatabase } from './schema.js';

/**
 * [proposta] Each migration runs in its own transaction (Kysely's SQLite adapter does not wrap
 * them, but SQLite DDL is transactional) and uses `IF NOT EXISTS`, so the window between the DDL
 * and Kysely's bookkeeping row cannot leave a database that refuses to migrate.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's migration helpers are typed over any
function transactional(up: (db: Kysely<any>) => Promise<void>): Migration['up'] {
  return (db) => db.transaction().execute((trx) => up(trx));
}

/**
 * Versioned migrations, in code (nothing reads a folder at run time). Kysely applies them in the
 * alphabetical order of the names, so names are `NNNN_description`; a name, once released, is
 * never renamed or edited: a change is a new migration.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_events': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('events')
        .ifNotExists()
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('type', 'text', (col) => col.notNull())
        .addColumn('timestamp', 'integer', (col) => col.notNull())
        .addColumn('schema_version', 'integer', (col) => col.notNull())
        .addColumn('scenario_id', 'text')
        .addColumn('play_id', 'text')
        .addColumn('attempt_id', 'text')
        .addColumn('payload', 'text', (col) =>
          // Defence in depth: the port already validates the payload as a JSON object.
          col.notNull().check(sql`json_valid(payload)`),
        )
        .execute();

      // [proposta] indexes for the lookups the daemon is known to need: events of a type, and
      // the events of one scenario, play or attempt in id order (partial: most rows have none).
      await db.schema
        .createIndex('events_type_id')
        .ifNotExists()
        .on('events')
        .columns(['type', 'id'])
        .execute();
      for (const column of ['scenario_id', 'play_id', 'attempt_id']) {
        await db.schema
          .createIndex(`events_${column}_id`)
          .ifNotExists()
          .on('events')
          .columns([column, 'id'])
          .where(column, 'is not', null)
          .execute();
      }
    }),
  },
  // [proposta] The attempt registry of Phase 2 (architecture 5.21: the ACP session, the worktree,
  // the last checkpoint and the last event of every attempt, to resume after a restart).
  '0002_attempts': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('attempts')
        .ifNotExists()
        .addColumn('attempt_id', 'text', (col) => col.primaryKey())
        .addColumn('play_id', 'text', (col) => col.notNull())
        .addColumn('demand_id', 'text', (col) => col.notNull())
        .addColumn('attempt', 'integer', (col) => col.notNull())
        .addColumn('client', 'text', (col) => col.notNull())
        .addColumn('profile', 'text', (col) => col.notNull())
        .addColumn('state', 'text', (col) => col.notNull())
        .addColumn('cause', 'text')
        .addColumn('session_id', 'text')
        .addColumn('worktree', 'text', (col) => col.notNull())
        .addColumn('branch', 'text', (col) => col.notNull())
        .addColumn('last_checkpoint', 'text')
        .addColumn('last_checkpoint_at', 'integer')
        .addColumn('last_event_at', 'integer')
        .addColumn('resumes', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('created_at', 'integer', (col) => col.notNull())
        .addColumn('updated_at', 'integer', (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex('attempts_state')
        .ifNotExists()
        .on('attempts')
        .columns(['state', 'created_at'])
        .execute();
    }),
  },
};

/** Applies every pending migration; returns the names applied now (empty when up to date). */
export async function migrateToLatest(db: Kysely<StoreDatabase>): Promise<readonly string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...MIGRATIONS }) },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    // Includes a database written by a newer version (an executed migration this code lacks).
    throw new AdapterUnavailable('Could not migrate the store database', { cause: error });
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
