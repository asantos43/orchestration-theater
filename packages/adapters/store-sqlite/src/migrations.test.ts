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
        expect(applied.at(-1)).toBe('0008_ideas');
        expect(applied).toEqual(Object.keys(MIGRATIONS));
      } finally {
        check.close();
      }
    } finally {
      await dispose();
    }
  });
});
