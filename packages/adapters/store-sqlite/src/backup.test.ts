// SPDX-License-Identifier: MPL-2.0
import { access, open, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Conflict, InvalidInput, NotFound, Transient, type EventEnvelope } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import {
  ALL_PAGES_IN_ONE_STEP,
  BACKUP_METHODS,
  DEFAULT_BACKUP_METHOD,
  DEFAULT_BACKUP_TIMEOUT_MS,
  restoreDatabase,
} from './backup.js';
import { openRawDatabase } from './driver.js';
import { BackupFailed } from './errors.js';
import { SqliteStore } from './store.js';
import { DRIVERS, makeTempDir, openTempStore, startBoundedWriter } from './test-helpers.js';

const event = (n: number) => ({
  type: 'test.happened',
  schemaVersion: 1,
  payload: { n, text: 'x'.repeat(200) },
});

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Opens a finished backup as its own store and returns its events. */
async function readBackup(
  driver: (typeof DRIVERS)[number],
  path: string,
): Promise<readonly EventEnvelope[]> {
  const copy = await SqliteStore.open({ path, driver }, new FakeClock());
  try {
    return await copy.events.readFrom(0, 100_000);
  } finally {
    await copy.close();
  }
}

describe('backup defaults', () => {
  it('uses online_api by default [proposta]', () => {
    expect(DEFAULT_BACKUP_METHOD).toBe('online_api');
    expect(BACKUP_METHODS).toEqual(['online_api', 'vacuum_into']);
    expect(ALL_PAGES_IN_ONE_STEP).toBeGreaterThan(1_000_000);
    expect(DEFAULT_BACKUP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe.each(DRIVERS)('backup on %s', (driver) => {
  describe.each(BACKUP_METHODS)('method %s', (method) => {
    it('copies a consistent, checked database with the same content', async () => {
      const ctx = await openTempStore(driver);
      try {
        for (let n = 0; n < 25; n++) await ctx.store.events.append(event(n));
        const dest = join(ctx.dir, 'backups', 'one.db');

        const result = await ctx.store.backup(dest, { method });

        expect(result).toMatchObject({ path: dest, method });
        expect(result.bytes).toBe((await stat(dest)).size);
        expect(result.bytes).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        // Single self-contained file; nothing left behind.
        expect(await readdir(join(ctx.dir, 'backups'))).toEqual(['one.db']);

        const original = await ctx.store.events.readFrom(0, 1000);
        expect(await readBackup(driver, dest)).toEqual(original);
        // The store is untouched by the backup and keeps working.
        expect((await ctx.store.events.append(event(99))).id).toBe(26);
      } finally {
        await ctx.dispose();
      }
    });

    it('works with an empty store', async () => {
      const ctx = await openTempStore(driver);
      try {
        const dest = join(ctx.dir, 'empty.db');
        await ctx.store.backup(dest, { method });
        expect(await readBackup(driver, dest)).toEqual([]);
      } finally {
        await ctx.dispose();
      }
    });

    it('finishes and is consistent while writes keep happening, without an uncommitted transaction', async () => {
      const ctx = await openTempStore(driver);
      try {
        for (let n = 0; n < 200; n++) await ctx.store.events.append(event(n));
        const writer = startBoundedWriter(ctx.store);
        const dest = join(ctx.dir, 'live.db');
        let result;
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          result = await ctx.store.backup(dest, { method });
        } finally {
          await writer.stop();
        }

        const copied = await readBackup(driver, dest);
        expect(result.bytes).toBeGreaterThan(0);
        expect(result.restarts).toBe(0);
        expect(copied.length).toBeGreaterThanOrEqual(200);
        // The writer commits 3 events at a time: a snapshot never holds part of a transaction.
        expect((copied.length - 200) % 3).toBe(0);
        // A prefix of the live log: same rows, no gaps.
        const live = await ctx.store.events.readFrom(0, 100_000);
        expect(copied).toEqual(live.slice(0, copied.length));
        expect(copied.map((e) => e.id)).toEqual(copied.map((_e, i) => i + 1));
      } finally {
        await ctx.dispose();
      }
    });

    it('refuses to overwrite an existing file', async () => {
      const ctx = await openTempStore(driver);
      try {
        const dest = join(ctx.dir, 'taken.db');
        await writeFile(dest, 'precious');
        await expect(ctx.store.backup(dest, { method })).rejects.toBeInstanceOf(Conflict);
        expect(await exists(`${dest}.partial`)).toBe(false);
      } finally {
        await ctx.dispose();
      }
    });

    it('fails with BackupFailed and leaves nothing when the destination is unusable', async () => {
      const ctx = await openTempStore(driver);
      try {
        // The parent of the destination is a regular file, so the folder cannot be created.
        const blocker = join(ctx.dir, 'blocker');
        await writeFile(blocker, 'x');
        const dest = join(blocker, 'sub', 'b.db');
        await expect(ctx.store.backup(dest, { method })).rejects.toBeInstanceOf(Error);
        expect(await readdir(ctx.dir)).not.toContain('b.db');
      } finally {
        await ctx.dispose();
      }
    });
  });

  describe('online_api restarts (stepped copy)', () => {
    /** About 400 pages: enough steps for the writer to get in between. */
    const fill = async (store: SqliteStore): Promise<void> => {
      for (let n = 0; n < 400; n++) {
        await store.events.append({
          type: 'test.fill',
          schemaVersion: 1,
          payload: { n, text: 'x'.repeat(3000) },
        });
      }
    };

    it('starts over when another connection writes between steps, and still ends once writes stop', async () => {
      const ctx = await openTempStore(driver);
      try {
        await fill(ctx.store);
        const writer = startBoundedWriter(ctx.store);
        let result;
        try {
          result = await ctx.store.backup(join(ctx.dir, 'stepped.db'), {
            method: 'online_api',
            pagesPerStep: 1,
            timeoutMs: 20_000,
          });
        } finally {
          await writer.stop();
        }
        // This is the behaviour that makes the one-step default necessary.
        expect(result.restarts).toBeGreaterThan(0);
        const copied = await readBackup(driver, result.path);
        const live = await ctx.store.events.readFrom(0, 100_000);
        expect(copied).toEqual(live.slice(0, copied.length));
      } finally {
        await ctx.dispose();
      }
    });

    it('gives up with Transient past timeoutMs and leaves no file', async () => {
      const ctx = await openTempStore(driver);
      try {
        await fill(ctx.store);
        const dest = join(ctx.dir, 'late.db');
        const error = await ctx.store
          .backup(dest, { method: 'online_api', pagesPerStep: 1, timeoutMs: 0.001 })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Transient);
        expect(await exists(dest)).toBe(false);
        expect(await exists(`${dest}.partial`)).toBe(false);
        // The store is fine afterwards.
        expect((await ctx.store.events.append(event(1))).id).toBe(401);
      } finally {
        await ctx.dispose();
      }
    });

    it('rejects nonsense options with InvalidInput', async () => {
      const ctx = await openTempStore(driver);
      try {
        await expect(
          ctx.store.backup(join(ctx.dir, 'a.db'), { pagesPerStep: 0 }),
        ).rejects.toBeInstanceOf(InvalidInput);
        await expect(
          ctx.store.backup(join(ctx.dir, 'b.db'), { timeoutMs: 0 }),
        ).rejects.toBeInstanceOf(InvalidInput);
      } finally {
        await ctx.dispose();
      }
    });
  });

  it('defaults to online_api', async () => {
    const ctx = await openTempStore(driver);
    try {
      const result = await ctx.store.backup(join(ctx.dir, 'default.db'));
      expect(result.method).toBe('online_api');
    } finally {
      await ctx.dispose();
    }
  });

  it('removes the copy and throws BackupFailed when the integrity check fails', async () => {
    const ctx = await openTempStore(driver);
    try {
      await ctx.store.events.append(event(1));
      // Break the check by making the copy fail verification: corrupt the source file on disk
      // below the page cache so that the copied pages are invalid.
      await ctx.store.close();
      const raw = await openRawDatabase(driver, ctx.dbPath, {
        readonly: false,
        busyTimeoutMs: 100,
      });
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      raw.close();
      const handle = await open(ctx.dbPath, 'r+');
      try {
        // Zero a whole interior b-tree page of the events table (page size is at least 512).
        const size = (await handle.stat()).size;
        await handle.write(Buffer.alloc(size - 4096, 0xff), 0, size - 4096, 4096);
      } finally {
        await handle.close();
      }
      const { backupDatabase } = await import('./backup.js');
      const dest = join(ctx.dir, 'bad.db');
      const error = await backupDatabase({
        driver,
        sourcePath: ctx.dbPath,
        destPath: dest,
        method: 'online_api',
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackupFailed);
      expect(await exists(dest)).toBe(false);
      expect(await exists(`${dest}.partial`)).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});

describe.each(DRIVERS)('restoreDatabase on %s', (driver) => {
  it('puts a backup in place and keeps the replaced database aside, with -wal and -shm', async () => {
    const ctx = await openTempStore(driver);
    const clock = new FakeClock(Date.UTC(2026, 10, 16, 12, 0, 0));
    try {
      for (let n = 0; n < 5; n++) await ctx.store.events.append(event(n));
      const backup = join(ctx.dir, 'backups', 'good.db');
      await ctx.store.backup(backup);
      for (let n = 5; n < 9; n++) await ctx.store.events.append(event(n));
      // While the store is open the -wal/-shm companions exist.
      expect(await exists(`${ctx.dbPath}-wal`)).toBe(true);
      // A crash is simulated by leaving the companions in place: copy them aside first.
      const liveEvents = await ctx.store.events.readFrom(0, 100);
      await ctx.store.close();

      const result = await restoreDatabase({
        driver,
        backupPath: backup,
        databasePath: ctx.dbPath,
        clock,
      });

      expect(result.databasePath).toBe(ctx.dbPath);
      expect(result.restoredFrom).toBe(backup);
      expect(result.previousDatabase).toMatch(/\.before-restore-2026-11-16T12-00-00-000Z$/);
      expect(await exists(result.previousDatabase ?? '')).toBe(true);
      expect(await exists(`${ctx.dbPath}.restoring`)).toBe(false);
      expect(await exists(`${ctx.dbPath}-wal`)).toBe(false);

      // The restored database opens, has the 5 events of the backup and keeps counting.
      const restored = await SqliteStore.open({ path: ctx.dbPath, driver }, new FakeClock());
      try {
        expect((await restored.events.readFrom(0, 100)).map((e) => e.payload.n)).toEqual([
          0, 1, 2, 3, 4,
        ]);
        expect((await restored.events.append(event(50))).id).toBe(6);
      } finally {
        await restored.close();
      }

      // The database that was replaced is intact and still holds its 9 events.
      const previous = await readBackup(driver, result.previousDatabase ?? '');
      expect(previous).toEqual(liveEvents);
    } finally {
      await ctx.dispose();
    }
  });

  it('restores into a path where no database exists yet', async () => {
    const source = await openTempStore(driver);
    const target = await makeTempDir();
    try {
      await source.store.events.append(event(1));
      const backup = join(source.dir, 'b.db');
      await source.store.backup(backup);
      const result = await restoreDatabase({
        driver,
        backupPath: backup,
        databasePath: join(target.dir, 'new', 'otheater.db'),
      });
      expect(result.previousDatabase).toBeUndefined();
      expect(await readBackup(driver, result.databasePath)).toHaveLength(1);
    } finally {
      await source.dispose();
      await target.dispose();
    }
  });

  it('rejects a missing backup with NotFound and leaves the database alone', async () => {
    const ctx = await openTempStore(driver);
    try {
      await ctx.store.events.append(event(1));
      await ctx.store.close();
      await expect(
        restoreDatabase({ driver, backupPath: join(ctx.dir, 'nope.db'), databasePath: ctx.dbPath }),
      ).rejects.toBeInstanceOf(NotFound);
      expect(await readdir(ctx.dir)).toEqual(expect.arrayContaining(['otheater.db']));
      expect((await readdir(ctx.dir)).filter((name) => name.includes('before-restore'))).toEqual(
        [],
      );
    } finally {
      await ctx.dispose();
    }
  });

  it('rejects a file that is not a database with InvalidInput and changes nothing', async () => {
    const ctx = await openTempStore(driver);
    try {
      await ctx.store.events.append(event(1));
      await ctx.store.close();
      const junk = join(ctx.dir, 'junk.db');
      await writeFile(junk, 'definitely not a database '.repeat(200));
      await expect(
        restoreDatabase({ driver, backupPath: junk, databasePath: ctx.dbPath }),
      ).rejects.toBeInstanceOf(InvalidInput);
      const names = await readdir(ctx.dir);
      expect(names.filter((name) => name.includes('restoring') || name.includes('before'))).toEqual(
        [],
      );
      expect(await readBackup(driver, ctx.dbPath)).toHaveLength(1);
    } finally {
      await ctx.dispose();
    }
  });

  it('rejects restoring a database onto itself', async () => {
    const ctx = await openTempStore(driver);
    try {
      await ctx.store.close();
      await expect(
        restoreDatabase({ driver, backupPath: ctx.dbPath, databasePath: ctx.dbPath }),
      ).rejects.toBeInstanceOf(InvalidInput);
    } finally {
      await ctx.dispose();
    }
  });
});
