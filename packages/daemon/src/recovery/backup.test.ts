// SPDX-License-Identifier: MPL-2.0
import { access, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Transient,
  type NewEvent,
  type StoreBackupOptions,
  type StoreBackupResult,
} from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { BackupManifestSchema } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, RecordingSituations } from '../test-helpers.js';
import { BackupService, backupFolderName, createBackup, type StoreBackupFn } from './backup.js';

const AT = Date.UTC(2026, 10, 16, 15, 30, 5);
const DAY = 86_400_000;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** A "store copy" that just writes bytes: these tests are about folders, not SQLite. */
const writeCopy: StoreBackupFn = async (dest, options) => {
  await writeFile(dest, 'database-bytes');
  const result: StoreBackupResult = {
    path: dest,
    bytes: 14,
    method: options.method ?? 'online_api',
    durationMs: 3,
    restarts: 0,
  };
  return result;
};

async function seedScenarios(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, 'scenarios', 'one', 'runs', 'r1'), { recursive: true });
  await writeFile(join(dataDir, 'scenarios', 'one', 'scenario.yaml'), 'name: one');
  await writeFile(join(dataDir, 'scenarios', 'one', 'runs', 'r1', 'out.txt'), 'big');
}

describe('backupFolderName', () => {
  it('is UTC, sortable, and takes a suffix on collision', () => {
    expect(backupFolderName(AT)).toBe('otheater-20261116-153005Z');
    expect(backupFolderName(AT, 2)).toBe('otheater-20261116-153005Z-2');
  });
});

