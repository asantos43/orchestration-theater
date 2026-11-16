// SPDX-License-Identifier: MPL-2.0
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterUnavailable, InvalidInput, isOTheaterError } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { SqliteDriverName } from './config.js';
import { openRawDatabase, type RawDatabase } from './driver.js';
import { MIGRATIONS } from './migrations.js';
import { SqliteStore, writerPragmas } from './store.js';
import { DRIVERS, makeTempDir, openTempStore } from './test-helpers.js';

const event = (n: number) => ({ type: 'test.happened', schemaVersion: 1, payload: { n } });

describe('writerPragmas', () => {
  const config = { synchronous: 'full', busyTimeoutMs: 1234 } as const;

  it('sets WAL, synchronous, foreign keys and the busy timeout', () => {
    expect(writerPragmas(config, 'linux')).toEqual([
      'PRAGMA busy_timeout = 1234',
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = FULL',
      'PRAGMA foreign_keys = ON',
    ]);
    expect(writerPragmas({ ...config, synchronous: 'normal' }, 'linux')).toContain(
      'PRAGMA synchronous = NORMAL',
    );
  });

  it('adds fullfsync and checkpoint_fullfsync on macOS only', () => {
    expect(writerPragmas(config, 'darwin')).toEqual(
      expect.arrayContaining(['PRAGMA fullfsync = ON', 'PRAGMA checkpoint_fullfsync = ON']),
    );
    expect(writerPragmas(config, 'win32').join()).not.toContain('fullfsync');
  });
});

