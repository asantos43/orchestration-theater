// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import type { SqliteDriverName } from './config.js';
import { ImmediateSqliteDialect } from './dialect.js';
import { openRawDatabase } from './driver.js';
import { MIGRATIONS } from './migrations.js';
import type { StoreDatabase } from './schema.js';
import { SqliteStore } from './store.js';
import { DRIVERS, makeTempDir } from './test-helpers.js';

const clock = { now: () => Date.UTC(2026, 0, 1) };

/** The migrations that existed before Phase 3 (0001 to 0003). */
const PHASE_2 = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '0004'));

/** The migrations that existed before Phase 4 (0001 to 0007). */
const PHASE_3 = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '0008'));

/** The migrations that existed before Phase 5 (0001 to 0008). */
const PHASE_4 = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '0009'));

const PHASE_3_TABLES = [
  'scenarios',
  'scenario_repos',
  'attachments',
  'plays',
  'stages',
  'demands',
  'decisions',
  'blackboard',
  'prompt_queue',
  'side_effects',
  'sessions',
  'directives',
];

describe.each(DRIVERS)('Phase 3 migrations on %s', (driver: SqliteDriverName) => {
  it('migrate a Phase 2 database with events and attempts without losing anything', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const path = join(dir, 'phase2.db');

      // A database as the Phase 2 code left it: only 0001 to 0003, with data.
      const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
      raw.exec('PRAGMA journal_mode = WAL');
      const old = new Kysely<StoreDatabase>({
        dialect: new ImmediateSqliteDialect({ database: raw }),
      });
      const migrator = new Migrator({
        db: old,
        provider: { getMigrations: () => Promise.resolve(PHASE_2) },
      });
      const { error } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();
      expect(Object.keys(PHASE_2)).toEqual([
        '0001_events',
        '0002_attempts',
        '0003_attempts_free_resumes',
      ]);
      const addEvent = raw.prepare(
        'INSERT INTO events (type, timestamp, schema_version, scenario_id, play_id, attempt_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      addEvent.run(['play.created', 1000, 1, 'scn-1', 'play-1', null, '{"n":1}']);
      addEvent.run(['attempt.started', 2000, 2, 'scn-1', 'play-1', 'play-1/D1/1', '{"n":2}']);
      raw
        .prepare(
          `INSERT INTO attempts (attempt_id, play_id, demand_id, attempt, client, profile, state,
            worktree, branch, resumes, free_resumes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run([
          'play-1/D1/1',
          'play-1',
          'D1',
          1,
          'claude-code',
          'work',
          'executing',
          '/w',
          'b',
          2,
          1,
          5,
          6,
        ]);
      await old.destroy();

      // The Phase 3 code opens it: the new migrations run, the old data stays.
      const store = await SqliteStore.open({ path, driver }, clock);
      try {
        const events = await store.events.readFrom(0, 10);
        expect(events.map((e) => [e.id, e.type, e.timestamp, e.schemaVersion, e.payload])).toEqual([
          [1, 'play.created', 1000, 1, { n: 1 }],
          [2, 'attempt.started', 2000, 2, { n: 2 }],
        ]);
        expect(events[1]).toMatchObject({
          scenarioId: 'scn-1',
          playId: 'play-1',
          attemptId: 'play-1/D1/1',
        });
        expect(await store.attempts.get('play-1/D1/1')).toMatchObject({
          client: 'claude-code',
          profile: 'work',
          state: 'executing',
          resumes: 2,
          freeResumes: 1,
          createdAt: 5,
          updatedAt: 6,
        });

        // The new aggregates work, and the ids of the old events are not reused.
        expect(await store.scenarios.list()).toEqual([]);
        const appended = await store.events.append({
          type: 'test.happened',
          schemaVersion: 1,
          payload: { n: 3 },
        });
        expect(appended.id).toBe(3);
        await store.directives.create({
          scope: 'global',
          kind: 'instruction',
          text: 'after the migration',
          origin: 'chat',
        });
        expect((await store.directives.get('O1'))?.text).toBe('after the migration');
      } finally {
        await store.close();
      }

      // Every table exists and every migration is recorded, in order.
      const check = await openRawDatabase(driver, path, { readonly: true, busyTimeoutMs: 1000 });
      try {
        const tables = (
          check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all([]) as {
            name: string;
          }[]
        ).map((row) => row.name);
        expect(tables).toEqual(expect.arrayContaining(['events', 'attempts', ...PHASE_3_TABLES]));
        const applied = (
          check.prepare('SELECT name FROM kysely_migration ORDER BY name').all([]) as {
            name: string;
          }[]
        ).map((row) => row.name);
        expect(applied).toEqual(Object.keys(MIGRATIONS));
      } finally {
        check.close();
      }
    } finally {
      await dispose();
    }
  });

  it('the Phase 3 migrations never edit the earlier ones: names are in order', () => {
    const names = Object.keys(MIGRATIONS);
    expect(names).toEqual([...names].sort());
    expect(names.slice(0, 3)).toEqual(Object.keys(PHASE_2));
    for (const name of names) expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });
});

describe.each(DRIVERS)('Phase 4 migration 0008_ideas on %s', (driver: SqliteDriverName) => {
  it('adds the ideas table to a Phase 3 database and keeps its data', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const path = join(dir, 'phase3.db');
      const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
      raw.exec('PRAGMA journal_mode = WAL');
      const old = new Kysely<StoreDatabase>({
        dialect: new ImmediateSqliteDialect({ database: raw }),
      });
      const migrator = new Migrator({
        db: old,
        provider: { getMigrations: () => Promise.resolve(PHASE_3) },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect(Object.keys(PHASE_3).at(-1)).toBe('0007_sessions_directives');
      raw
        .prepare(
          `INSERT INTO directives (id, seq, scope, kind, text, roles, starts_at, timezone, state, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(['O1', 1, 'global', 'instruction', 'kept', '[]', 1, 'UTC', 'active', 'chat', 1, 1]);
      await old.destroy();

      const store = await SqliteStore.open({ path, driver }, clock);
      try {
        expect((await store.directives.get('O1'))?.text).toBe('kept');
        const idea = await store.ideas.create({ scenarioId: 'scn-1', text: 'after 0008' });
        expect(idea).toMatchObject({ id: 'I1', state: 'queued' });
        await store.ideas.transition('I1', 'grouped', { groupId: 'g1', groupOrder: 1 });
        await store.ideas.transition('I1', 'done', {
          playId: 'play-1',
          pullRequest: { number: 3, url: 'https://example.test/pr/3' },
        });
      } finally {
        await store.close();
      }

      // The data of the lifecycle survived a reopen, with the columns as the record fields.
      const again = await SqliteStore.open({ path, driver }, clock);
      try {
        expect(await again.ideas.get('I1')).toMatchObject({
          state: 'done',
          groupId: 'g1',
          groupOrder: 1,
          playId: 'play-1',
          prNumber: 3,
          prUrl: 'https://example.test/pr/3',
        });
      } finally {
        await again.close();
      }

      const check = await openRawDatabase(driver, path, { readonly: true, busyTimeoutMs: 1000 });
      try {
        const columns = (check.prepare('PRAGMA table_info(ideas)').all([]) as { name: string }[])
          .map((column) => column.name)
          .sort();
        expect(columns).toEqual(
          [
            'id',
            'seq',
            'scenario_id',
            'text',
            'area',
            'source',
            'state',
            'group_id',
            'group_order',
            'play_id',
            'pr_number',
            'pr_url',
            'reason',
            'created_at',
            'updated_at',
            'closed_at',
          ].sort(),
        );
        const applied = (
          check.prepare('SELECT name FROM kysely_migration ORDER BY name').all([]) as {
            name: string;
          }[]
        ).map((row) => row.name);
        expect(applied).toContain('0008_ideas');
        expect(applied).toEqual(Object.keys(MIGRATIONS));
      } finally {
        check.close();
      }
    } finally {
      await dispose();
    }
  });
});

const PHASE_5_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  profiles: [
    'id',
    'client',
    'name',
    'kind',
    'provider',
    'state',
    'dir',
    'secret_ref',
    'notice_accepted_at',
    'created_at',
    'updated_at',
    'removed_at',
  ],
  executors: [
    'id',
    'profile_id',
    'model',
    'effort',
    'provider',
    'validity',
    'invalid_reason',
    'created_at',
    'updated_at',
  ],
  interruptions: [
    'id',
    'seq',
    'session_id',
    'play_id',
    'cause',
    'signals',
    'resume_form',
    'from_executor',
    'to_executor',
    'counted_as_attempt',
    'created_at',
    'updated_at',
  ],
  quota_snapshots: [
    'profile_id',
    'window',
    'used_percent',
    'resets_at',
    'source',
    'observed_at',
    'updated_at',
  ],
  usage: [
    'id',
    'seq',
    'session_id',
    'play_id',
    'profile_id',
    'executor_id',
    'model',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'cost_usd',
    'cost_kind',
    'cost_source',
    'pricing_version',
    'occurred_at',
    'created_at',
    'updated_at',
  ],
  wakeups: [
    'id',
    'seq',
    'profile_id',
    'cause',
    'at',
    'state',
    'os_trigger_id',
    'created_at',
    'updated_at',
  ],
};

