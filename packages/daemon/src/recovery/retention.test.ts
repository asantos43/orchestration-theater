// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_MANIFEST_FORMAT_VERSION, type BackupManifest } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { makeTempDataDir, RecordingSituations } from '../test-helpers.js';
import { backupFolderName } from './backup.js';
import {
  applyRetention,
  latestBackupAt,
  listBackups,
  listBeforeRestore,
  parseBeforeRestoreName,
  PARTIAL_GRACE_MS,
  policyFromSettings,
  selectExpired,
  type RetentionEntry,
} from './retention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

const entry = (name: string, ageDays: number, ok = true): RetentionEntry => ({
  name,
  createdAt: NOW - ageDays * DAY,
  ok,
});

describe('selectExpired, mode days (N51)', () => {
  const policy = { mode: 'days', keepDays: 2 } as const;

  it('expires what is older than keepDays and keeps the rest', () => {
    const entries = [entry('today', 0), entry('d1', 1), entry('d2', 2), entry('d3', 3)];
    // Exactly keepDays old is not "more than": it stays.
    expect(selectExpired(entries, policy, NOW).sort()).toEqual(['d3']);
  });

  it('always keeps the newest good copy, even a week old (machine was off)', () => {
    const entries = [entry('w1', 7), entry('w2', 8), entry('w3', 9)];
    expect(selectExpired(entries, policy, NOW).sort()).toEqual(['w2', 'w3']);
  });

  it('never treats a copy from the future (clock went back) as old', () => {
    const entries = [entry('future', -3), entry('old', 5)];
    expect(selectExpired(entries, policy, NOW)).toEqual(['old']);
  });

  it('does not depend on the order it is given and breaks ties by name', () => {
    const a = entry('a', 5);
    const b = entry('b', 5);
    expect(selectExpired([a, b], policy, NOW)).toEqual(selectExpired([b, a], policy, NOW));
    // Same age: the newest-by-name is the one protected.
    expect(selectExpired([a, b], policy, NOW)).toEqual(['a']);
  });

  it('protects the newest good copy, not a newer bad one', () => {
    const entries = [entry('bad-new', 4, false), entry('good-old', 6, true)];
    expect(selectExpired(entries, policy, NOW)).toEqual(['bad-new']);
  });

  it('can switch the protection off (for the .before-restore files)', () => {
    expect(selectExpired([entry('x', 9)], policy, NOW, { protectNewestGood: false })).toEqual([
      'x',
    ]);
  });

  it('has nothing to expire in an empty list', () => {
    expect(selectExpired([], policy, NOW)).toEqual([]);
  });
});

describe('selectExpired, mode copies', () => {
  it('keeps the N newest, whatever their age', () => {
    const entries = [entry('c0', 0), entry('c1', 10), entry('c2', 20), entry('c3', 30)];
    expect(selectExpired(entries, { mode: 'copies', copies: 2 }, NOW).sort()).toEqual(['c2', 'c3']);
    expect(selectExpired(entries, { mode: 'copies', copies: 9 }, NOW)).toEqual([]);
  });
});

describe('policyFromSettings', () => {
  it('reads the keys the retention mode uses', () => {
    expect(policyFromSettings({ retention: 'days', keep_days: 3, copies: 9 })).toEqual({
      mode: 'days',
      keepDays: 3,
    });
    expect(policyFromSettings({ retention: 'copies', keep_days: 3, copies: 9 })).toEqual({
      mode: 'copies',
      copies: 9,
    });
  });
});

describe('parseBeforeRestoreName', () => {
  it('reads the stamp the store adapter writes, with or without a companion suffix', () => {
    const at = Date.UTC(2026, 10, 16, 12, 0, 0, 123);
    const stamp = '2026-11-16T12-00-00-123Z';
    expect(parseBeforeRestoreName(`store.sqlite.before-restore-${stamp}`)).toEqual({
      base: 'store.sqlite',
      createdAt: at,
      name: `store.sqlite.before-restore-${stamp}`,
    });
    expect(parseBeforeRestoreName(`store.sqlite.before-restore-${stamp}-wal`)?.name).toBe(
      `store.sqlite.before-restore-${stamp}`,
    );
    expect(parseBeforeRestoreName(`scenarios.before-restore-${stamp}`)?.base).toBe('scenarios');
  });

  it('ignores anything else', () => {
    for (const name of ['store.sqlite', 'store.sqlite.before-restore-yesterday', 'notes.txt']) {
      expect(parseBeforeRestoreName(name)).toBeUndefined();
    }
  });
});

const manifest = (createdAt: number): BackupManifest => ({
  formatVersion: BACKUP_MANIFEST_FORMAT_VERSION,
  createdAt,
  trigger: 'schedule',
  method: 'online_api',
  content: 'store_only',
  integrity: 'ok',
  storeBytes: 1,
  otheaterVersion: '0.0.0',
});

async function makeBackup(backupDir: string, createdAt: number): Promise<string> {
  const name = backupFolderName(createdAt);
  await mkdir(join(backupDir, name), { recursive: true });
  await writeFile(join(backupDir, name, 'manifest.json'), JSON.stringify(manifest(createdAt)));
  await writeFile(join(backupDir, name, 'store.sqlite'), 'x');
  return name;
}

