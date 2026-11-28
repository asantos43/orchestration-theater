// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '@otheater/core';
import { sql, type ColumnDefinitionBuilder, type Kysely } from 'kysely';
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

const notNull = (col: ColumnDefinitionBuilder): ColumnDefinitionBuilder => col.notNull();

/**
 * A column that holds JSON as text (defence in depth: the port already validated it). The JSON
 * `null` is stored as SQL `NULL`, so a column that may hold it passes `nullable`.
 */
function jsonColumn(name: string, nullable = false) {
  return (col: ColumnDefinitionBuilder): ColumnDefinitionBuilder => {
    const checked = col.check(sql`${sql.ref(name)} is null or json_valid(${sql.ref(name)})`);
    return nullable ? checked : checked.notNull();
  };
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
  // [proposta] Free resumes (architecture 5.16, `resume.max_free_resumes`) survive a daemon
  // restart. Additive: rows written before this migration read as 0.
  '0003_attempts_free_resumes': {
    up: transactional(async (db) => {
      const columns = await db.introspection.getTables();
      const attempts = columns.find((table) => table.name === 'attempts');
      // `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` in SQLite: look first, so a database
      // that got the column but lost Kysely's bookkeeping row still migrates.
      if (attempts?.columns.some((column) => column.name === 'free_resumes') === true) return;
      await db.schema
        .alterTable('attempts')
        .addColumn('free_resumes', 'integer', (col) => col.notNull().defaultTo(0))
        .execute();
    }),
  },
  // [proposta] The aggregates of Phase 3 (architecture section 7), one migration per group.
  // There are no foreign keys: the daemon writes the aggregates in the order it needs, inside one
  // transaction, and the ports check the references that matter. JSON is stored as text and read
  // back through the zod schema of the port. Enum-like columns carry no CHECK, so a new state is
  // a change of the port, not of the database.
  '0004_scenarios': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('scenarios')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('kind', 'text', notNull)
        .addColumn('flow_id', 'text', notNull)
        .addColumn('name', 'text', notNull)
        .addColumn('folder', 'text', notNull)
        .addColumn('profile', 'text')
        .addColumn('conventions', 'text', jsonColumn('conventions', true))
        .addColumn('base_branch', 'text')
        .addColumn('config_override', 'text', jsonColumn('config_override'))
        .addColumn('origin_scenario_id', 'text')
        .addColumn('director_state', 'text', notNull)
        .addColumn('state', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .execute();
      await db.schema
        .createIndex('scenarios_state')
        .ifNotExists()
        .on('scenarios')
        .columns(['state', 'created_at'])
        .execute();

      await db.schema
        .createTable('scenario_repos')
        .ifNotExists()
        .addColumn('scenario_id', 'text', notNull)
        .addColumn('path', 'text', notNull)
        .addColumn('remote', 'text')
        .addColumn('main_branch', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addPrimaryKeyConstraint('scenario_repos_pk', ['scenario_id', 'path'])
        .execute();

      await db.schema
        .createTable('attachments')
        .ifNotExists()
        .addColumn('scenario_id', 'text', notNull)
        .addColumn('id', 'text', notNull)
        .addColumn('seq', 'integer', notNull)
        .addColumn('message_id', 'text')
        .addColumn('name', 'text', notNull)
        .addColumn('mime', 'text', notNull)
        .addColumn('size', 'integer', notNull)
        .addColumn('hash', 'text', notNull)
        .addColumn('source', 'text', notNull)
        .addColumn('path', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addPrimaryKeyConstraint('attachments_pk', ['scenario_id', 'id'])
        .execute();
      // `A<n>` is numbered per scenario: a number never repeats inside one.
      await db.schema
        .createIndex('attachments_scenario_seq')
        .ifNotExists()
        .unique()
        .on('attachments')
        .columns(['scenario_id', 'seq'])
        .execute();
    }),
  },
  '0005_plays': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('plays')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('scenario_id', 'text', notNull)
        .addColumn('need', 'text', notNull)
        .addColumn('flow_id', 'text', notNull)
        .addColumn('flow_version', 'integer', notNull)
        .addColumn('state', 'text', notNull)
        .addColumn('snapshot', 'text', jsonColumn('snapshot', true))
        .addColumn('counters', 'text', jsonColumn('counters'))
        .addColumn('parent_play_id', 'text')
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('finished_at', 'integer')
        .execute();
      await db.schema
        .createIndex('plays_scenario')
        .ifNotExists()
        .on('plays')
        .columns(['scenario_id', 'created_at'])
        .execute();

      await db.schema
        .createTable('stages')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('play_id', 'text', notNull)
        .addColumn('name', 'text', notNull)
        .addColumn('role', 'text', notNull)
        .addColumn('attempt_id', 'text')
        .addColumn('demand_id', 'text')
        .addColumn('state', 'text', notNull)
        .addColumn('result', 'text', jsonColumn('result', true))
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('ended_at', 'integer')
        .execute();
      await db.schema
        .createIndex('stages_play')
        .ifNotExists()
        .on('stages')
        .columns(['play_id', 'created_at'])
        .execute();

      await db.schema
        .createTable('demands')
        .ifNotExists()
        .addColumn('play_id', 'text', notNull)
        .addColumn('id', 'text', notNull)
        .addColumn('title', 'text', notNull)
        .addColumn('description', 'text', notNull)
        .addColumn('depends_on', 'text', jsonColumn('depends_on'))
        .addColumn('contract', 'text', jsonColumn('contract'))
        .addColumn('expected_files', 'text', jsonColumn('expected_files'))
        .addColumn('complexity', 'text', notNull)
        .addColumn('specialty', 'text')
        .addColumn('timeout_min', 'integer', notNull)
        .addColumn('acceptance_criteria', 'text', jsonColumn('acceptance_criteria'))
        .addColumn('verify', 'text', jsonColumn('verify'))
        .addColumn('verify_waiver', 'text')
        .addColumn('state', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addPrimaryKeyConstraint('demands_pk', ['play_id', 'id'])
        .execute();
      await db.schema
        .createIndex('demands_state')
        .ifNotExists()
        .on('demands')
        .columns(['state', 'created_at'])
        .execute();

      await db.schema
        .createTable('decisions')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('scenario_id', 'text', notNull)
        .addColumn('play_id', 'text')
        .addColumn('kind', 'text', notNull)
        .addColumn('input', 'text', jsonColumn('input'))
        .addColumn('answer', 'text', jsonColumn('answer', true))
        .addColumn('decided_by', 'text')
        .addColumn('state', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('decided_at', 'integer')
        .execute();
      await db.schema
        .createIndex('decisions_state')
        .ifNotExists()
        .on('decisions')
        .columns(['state', 'created_at'])
        .execute();
    }),
  },
  // What the daemon writes before it acts (5.21): the blackboard, the prompt queue and the side
  // effects.
  '0006_blackboard_queue_side_effects': {
    up: transactional(async (db) => {
      // A version is a row of its own and is never updated: the key is `(play, key, version)`.
      await db.schema
        .createTable('blackboard')
        .ifNotExists()
        .addColumn('play_id', 'text', notNull)
        .addColumn('key', 'text', notNull)
        .addColumn('version', 'integer', notNull)
        // The JSON `null` is a legal value, stored as SQL `NULL`.
        .addColumn('value', 'text', jsonColumn('value', true))
        .addColumn('author', 'text')
        .addColumn('created_at', 'integer', notNull)
        .addPrimaryKeyConstraint('blackboard_pk', ['play_id', 'key', 'version'])
        .execute();

      await db.schema
        .createTable('prompt_queue')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('scenario_id', 'text', notNull)
        .addColumn('source', 'text', notNull)
        .addColumn('priority', 'integer', notNull)
        .addColumn('content', 'text', jsonColumn('content'))
        .addColumn('state', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('delivered_at', 'integer')
        .execute();
      // The pending prompts of a scenario, in the order they are looked at.
      await db.schema
        .createIndex('prompt_queue_pending')
        .ifNotExists()
        .on('prompt_queue')
        .columns(['state', 'scenario_id', 'priority', 'seq'])
        .execute();

      await db.schema
        .createTable('side_effects')
        .ifNotExists()
        .addColumn('idempotency_key', 'text', (col) => col.primaryKey())
        .addColumn('type', 'text', notNull)
        .addColumn('target', 'text', notNull)
        .addColumn('attempt_id', 'text')
        .addColumn('params', 'text', jsonColumn('params', true))
        .addColumn('result', 'text', jsonColumn('result', true))
        .addColumn('state', 'text', notNull)
        .addColumn('verifier', 'text')
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('resolved_at', 'integer')
        .execute();
      await db.schema
        .createIndex('side_effects_state')
        .ifNotExists()
        .on('side_effects')
        .columns(['state', 'created_at'])
        .execute();
    }),
  },
  '0007_sessions_directives': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('sessions')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('client', 'text', notNull)
        .addColumn('profile', 'text', notNull)
        .addColumn('role', 'text')
        .addColumn('attempt_id', 'text')
        .addColumn('worktree', 'text')
        .addColumn('client_session_id', 'text')
        .addColumn('pid', 'integer')
        .addColumn('process_started_at', 'integer')
        .addColumn('state', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('ended_at', 'integer')
        .execute();
      await db.schema
        .createIndex('sessions_state')
        .ifNotExists()
        .on('sessions')
        .columns(['state', 'created_at'])
        .execute();

      await db.schema
        .createTable('directives')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('scope', 'text', notNull)
        .addColumn('scenario_id', 'text')
        .addColumn('kind', 'text', notNull)
        .addColumn('text', 'text', notNull)
        .addColumn('rule_key', 'text')
        .addColumn('rule_value', 'text', jsonColumn('rule_value', true))
        .addColumn('suspends_id', 'text')
        .addColumn('roles', 'text', jsonColumn('roles'))
        .addColumn('starts_at', 'integer', notNull)
        .addColumn('ends_at', 'integer')
        .addColumn('timezone', 'text', notNull)
        .addColumn('state', 'text', notNull)
        .addColumn('origin', 'text', notNull)
        .addColumn('replaces_id', 'text')
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('revoked_at', 'integer')
        .addColumn('revoke_reason', 'text')
        .execute();
      await db.schema
        .createIndex('directives_scope')
        .ifNotExists()
        .on('directives')
        .columns(['scope', 'scenario_id', 'state'])
        .execute();
    }),
  },
  // The idea queue of a scenario (5.20, N91): ideas wait here to be grouped into the need of a
  // play. No foreign keys, like the other aggregates: the daemon keeps the links.
  '0008_ideas': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('ideas')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('scenario_id', 'text', notNull)
        .addColumn('text', 'text', notNull)
        .addColumn('area', 'text')
        .addColumn('source', 'text', notNull)
        .addColumn('state', 'text', notNull)
        .addColumn('group_id', 'text')
        .addColumn('group_order', 'integer')
        .addColumn('play_id', 'text')
        .addColumn('pr_number', 'integer')
        .addColumn('pr_url', 'text')
        .addColumn('reason', 'text')
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('closed_at', 'integer')
        .execute();
      // The queue of a scenario, and the ideas of a play.
      await db.schema
        .createIndex('ideas_queue')
        .ifNotExists()
        .on('ideas')
        .columns(['scenario_id', 'state', 'seq'])
        .execute();
      await db.schema
        .createIndex('ideas_play')
        .ifNotExists()
        .on('ideas')
        .columns(['play_id'])
        .execute();
    }),
  },
  // The tables of Phase 5 (section 7, P1): profiles, Executors, interruptions, the last quota
  // reading per window, the usage of each turn and the wakeups. No foreign keys, like the other
  // aggregates: an Executor outlives its profile on purpose (it only turns `invalid`, 5.7), and
  // the daemon keeps the other links.
  '0009_profiles_executors_quota_usage': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('profiles')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('client', 'text', notNull)
        .addColumn('name', 'text', notNull)
        .addColumn('kind', 'text', notNull)
        .addColumn('provider', 'text', notNull)
        .addColumn('state', 'text', notNull)
        .addColumn('dir', 'text', notNull)
        .addColumn('secret_ref', 'text')
        .addColumn('notice_accepted_at', 'integer')
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('removed_at', 'integer')
        .execute();
      // The profiles of a provider (the second-account notice) and of a state (the active ones).
      await db.schema
        .createIndex('profiles_provider')
        .ifNotExists()
        .on('profiles')
        .columns(['provider', 'state'])
        .execute();

      await db.schema
        .createTable('executors')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('profile_id', 'text', notNull)
        .addColumn('model', 'text', notNull)
        .addColumn('effort', 'text')
        .addColumn('provider', 'text', notNull)
        .addColumn('validity', 'text', notNull)
        .addColumn('invalid_reason', 'text')
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .execute();
      await db.schema
        .createIndex('executors_profile')
        .ifNotExists()
        .on('executors')
        .columns(['profile_id', 'validity'])
        .execute();

      await db.schema
        .createTable('interruptions')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('session_id', 'text', notNull)
        .addColumn('play_id', 'text')
        .addColumn('cause', 'text', notNull)
        .addColumn('signals', 'text', jsonColumn('signals'))
        .addColumn('resume_form', 'text')
        .addColumn('from_executor', 'text')
        .addColumn('to_executor', 'text')
        .addColumn('counted_as_attempt', 'integer', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .execute();
      await db.schema
        .createIndex('interruptions_session')
        .ifNotExists()
        .on('interruptions')
        .columns(['session_id', 'seq'])
        .execute();
      await db.schema
        .createIndex('interruptions_play')
        .ifNotExists()
        .on('interruptions')
        .columns(['play_id', 'seq'])
        .execute();

      // The latest reading of each window of each profile: one row per pair.
      await db.schema
        .createTable('quota_snapshots')
        .ifNotExists()
        .addColumn('profile_id', 'text', notNull)
        .addColumn('window', 'text', notNull)
        .addColumn('used_percent', 'real', notNull)
        .addColumn('resets_at', 'integer')
        .addColumn('source', 'text', notNull)
        .addColumn('observed_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addPrimaryKeyConstraint('quota_snapshots_pk', ['profile_id', 'window'])
        .execute();

      await db.schema
        .createTable('usage')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('session_id', 'text', notNull)
        .addColumn('play_id', 'text')
        .addColumn('profile_id', 'text', notNull)
        .addColumn('executor_id', 'text', notNull)
        .addColumn('model', 'text', notNull)
        .addColumn('input_tokens', 'integer')
        .addColumn('output_tokens', 'integer')
        .addColumn('cached_tokens', 'integer')
        .addColumn('cost_usd', 'real')
        .addColumn('cost_kind', 'text')
        .addColumn('cost_source', 'text')
        .addColumn('pricing_version', 'text')
        .addColumn('occurred_at', 'integer', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .execute();
      // Consumption of a profile within a window of time, and of a session.
      await db.schema
        .createIndex('usage_profile_time')
        .ifNotExists()
        .on('usage')
        .columns(['profile_id', 'occurred_at'])
        .execute();
      await db.schema
        .createIndex('usage_session')
        .ifNotExists()
        .on('usage')
        .columns(['session_id', 'occurred_at'])
        .execute();

      await db.schema
        .createTable('wakeups')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('profile_id', 'text', notNull)
        .addColumn('cause', 'text', notNull)
        .addColumn('at', 'integer', notNull)
        .addColumn('state', 'text', notNull)
        .addColumn('os_trigger_id', 'text')
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .execute();
      // At most one scheduled wakeup per profile and cause (the registry checks it too).
      await sql`
        create unique index if not exists wakeups_one_scheduled
        on wakeups (profile_id, cause) where state = 'scheduled'
      `.execute(db);
      await db.schema
        .createIndex('wakeups_due')
        .ifNotExists()
        .on('wakeups')
        .columns(['state', 'at'])
        .execute();
    }),
  },
  // The runs of the setup assistant (Phase 7, 5.7, N121): the answers of a run in progress, so it
  // survives the TUI closing and a daemon restart. No foreign keys, like the other aggregates.
  '0010_setup_runs': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('setup_runs')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('flow', 'text', notNull)
        .addColumn('state', 'text', notNull)
        .addColumn('step', 'text', notNull)
        .addColumn('done', 'text', jsonColumn('done'))
        .addColumn('result', 'text', jsonColumn('result', true))
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('finished_at', 'integer')
        .execute();
      // At most one active run per flow (the registry checks it too).
      await sql`
        create unique index if not exists setup_runs_one_active
        on setup_runs (flow) where state = 'active'
      `.execute(db);
    }),
  },
  // The workflow library and the bindings of the scenarios (Phase 11b, P5, N296). No foreign
  // keys, like the other aggregates. [proposta] Every column.
  '0011_workflows': {
    up: transactional(async (db) => {
      await db.schema
        .createTable('workflow_definitions')
        .ifNotExists()
        .addColumn('workflow_id', 'text', notNull)
        .addColumn('version', 'text', notNull)
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('hash', 'text', notNull)
        .addColumn('definition', 'text', jsonColumn('definition'))
        .addColumn('source', 'text', notNull)
        .addColumn('package_id', 'text')
        .addColumn('state', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('activated_at', 'integer')
        .addPrimaryKeyConstraint('workflow_definitions_pk', ['workflow_id', 'version'])
        .execute();
      // At most one active version per workflow (the registry checks it too).
      await sql`
        create unique index if not exists workflow_definitions_one_active
        on workflow_definitions (workflow_id) where state = 'active'
      `.execute(db);

      await db.schema
        .createTable('workflow_bindings')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('seq', 'integer', (col) => col.notNull().unique())
        .addColumn('scenario_id', 'text', notNull)
        .addColumn('workflow_id', 'text', notNull)
        .addColumn('version_range', 'text', notNull)
        .addColumn('params', 'text', jsonColumn('params'))
        .addColumn('triggers', 'text', jsonColumn('triggers'))
        .addColumn('state', 'text', notNull)
        .addColumn('state_reason', 'text')
        .addColumn('until', 'integer')
        .addColumn('budget_usd', 'real')
        .addColumn('budget_period', 'text', notNull)
        .addColumn('spent_usd', 'real', notNull)
        .addColumn('period_started_at', 'integer', notNull)
        .addColumn('concurrency', 'integer', notNull)
        .addColumn('on_busy', 'text', notNull)
        .addColumn('created_at', 'integer', notNull)
        .addColumn('updated_at', 'integer', notNull)
        .addColumn('state_changed_at', 'integer', notNull)
        .execute();
      // At most one live binding per scenario and workflow (the registry checks it too).
      await sql`
        create unique index if not exists workflow_bindings_one_live
        on workflow_bindings (scenario_id, workflow_id) where state in ('active', 'paused')
      `.execute(db);
      await db.schema
        .createIndex('workflow_bindings_scenario')
        .ifNotExists()
        .on('workflow_bindings')
        .columns(['scenario_id', 'state'])
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