describe.each(DRIVERS)('SqliteStore on %s', (driver) => {
  it('reads the pragmas back from the real connection', async () => {
    const ctx = await openTempStore(driver);
    try {
      const diagnostics = await ctx.store.diagnostics();
      expect(diagnostics).toMatchObject({
        driver,
        journalMode: 'wal',
        synchronous: 2,
        foreignKeys: true,
        busyTimeoutMs: 5000,
      });
      expect(diagnostics.sqliteVersion).toMatch(/^3\.\d+\.\d+/);
      // The darwin-only pragmas read back as OFF where they are not applied.
      expect(diagnostics.fullfsync).toBe(process.platform === 'darwin');
    } finally {
      await ctx.dispose();
    }
  });

  it('applies synchronous=normal and a custom busy timeout', async () => {
    const ctx = await openTempStore(driver, { synchronous: 'normal', busyTimeoutMs: 321 });
    try {
      expect(await ctx.store.diagnostics()).toMatchObject({ synchronous: 1, busyTimeoutMs: 321 });
    } finally {
      await ctx.dispose();
    }
  });

  it('keeps the events across a close and a reopen, and keeps the ids going', async () => {
    const { dir, dispose } = await makeTempDir();
    const config = { path: join(dir, 'db', 'otheater.db'), driver } as const;
    try {
      const first = await SqliteStore.open(config, new FakeClock(10));
      await first.events.append(event(1));
      await first.transaction(async (tx) => {
        await tx.events.append(event(2));
      });
      await first.close();

      const second = await SqliteStore.open(config, new FakeClock(20));
      try {
        const stored = await second.events.readFrom(0, 10);
        expect(stored.map((e) => [e.id, e.payload, e.timestamp])).toEqual([
          [1, { n: 1 }, 10],
          [2, { n: 2 }, 10],
        ]);
        expect((await second.events.append(event(3))).id).toBe(3);
      } finally {
        await second.close();
      }
    } finally {
      await dispose();
    }
  });

  it('does not apply the migrations again on reopen', async () => {
    const { dbPath, store, dispose } = await openTempStore(driver);
    try {
      await store.close();
      const applied = async (): Promise<{ name: string; timestamp: string }[]> =>
        withRawDatabase(
          driver,
          dbPath,
          (db) =>
            db.prepare('SELECT name, timestamp FROM kysely_migration ORDER BY name').all([]) as {
              name: string;
              timestamp: string;
            }[],
        );
      const before = await applied();
      expect(before.map((row) => row.name)).toEqual(Object.keys(MIGRATIONS));

      const again = await SqliteStore.open({ path: dbPath, driver }, new FakeClock());
      await again.close();
      expect(await applied()).toEqual(before);
    } finally {
      await dispose();
    }
  });

  it('creates the events table and its indexes', async () => {
    const { dbPath, dispose, store } = await openTempStore(driver);
    try {
      await store.close();
      const names = await withRawDatabase(driver, dbPath, (db) =>
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'events' ORDER BY name")
            .all([]) as { name: string }[]
        ).map((row) => row.name),
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'events',
          'events_type_id',
          'events_scenario_id_id',
          'events_play_id_id',
          'events_attempt_id_id',
        ]),
      );
    } finally {
      await dispose();
    }
  });

  it('refuses to open a database whose migrations are newer than this code', async () => {
    const { dbPath, store, dispose } = await openTempStore(driver);
    try {
      await store.close();
      await withRawDatabase(
        driver,
        dbPath,
        (db) =>
          db
            .prepare('INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)')
            .run(['9999_from_the_future', new Date().toISOString()]),
        false,
      );
      const error = await rejectionOf(SqliteStore.open({ path: dbPath, driver }, new FakeClock()));
      expect(error).toBeInstanceOf(AdapterUnavailable);
    } finally {
      await dispose();
    }
  });

  it('rejects a bad config with InvalidInput and opens nothing', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const error = await rejectionOf(
        SqliteStore.open({ path: join(dir, 'x.db'), driver: 'sql.js' as never }, new FakeClock()),
      );
      expect(error).toBeInstanceOf(InvalidInput);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it('fails with AdapterUnavailable when the file cannot be opened', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      // A directory where the database file should be.
      const path = join(dir, 'taken');
      await mkdir(path);
      const error = await rejectionOf(SqliteStore.open({ path, driver }, new FakeClock()));
      expect(error).toBeInstanceOf(AdapterUnavailable);
    } finally {
      await dispose();
    }
  });

  it('fails with AdapterUnavailable when the file is not a database', async () => {
    const { dir, dispose } = await makeTempDir();
    try {
      const path = join(dir, 'garbage.db');
      await writeFile(path, 'this is not a SQLite database, just text '.repeat(100));
      const error = await rejectionOf(SqliteStore.open({ path, driver }, new FakeClock()));
      expect(error).toBeInstanceOf(AdapterUnavailable);
    } finally {
      await dispose();
    }
  });

  it('maps a lock held by another connection to Transient', async () => {
    const { dbPath, store, dispose } = await openTempStore(driver, { busyTimeoutMs: 50 });
    const other = await openRawDatabase(driver, dbPath, { readonly: false, busyTimeoutMs: 50 });
    try {
      other.exec('BEGIN IMMEDIATE');
      const error = await rejectionOf(store.events.append(event(1)));
      expect(error).toMatchObject({ code: 'TRANSIENT' });
      other.exec('ROLLBACK');
      // The store recovers once the lock is gone.
      expect((await store.events.append(event(2))).id).toBe(1);
    } finally {
      other.close();
      await dispose();
    }
  });

  it('does not let a failed transaction block the next one', async () => {
    const ctx = await openTempStore(driver);
    try {
      const boom = new Error('boom');
      await expect(
        ctx.store.transaction(async (tx) => {
          await tx.events.append(event(1));
          throw boom;
        }),
      ).rejects.toBe(boom);
      await ctx.store.transaction((tx) => tx.events.append(event(2)));
      expect((await ctx.store.events.readFrom(0, 10)).map((e) => e.payload)).toEqual([{ n: 2 }]);
    } finally {
      await ctx.dispose();
    }
  });

  it('close is idempotent, waits for the open transaction and then rejects everything', async () => {
    const ctx = await openTempStore(driver);
    try {
      const running = ctx.store.transaction(async (tx) => {
        await tx.events.append(event(1));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'finished';
      });
      const closing = ctx.store.close();
      expect(await running).toBe('finished');
      await closing;
      await ctx.store.close();
      for (const call of [
        () => ctx.store.transaction(() => Promise.resolve(1)),
        () => ctx.store.events.append(event(2)),
        () => ctx.store.events.readFrom(0, 1),
        () => ctx.store.events.lastId(),
        () => ctx.store.diagnostics(),
        () => ctx.store.backup(join(ctx.dir, 'late.db')),
      ]) {
        const error = await rejectionOf(call());
        expect(error).toBeInstanceOf(AdapterUnavailable);
        expect(isOTheaterError(error)).toBe(true);
      }
    } finally {
      await ctx.dispose();
    }
  });
});

async function withRawDatabase<T>(
  driver: SqliteDriverName,
  path: string,
  use: (db: RawDatabase) => T,
  readonly = true,
): Promise<T> {
  const db = await openRawDatabase(driver, path, { readonly, busyTimeoutMs: 1000 });
  try {
    return use(db);
  } finally {
    db.close();
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}