describe.each(DRIVERS)(
  'Phase 5 migration 0009_profiles_executors_quota_usage on %s',
  (driver: SqliteDriverName) => {
    it('climbs from a Phase 4 database without losing a row and the new tables work', async () => {
      const { dir, dispose } = await makeTempDir();
      try {
        const path = join(dir, 'phase4.db');
        const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
        raw.exec('PRAGMA journal_mode = WAL');
        const old = new Kysely<StoreDatabase>({
          dialect: new ImmediateSqliteDialect({ database: raw }),
        });
        const migrator = new Migrator({
          db: old,
          provider: { getMigrations: () => Promise.resolve(PHASE_4) },
        });
        expect((await migrator.migrateToLatest()).error).toBeUndefined();
        expect(Object.keys(PHASE_4).at(-1)).toBe('0008_ideas');
        // The Phase 4 database holds rows of an event, a directive and an idea.
        raw
          .prepare(
            `INSERT INTO events (type, timestamp, schema_version, payload) VALUES (?, ?, ?, ?)`,
          )
          .run(['test.kept', 1, 1, '{"n":1}']);
        raw
          .prepare(
            `INSERT INTO directives (id, seq, scope, kind, text, roles, starts_at, timezone, state, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(['O1', 1, 'global', 'instruction', 'kept', '[]', 1, 'UTC', 'active', 'chat', 1, 1]);
        raw
          .prepare(
            `INSERT INTO ideas (id, seq, scenario_id, text, source, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(['I1', 1, 'scn-1', 'kept idea', 'chat', 'queued', 1, 1]);
        await old.destroy();

        const store = await SqliteStore.open({ path, driver }, clock);
        try {
          expect((await store.directives.get('O1'))?.text).toBe('kept');
          expect((await store.ideas.get('I1'))?.text).toBe('kept idea');
          expect((await store.events.readFrom(0, 10)).map((e) => e.type)).toEqual(['test.kept']);

          await store.profiles.create({
            client: 'claude-code',
            name: 'work',
            kind: 'token_plan',
            provider: 'anthropic',
            dir: 'profiles/claude-code/work',
          });
          await store.executors.create({
            profileId: 'claude-code/work',
            model: 'opus',
            effort: 'high',
            provider: 'anthropic',
          });
          await store.interruptions.create({
            sessionId: 'ses-1',
            cause: 'quota_exhausted',
            signals: ['rate_limit'],
            countedAsAttempt: true,
          });
          await store.quotaSnapshots.put({
            profileId: 'claude-code/work',
            window: '5h',
            usedPercent: 99.5,
            resetsAt: 9_000,
            source: 'probe',
          });
          await store.usage.record({
            sessionId: 'ses-1',
            profileId: 'claude-code/work',
            executorId: 'opus-high@claude-code/work',
            model: 'opus',
            inputTokens: 10,
            cost: {
              usd: 0.25,
              kind: 'api_equivalent',
              source: 'pricing_table',
              pricingVersion: 'v1',
            },
          });
          await store.wakeups.create({ profileId: 'claude-code/work', cause: 'quota', at: 9_000 });
        } finally {
          await store.close();
        }

        // Everything survived a reopen, with the booleans and the JSON decoded.
        const again = await SqliteStore.open({ path, driver }, clock);
        try {
          expect(await again.interruptions.get('X1')).toMatchObject({
            signals: ['rate_limit'],
            countedAsAttempt: true,
            resumeForm: null,
          });
          expect(await again.quotaSnapshots.get('claude-code/work', '5h')).toMatchObject({
            usedPercent: 99.5,
            resetsAt: 9_000,
          });
          expect(await again.usage.get('U1')).toMatchObject({
            costUsd: 0.25,
            pricingVersion: 'v1',
            outputTokens: null,
          });
          expect((await again.wakeups.list({ dueBy: 9_000 })).map((w) => w.id)).toEqual(['W1']);
          expect((await again.profiles.get('claude-code/work'))?.state).toBe('active');
          expect((await again.executors.list()).map((e) => e.id)).toEqual([
            'opus-high@claude-code/work',
          ]);
        } finally {
          await again.close();
        }

        const check = await openRawDatabase(driver, path, { readonly: true, busyTimeoutMs: 1000 });
        try {
          for (const [table, expected] of Object.entries(PHASE_5_COLUMNS)) {
            const columns = (
              check.prepare(`PRAGMA table_info(${table})`).all([]) as { name: string }[]
            )
              .map((column) => column.name)
              .sort();
            expect(columns).toEqual([...expected].sort());
          }
          expect(check.prepare('PRAGMA foreign_key_check').all([])).toEqual([]);
          const applied = (
            check.prepare('SELECT name FROM kysely_migration ORDER BY name').all([]) as {
              name: string;
            }[]
          ).map((row) => row.name);
          expect(applied.at(-1)).toBe('0011_workflows');
          expect(applied).toEqual(Object.keys(MIGRATIONS));
        } finally {
          check.close();
        }
      } finally {
        await dispose();
      }
    });

    it('the database itself refuses a second scheduled wakeup of a profile and cause', async () => {
      const { dir, dispose } = await makeTempDir();
      try {
        const path = join(dir, 'wakeups.db');
        const store = await SqliteStore.open({ path, driver }, clock);
        await store.close();
        const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
        try {
          const insert = raw.prepare(
            `INSERT INTO wakeups (id, seq, profile_id, cause, at, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          insert.run(['W1', 1, 'codex/a', 'quota', 1, 'scheduled', 1, 1]);
          expect(() => insert.run(['W2', 2, 'codex/a', 'quota', 2, 'scheduled', 1, 1])).toThrow();
          // A settled wakeup of the same pair does not collide, and neither does another cause.
          insert.run(['W3', 3, 'codex/a', 'quota', 2, 'fired', 1, 1]);
          insert.run(['W4', 4, 'codex/a', 'budget', 2, 'scheduled', 1, 1]);
        } finally {
          raw.close();
        }
      } finally {
        await dispose();
      }
    });
  },
);

describe.each(DRIVERS)('Phase 7 migration 0010_setup_runs on %s', (driver: SqliteDriverName) => {
  it('climbs from a 0009 database, creates setup_runs and the table works', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const path = join(dir, 'phase6.db');
      const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
      raw.exec('PRAGMA journal_mode = WAL');
      const old = new Kysely<StoreDatabase>({
        dialect: new ImmediateSqliteDialect({ database: raw }),
      });
      const before = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < '0010'),
      );
      const migrator = new Migrator({
        db: old,
        provider: { getMigrations: () => Promise.resolve(before) },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect(Object.keys(before).at(-1)).toBe('0009_profiles_executors_quota_usage');
      await old.destroy();

      const store = await SqliteStore.open({ path, driver }, clock);
      try {
        const run = await store.setupRuns.create({ flow: 'first_run', step: 'detect' });
        await store.setupRuns.update(run.id, {
          step: 'preset',
          done: [{ step: 'detect', input: {}, output: { clients: ['codex'] } }],
        });
      } finally {
        await store.close();
      }
      const again = await SqliteStore.open({ path, driver }, clock);
      try {
        expect(await again.setupRuns.get('SR1')).toMatchObject({
          step: 'preset',
          state: 'active',
          done: [{ step: 'detect', input: {}, output: { clients: ['codex'] } }],
        });
      } finally {
        await again.close();
      }
    } finally {
      await dispose();
    }
  });

  it('the database itself refuses a second active run of a flow', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const path = join(dir, 'setup.db');
      const store = await SqliteStore.open({ path, driver }, clock);
      await store.close();
      const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
      try {
        const insert = raw.prepare(
          `INSERT INTO setup_runs (id, seq, flow, state, step, done, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insert.run(['SR1', 1, 'first_run', 'active', 'detect', '[]', 1, 1]);
        expect(() => insert.run(['SR2', 2, 'first_run', 'active', 'detect', '[]', 1, 1])).toThrow();
        insert.run(['SR3', 3, 'first_run', 'cancelled', 'detect', '[]', 1, 1]);
        insert.run(['SR4', 4, 'add_account', 'active', 'detect', '[]', 1, 1]);
      } finally {
        raw.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe.each(DRIVERS)('Phase 11b migration 0011_workflows on %s', (driver: SqliteDriverName) => {
  it('climbs from a 0010 database, creates both tables and they work', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const path = join(dir, 'phase11.db');
      const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
      raw.exec('PRAGMA journal_mode = WAL');
      const old = new Kysely<StoreDatabase>({
        dialect: new ImmediateSqliteDialect({ database: raw }),
      });
      const before = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < '0011'),
      );
      const migrator = new Migrator({
        db: old,
        provider: { getMigrations: () => Promise.resolve(before) },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect(Object.keys(before).at(-1)).toBe('0010_setup_runs');
      await old.destroy();

      const store = await SqliteStore.open({ path, driver }, clock);
      try {
        await store.workflowDefinitions.put({
          workflowId: 'play',
          version: '1.0.0',
          hash: `sha256:${'a'.repeat(64)}`,
          definition: { id: 'play', version: '1.0.0' },
          source: 'builtin',
        });
        await store.workflowDefinitions.activate('play', '1.0.0');
        await store.workflowBindings.create({
          scenarioId: 'S1',
          workflowId: 'play',
          budgetUsd: 2.5,
          until: Date.UTC(2026, 0, 2),
          params: { goal: 'ship' },
          triggers: [{ type: 'manual' }],
        });
      } finally {
        await store.close();
      }
      const again = await SqliteStore.open({ path, driver }, clock);
      try {
        expect(await again.workflowDefinitions.active('play')).toMatchObject({
          version: '1.0.0',
          state: 'active',
          definition: { id: 'play', version: '1.0.0' },
        });
        expect(await again.workflowBindings.get('WB1')).toMatchObject({
          state: 'active',
          budgetUsd: 2.5,
          spentUsd: 0,
          params: { goal: 'ship' },
          triggers: [{ type: 'manual' }],
        });
      } finally {
        await again.close();
      }
    } finally {
      await dispose();
    }
  });

  it('the database itself refuses a second active version and a second live binding', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const path = join(dir, 'workflows.db');
      const store = await SqliteStore.open({ path, driver }, clock);
      await store.close();
      const raw = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs: 1000 });
      try {
        const definition = raw.prepare(
          `INSERT INTO workflow_definitions
               (workflow_id, version, seq, hash, definition, source, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        definition.run(['play', '1.0.0', 1, 'h', '{}', 'builtin', 'active', 1, 1]);
        expect(() =>
          definition.run(['play', '1.1.0', 2, 'h', '{}', 'builtin', 'active', 1, 1]),
        ).toThrow();
        definition.run(['play', '1.1.0', 2, 'h', '{}', 'builtin', 'inactive', 1, 1]);
        definition.run(['other', '1.0.0', 3, 'h', '{}', 'builtin', 'active', 1, 1]);

        const binding = raw.prepare(
          `INSERT INTO workflow_bindings
               (id, seq, scenario_id, workflow_id, version_range, params, triggers, state,
                budget_period, spent_usd, period_started_at, concurrency, on_busy, created_at,
                updated_at, state_changed_at)
             VALUES (?, ?, ?, ?, '*', '{}', '[]', ?, 'day', 0, 1, 1, 'queue', 1, 1, 1)`,
        );
        binding.run(['WB1', 1, 'S1', 'play', 'active']);
        expect(() => binding.run(['WB2', 2, 'S1', 'play', 'paused'])).toThrow();
        binding.run(['WB3', 3, 'S1', 'play', 'stopped']);
        binding.run(['WB4', 4, 'S2', 'play', 'active']);
      } finally {
        raw.close();
      }
    } finally {
      await dispose();
    }
  });
});
