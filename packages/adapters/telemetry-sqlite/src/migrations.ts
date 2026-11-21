// SPDX-License-Identifier: MPL-2.0
import { sql, type ColumnDefinitionBuilder, type Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import { TelemetryMigrationFailed } from './errors.js';
import type { TelemetryDatabase } from './schema.js';

/**
 * Each migration runs in its own transaction (Kysely's SQLite adapter does not wrap them, but
 * SQLite DDL is transactional) and uses `IF NOT EXISTS`, as in the store.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's migration helpers are typed over any
function transactional(up: (db: Kysely<any>) => Promise<void>): Migration['up'] {
  return (db) => db.transaction().execute((trx) => up(trx));
}

/** A column that holds JSON as text (defence in depth: the adapter already serialized it). */
function jsonColumn(name: string, nullable = false) {
  return (col: ColumnDefinitionBuilder): ColumnDefinitionBuilder => {
    const checked = col.check(sql`${sql.ref(name)} is null or json_valid(${sql.ref(name)})`);
    return nullable ? checked : checked.notNull();
  };
}

const CORRELATION = ['scenario_id', 'play_id', 'attempt_id', 'session_id'] as const;

/**
 * Versioned migrations, in code. Kysely applies them in the alphabetical order of the names, so
 * names are `NNNN_description`; a name, once released, is never renamed or edited.
 *
 * [proposta] Indexes: the time of each signal (the window of a read and the cut of the
 * retention), and each correlation id with the time (partial: most rows carry only some of them),
 * which is what "everything of this attempt" asks.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_telemetry': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('meta')
        .ifNotExists()
        .addColumn('key', 'text', (col) => col.primaryKey())
        .addColumn('value', 'text', (col) => col.notNull())
        .execute();
      await sql`insert or ignore into meta (key, value) values ('format', 'otheater-telemetry')`.execute(
        db,
      );

      await db.schema
        .createTable('resources')
        .ifNotExists()
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('hash', 'text', (col) => col.notNull().unique())
        .addColumn('attributes', 'text', jsonColumn('attributes'))
        .execute();

      await db.schema
        .createTable('spans')
        .ifNotExists()
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('resource_id', 'integer', (col) => col.notNull().references('resources.id'))
        .addColumn('trace_id', 'text', (col) => col.notNull())
        .addColumn('span_id', 'text', (col) => col.notNull())
        .addColumn('parent_span_id', 'text')
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('kind', 'integer', (col) => col.notNull())
        .addColumn('start_ms', 'integer', (col) => col.notNull())
        .addColumn('start_sub_ns', 'integer', (col) => col.notNull())
        .addColumn('end_ms', 'integer', (col) => col.notNull())
        .addColumn('end_sub_ns', 'integer', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull())
        .addColumn('status_message', 'text')
        .addColumn('attributes', 'text', jsonColumn('attributes'))
        .addColumn('scenario_id', 'text')
        .addColumn('play_id', 'text')
        .addColumn('attempt_id', 'text')
        .addColumn('session_id', 'text')
        .execute();

      await db.schema
        .createTable('metric_points')
        .ifNotExists()
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('resource_id', 'integer', (col) => col.notNull().references('resources.id'))
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('unit', 'text')
        .addColumn('kind', 'text', (col) => col.notNull())
        .addColumn('time_ms', 'integer', (col) => col.notNull())
        .addColumn('time_sub_ns', 'integer', (col) => col.notNull())
        .addColumn('start_ms', 'integer')
        .addColumn('start_sub_ns', 'integer')
        .addColumn('value', 'real', (col) => col.notNull())
        .addColumn('detail', 'text', jsonColumn('detail', true))
        .addColumn('attributes', 'text', jsonColumn('attributes'))
        .addColumn('scenario_id', 'text')
        .addColumn('play_id', 'text')
        .addColumn('attempt_id', 'text')
        .addColumn('session_id', 'text')
        .execute();

      await db.schema
        .createTable('log_records')
        .ifNotExists()
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('resource_id', 'integer', (col) => col.notNull().references('resources.id'))
        .addColumn('time_ms', 'integer', (col) => col.notNull())
        .addColumn('time_sub_ns', 'integer', (col) => col.notNull())
        .addColumn('severity', 'integer')
        .addColumn('severity_text', 'text')
        .addColumn('body', 'text')
        .addColumn('trace_id', 'text')
        .addColumn('span_id', 'text')
        .addColumn('attributes', 'text', jsonColumn('attributes'))
        .addColumn('scenario_id', 'text')
        .addColumn('play_id', 'text')
        .addColumn('attempt_id', 'text')
        .addColumn('session_id', 'text')
        .execute();

      const timeColumn = { spans: 'start_ms', metric_points: 'time_ms', log_records: 'time_ms' };
      for (const [table, column] of Object.entries(timeColumn)) {
        await db.schema
          .createIndex(`${table}_${column}`)
          .ifNotExists()
          .on(table)
          .columns([column, 'id'])
          .execute();
        for (const id of CORRELATION) {
          await db.schema
            .createIndex(`${table}_${id}`)
            .ifNotExists()
            .on(table)
            .columns([id, column])
            .where(id, 'is not', null)
            .execute();
        }
      }
      await db.schema
        .createIndex('spans_end_ms')
        .ifNotExists()
        .on('spans')
        .column('end_ms')
        .execute();
      await db.schema
        .createIndex('spans_trace_id')
        .ifNotExists()
        .on('spans')
        .columns(['trace_id', 'span_id'])
        .execute();
      await db.schema
        .createIndex('metric_points_name')
        .ifNotExists()
        .on('metric_points')
        .columns(['name', 'time_ms'])
        .execute();
    }),
  },
  /**
   * P4 of Phase 8: a span is identified by `(trace_id, span_id)`, so the daemon can project its
   * spans from the event log again and get the same rows. A duplicate already in the base (nothing
   * wrote one on purpose; a client that exported twice could) keeps its first row. The index
   * replaces the plain one of `0001`, which had the same columns.
   */
  '0002_span_identity': {
    up: transactional(async (db) => {
      await sql`
        delete from spans
        where id not in (select min(id) from spans group by trace_id, span_id)`.execute(db);
      await sql`drop index if exists spans_trace_id`.execute(db);
      await db.schema
        .createIndex('spans_trace_span')
        .ifNotExists()
        .unique()
        .on('spans')
        .columns(['trace_id', 'span_id'])
        .execute();
    }),
  },
  /**
   * The daily aggregates of the analysis (Phase 8, P9; N217 (a)). [proposta] They live apart from
   * the raw tables because their retention is another one (`analysis.retention.days`), and the
   * purge of the raw telemetry (P8) never touches them. The primary key makes a row one number of
   * one group in one origin; the day is the leading column, so a range of days and the retention
   * cut are index reads.
   */
  '0003_rollups_daily': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('rollups_daily')
        .ifNotExists()
        .addColumn('day', 'text', (col) =>
          col.notNull().check(sql`"day" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
        )
        .addColumn('scenario_id', 'text', (col) => col.notNull())
        .addColumn('executor', 'text', (col) => col.notNull())
        .addColumn('role', 'text', (col) => col.notNull())
        .addColumn('metric', 'text', (col) => col.notNull())
        .addColumn('facet', 'text', (col) => col.notNull())
        .addColumn('origin', 'text', (col) => col.notNull())
        .addColumn('count', 'integer', (col) => col.notNull().check(sql`"count" >= 0`))
        .addColumn('sum', 'real')
        .addColumn('p50', 'real')
        .addColumn('p95', 'real')
        .addColumn('max', 'real')
        .addPrimaryKeyConstraint('rollups_daily_pk', [
          'day',
          'scenario_id',
          'executor',
          'role',
          'metric',
          'facet',
          'origin',
        ])
        .execute();
    }),
  },
};

/** Applies every pending migration; returns the names applied now (empty when up to date). */
export async function migrateToLatest(db: Kysely<TelemetryDatabase>): Promise<readonly string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...MIGRATIONS }) },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    // Includes a database written by a newer version (an executed migration this code lacks).
    throw new TelemetryMigrationFailed('Could not migrate the telemetry database', {
      cause: error,
    });
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