describe('on disk', () => {
  it('lists only folders with a valid manifest; a missing folder is empty', async () => {
    const tmp = await makeTempDataDir();
    try {
      const backupDir = join(tmp.dir, 'backups');
      expect(await listBackups(backupDir)).toEqual({ backups: [], partials: [] });
      const good = await makeBackup(backupDir, NOW);
      await mkdir(join(backupDir, 'my-own-folder'));
      await mkdir(join(backupDir, backupFolderName(NOW - DAY))); // right name, no manifest
      await writeFile(join(backupDir, backupFolderName(NOW - 2 * DAY)), 'a file, not a folder');
      await mkdir(join(backupDir, `${backupFolderName(NOW - 3 * DAY)}.partial`));
      const listing = await listBackups(backupDir);
      expect(listing.backups.map((b) => b.name)).toEqual([good]);
      expect(listing.partials).toHaveLength(1);
      expect(await latestBackupAt(backupDir)).toBe(NOW);
    } finally {
      await tmp.dispose();
    }
  });

  it('ignores a manifest that does not match the schema', async () => {
    const tmp = await makeTempDataDir();
    try {
      const dir = join(tmp.dir, backupFolderName(NOW));
      await mkdir(dir);
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ createdAt: NOW }));
      expect((await listBackups(tmp.dir)).backups).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });

  it('applies the rotation: expired copies, old partials and old before-restore files', async () => {
    const tmp = await makeTempDataDir();
    try {
      const backupDir = join(tmp.dir, 'backups');
      const fresh = await makeBackup(backupDir, NOW - 3_600_000);
      const old = await makeBackup(backupDir, NOW - 5 * DAY);
      const foreign = join(backupDir, 'not-ours');
      await mkdir(foreign);
      const noManifest = backupFolderName(NOW - 9 * DAY);
      await mkdir(join(backupDir, noManifest));

      const oldPartial = `${backupFolderName(NOW - 4 * DAY)}.partial`;
      const freshPartial = `${backupFolderName(NOW - 1000)}.partial`;
      await mkdir(join(backupDir, oldPartial));
      await mkdir(join(backupDir, freshPartial));
      // The grace period is measured on the folder's mtime, as the rotation sees it.
      const longAgo = new Date(NOW - PARTIAL_GRACE_MS - 60_000);
      await utimes(join(backupDir, oldPartial), longAgo, longAgo);
      const recent = new Date(NOW - 60_000);
      await utimes(join(backupDir, freshPartial), recent, recent);

      const oldStamp = '2026-11-10T12-00-00-000Z';
      const newStamp = '2026-11-16T11-00-00-000Z';
      for (const file of [
        `store.sqlite.before-restore-${oldStamp}`,
        `store.sqlite.before-restore-${oldStamp}-wal`,
        `store.sqlite.before-restore-${oldStamp}-shm`,
        `store.sqlite.before-restore-${newStamp}`,
      ]) {
        await writeFile(join(tmp.dir, file), 'x');
      }
      await mkdir(join(tmp.dir, `scenarios.before-restore-${oldStamp}`));
      await writeFile(join(tmp.dir, 'store.sqlite'), 'live');

      const removed = await applyRetention({
        backupDir,
        dataDir: tmp.dir,
        policy: { mode: 'days', keepDays: 2 },
        now: NOW,
      });

      expect(new Set(removed)).toEqual(
        new Set([
          old,
          oldPartial,
          `store.sqlite.before-restore-${oldStamp}`,
          `store.sqlite.before-restore-${oldStamp}-wal`,
          `store.sqlite.before-restore-${oldStamp}-shm`,
          `scenarios.before-restore-${oldStamp}`,
        ]),
      );
      expect((await readdir(backupDir)).sort()).toEqual(
        [fresh, freshPartial, 'not-ours', noManifest].sort(),
      );
      expect((await readdir(tmp.dir)).sort()).toEqual(
        ['backups', 'store.sqlite', `store.sqlite.before-restore-${newStamp}`].sort(),
      );
      expect((await listBeforeRestore(tmp.dir)).map((g) => g.name)).toEqual([
        `store.sqlite.before-restore-${newStamp}`,
      ]);
    } finally {
      await tmp.dispose();
    }
  });

  // A folder that cannot be written to makes the removal fail; root ignores the mode, so it skips.
  it.skipIf(process.getuid?.() === 0)(
    'recovery.notice retention_remove_failed: an item that could not be removed is an event, and a clean rotation is quiet (P24, N146)',
    async () => {
      const tmp = await makeTempDataDir();
      const backupDir = join(tmp.dir, 'backups');
      try {
        await makeBackup(backupDir, NOW - 1000);
        const old = await makeBackup(backupDir, NOW - 5 * DAY);
        const input = {
          backupDir,
          dataDir: tmp.dir,
          policy: { mode: 'days', keepDays: 2 },
        } as const;

        const quiet = new RecordingSituations();
        expect(await applyRetention({ ...input, now: NOW - 6 * DAY, situations: quiet })).toEqual(
          [],
        );
        expect(quiet.recorded).toEqual([]);

        await chmod(backupDir, 0o500);
        const situations = new RecordingSituations();
        const removed = await applyRetention({ ...input, now: NOW, situations });
        expect(removed).toEqual([]);
        expect(situations.of('recovery.notice')).toEqual([
          {
            kind: 'retention_remove_failed',
            subject: old,
            detail: expect.stringContaining('EACCES') as string,
          },
        ]);
      } finally {
        await chmod(backupDir, 0o700);
        await tmp.dispose();
      }
    },
  );

  it('keeps the only copy there is, however old', async () => {
    const tmp = await makeTempDataDir();
    try {
      const backupDir = join(tmp.dir, 'backups');
      const only = await makeBackup(backupDir, NOW - 30 * DAY);
      const removed = await applyRetention({
        backupDir,
        dataDir: tmp.dir,
        policy: { mode: 'days', keepDays: 2 },
        now: NOW,
      });
      expect(removed).toEqual([]);
      expect(await readdir(backupDir)).toEqual([only]);
    } finally {
      await tmp.dispose();
    }
  });
});