describe('createBackup', () => {
  const base = { method: 'online_api', trigger: 'manual', version: '1.2.3' } as const;

  it('writes the store copy and a valid manifest into a folder with its final name', async () => {
    const tmp = await makeTempDataDir();
    try {
      const backupDir = join(tmp.dir, 'backups');
      const created = await createBackup({
        ...base,
        backupDir,
        dataDir: tmp.dir,
        content: 'store_only',
        clock: new FakeClock(AT),
        storeBackup: writeCopy,
      });
      expect(created.name).toBe('otheater-20261116-153005Z');
      expect(await readdir(backupDir)).toEqual([created.name]);
      expect((await readdir(created.dir)).sort()).toEqual(['manifest.json', 'store.sqlite']);
      const manifest = BackupManifestSchema.parse(
        JSON.parse(await readFile(join(created.dir, 'manifest.json'), 'utf8')),
      );
      expect(manifest).toMatchObject({
        createdAt: AT,
        trigger: 'manual',
        method: 'online_api',
        content: 'store_only',
        integrity: 'ok',
        storeBytes: 14,
        otheaterVersion: '1.2.3',
      });
      expect(created.result.path).toBe(join(created.dir, 'store.sqlite'));
    } finally {
      await tmp.dispose();
    }
  });

  it('copies scenarios by content: without_runs leaves runs/ out, all keeps it, store_only skips', async () => {
    const tmp = await makeTempDataDir();
    try {
      await seedScenarios(tmp.dir);
      const make = async (content: 'store_only' | 'without_runs' | 'all', at: number) =>
        createBackup({
          ...base,
          backupDir: join(tmp.dir, 'backups'),
          dataDir: tmp.dir,
          content,
          clock: new FakeClock(at),
          storeBackup: writeCopy,
        });
      const none = await make('store_only', AT);
      const trimmed = await make('without_runs', AT + 1000);
      const full = await make('all', AT + 2000);
      expect(await exists(join(none.dir, 'scenarios'))).toBe(false);
      expect(await exists(join(trimmed.dir, 'scenarios', 'one', 'scenario.yaml'))).toBe(true);
      expect(await exists(join(trimmed.dir, 'scenarios', 'one', 'runs'))).toBe(false);
      expect(await exists(join(full.dir, 'scenarios', 'one', 'runs', 'r1', 'out.txt'))).toBe(true);
    } finally {
      await tmp.dispose();
    }
  });

  it('adds a suffix when the folder of that second already exists', async () => {
    const tmp = await makeTempDataDir();
    try {
      const input = {
        ...base,
        backupDir: join(tmp.dir, 'backups'),
        dataDir: tmp.dir,
        content: 'store_only',
        clock: new FakeClock(AT),
        storeBackup: writeCopy,
      } as const;
      const first = await createBackup(input);
      const second = await createBackup(input);
      expect(second.name).toBe(`${first.name}-1`);
    } finally {
      await tmp.dispose();
    }
  });

  it('leaves nothing behind when the copy fails', async () => {
    const tmp = await makeTempDataDir();
    try {
      const backupDir = join(tmp.dir, 'backups');
      await expect(
        createBackup({
          ...base,
          backupDir,
          dataDir: tmp.dir,
          content: 'store_only',
          clock: new FakeClock(AT),
          storeBackup: () => Promise.reject(new Transient('disk full')),
        }),
      ).rejects.toThrow('disk full');
      expect(await readdir(backupDir)).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });
});

describe('BackupService', () => {
  function service(
    dataDir: string,
    clock: FakeClock,
    storeBackup: StoreBackupFn,
    events: NewEvent[],
    config = '',
  ): BackupService {
    return new BackupService({
      dataDir,
      settings: parseConfig(config).backup,
      clock,
      logger: createSilentLogger(),
      version: '0.0.0',
      storeBackup,
      recordEvent: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    });
  }

  it('copies, rotates after the copy, and records a daemon.backup event', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const events: NewEvent[] = [];
      const backups = service(tmp.dir, clock, writeCopy, events);
      const first = await backups.run('schedule');
      expect(first.ok).toBe(true);

      await clock.advance(5 * DAY);
      const second = await backups.run('manual');
      expect(second.ok && second.removed).toEqual([backupFolderName(AT)]);
      expect(await readdir(backups.backupDir)).toEqual([backupFolderName(AT + 5 * DAY)]);

      expect(events.map((event) => event.type)).toEqual(['daemon.backup', 'daemon.backup']);
      expect(events[1]?.payload).toMatchObject({ ok: true, trigger: 'manual', integrity: 'ok' });
      expect(await backups.latestBackupAt()).toBe(AT + 5 * DAY);
    } finally {
      await tmp.dispose();
    }
  });

  it('on failure keeps the old copies, records ok:false and reports the error', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const events: NewEvent[] = [];
      let fail = false;
      const backups = service(
        tmp.dir,
        clock,
        (dest, options) =>
          fail ? Promise.reject(new Transient('store busy')) : writeCopy(dest, options),
        events,
      );
      await backups.run('schedule');
      await clock.advance(10 * DAY);
      fail = true;
      const outcome = await backups.run('schedule');
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'TRANSIENT', message: 'store busy' },
      });
      // The rotation did not run: the old copy is still there although it is 10 days old.
      expect(await readdir(backups.backupDir)).toEqual([backupFolderName(AT)]);
      expect(events[1]?.payload).toMatchObject({
        ok: false,
        error: { code: 'TRANSIENT' },
        removed: [],
      });
    } finally {
      await tmp.dispose();
    }
  });

  it('hands backup.pages_per_step to the store copy: "all" sends none, a number is sent as is', async () => {
    const tmp = await makeTempDataDir();
    try {
      const seen: StoreBackupOptions[] = [];
      const spy: StoreBackupFn = (dest, options) => {
        seen.push(options);
        return writeCopy(dest, options);
      };
      const clock = new FakeClock(AT);
      await service(tmp.dir, clock, spy, []).run('manual');
      await clock.advance(1000);
      await service(tmp.dir, clock, spy, [], 'backup:\n  pages_per_step: all\n').run('manual');
      await clock.advance(1000);
      await service(tmp.dir, clock, spy, [], 'backup:\n  pages_per_step: 500\n').run('manual');
      expect(seen).toEqual([
        { method: 'online_api' },
        { method: 'online_api' },
        { method: 'online_api', pagesPerStep: 500 },
      ]);
    } finally {
      await tmp.dispose();
    }
  });

  it('runs one at a time, in order, even when started together', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const order: string[] = [];
      const slow: StoreBackupFn = async (dest, options) => {
        order.push('start');
        await new Promise((resolve) => setImmediate(resolve));
        order.push('end');
        return writeCopy(dest, options);
      };
      const backups = service(tmp.dir, clock, slow, []);
      const [a, b] = await Promise.all([backups.run('manual'), backups.run('manual')]);
      expect(order).toEqual(['start', 'end', 'start', 'end']);
      expect(a.ok && b.ok).toBe(true);
      expect(await readdir(backups.backupDir)).toHaveLength(2);
    } finally {
      await tmp.dispose();
    }
  });

  it('does not turn a failed event append into a failed backup', async () => {
    const tmp = await makeTempDataDir();
    try {
      const backups = new BackupService({
        dataDir: tmp.dir,
        settings: parseConfig('').backup,
        clock: new FakeClock(AT),
        logger: createSilentLogger(),
        version: '0.0.0',
        storeBackup: writeCopy,
        recordEvent: () => Promise.reject(new Error('log closed')),
      });
      expect((await backups.run('manual')).ok).toBe(true);
    } finally {
      await tmp.dispose();
    }
  });

  // The copy is done and the folder then cannot be read, so the rotation cannot list it. Root
  // ignores the mode, so it skips.
  it.skipIf(process.getuid?.() === 0)(
    'recovery.notice backup_rotation_failed: a rotation that fails is an event, and the copy is still ok (P24, N146)',
    async () => {
      const tmp = await makeTempDataDir();
      const dir = join(tmp.dir, 'backups');
      try {
        const events: NewEvent[] = [];
        const situations = new RecordingSituations();
        const backups = new BackupService({
          dataDir: tmp.dir,
          settings: parseConfig('').backup,
          clock: new FakeClock(AT),
          logger: createSilentLogger(),
          version: '0.0.0',
          storeBackup: async (dest, options) => {
            const result = await writeCopy(dest, options);
            await chmod(dir, 0o300);
            return result;
          },
          recordEvent: (event) => {
            events.push(event);
            return Promise.resolve();
          },
          situations,
        });
        const outcome = await backups.run('manual');
        expect(outcome.ok).toBe(true);
        expect(situations.of('recovery.notice')).toEqual([
          {
            kind: 'backup_rotation_failed',
            subject: backupFolderName(AT),
            detail: expect.stringContaining('EACCES') as string,
          },
        ]);
        expect(events.map((event) => event.type)).toEqual(['daemon.backup']);
      } finally {
        await chmod(dir, 0o700);
        await tmp.dispose();
      }
    },
  );

  it('a backup that rotates cleanly records no recovery.notice', async () => {
    const tmp = await makeTempDataDir();
    try {
      const situations = new RecordingSituations();
      const backups = new BackupService({
        dataDir: tmp.dir,
        settings: parseConfig('').backup,
        clock: new FakeClock(AT),
        logger: createSilentLogger(),
        version: '0.0.0',
        storeBackup: writeCopy,
        situations,
      });
      expect((await backups.run('manual')).ok).toBe(true);
      expect(situations.recorded).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });

  it('honours an absolute backup.dir', async () => {
    const tmp = await makeTempDataDir();
    const elsewhere = await makeTempDataDir();
    try {
      const backups = service(
        tmp.dir,
        new FakeClock(AT),
        writeCopy,
        [],
        `backup:\n  dir: ${JSON.stringify(elsewhere.dir)}\n`,
      );
      await backups.run('manual');
      expect(await readdir(elsewhere.dir)).toHaveLength(1);
      expect(await exists(join(tmp.dir, 'backups'))).toBe(false);
    } finally {
      await tmp.dispose();
      await elsewhere.dispose();
    }
  });
});
