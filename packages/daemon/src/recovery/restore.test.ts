// SPDX-License-Identifier: MPL-2.0
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput, NotFound, type StoreBackupResult } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { makeTempDataDir } from '../test-helpers.js';
import { createBackup } from './backup.js';
import { restoreBackup } from './restore.js';
import type { StoreFileTools } from '../compose.js';

const AT = Date.UTC(2026, 10, 16, 15, 30, 5);

/** What the store adapter does, without SQLite: put the file in place, keep the old aside. */
function fakeTools(dataDir: string): Pick<StoreFileTools, 'restoreFile'> {
  return {
    restoreFile: async (backupPath, clock) => {
      const databasePath = join(dataDir, 'store.sqlite');
      const previous = `${databasePath}.before-restore-${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}`;
      await rename(databasePath, previous);
      await writeFile(databasePath, await readFile(backupPath));
      return { databasePath, previousDatabase: previous, bytes: 1 };
    },
  };
}

async function makeBackup(
  dataDir: string,
  content: 'store_only' | 'without_runs' | 'all',
): Promise<string> {
  const result = await createBackup({
    backupDir: join(dataDir, 'backups'),
    dataDir,
    content,
    method: 'online_api',
    trigger: 'manual',
    version: '0.0.0',
    clock: new FakeClock(AT),
    storeBackup: async (dest): Promise<StoreBackupResult> => {
      await writeFile(dest, 'saved');
      return { path: dest, bytes: 5, method: 'online_api', durationMs: 1, restarts: 0 };
    },
  });
  return result.dir;
}

describe('restoreBackup', () => {
  it('replaces the database and scenarios, keeping the old ones aside', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'store.sqlite'), 'saved-state');
      await mkdir(join(tmp.dir, 'scenarios', 'one'), { recursive: true });
      await writeFile(join(tmp.dir, 'scenarios', 'one', 'a.yaml'), 'at backup time');
      const folder = await makeBackup(tmp.dir, 'without_runs');
      // The store file in the backup is the fake 'saved'. Later the live state moves on:
      await writeFile(join(tmp.dir, 'store.sqlite'), 'later-state');
      await writeFile(join(tmp.dir, 'scenarios', 'one', 'a.yaml'), 'changed later');

      const result = await restoreBackup({
        dataDir: tmp.dir,
        backupPath: folder,
        tools: fakeTools(tmp.dir),
        clock: new FakeClock(AT + 1000),
      });

      expect(await readFile(join(tmp.dir, 'store.sqlite'), 'utf8')).toBe('saved');
      expect(await readFile(join(tmp.dir, 'scenarios', 'one', 'a.yaml'), 'utf8')).toBe(
        'at backup time',
      );
      expect(result.previousDatabase).toMatch(
        /store\.sqlite\.before-restore-2026-11-16T15-30-06-000Z$/,
      );
      expect(result.previousScenarios).toMatch(
        /scenarios\.before-restore-2026-11-16T15-30-06-000Z$/,
      );
      expect(await readFile(join(result.previousScenarios ?? '', 'one', 'a.yaml'), 'utf8')).toBe(
        'changed later',
      );
    } finally {
      await tmp.dispose();
    }
  });

  it('leaves scenarios alone for a store_only backup', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'store.sqlite'), 'x');
      await mkdir(join(tmp.dir, 'scenarios'));
      await writeFile(join(tmp.dir, 'scenarios', 'keep.yaml'), 'mine');
      const folder = await makeBackup(tmp.dir, 'store_only');
      const result = await restoreBackup({
        dataDir: tmp.dir,
        backupPath: folder,
        tools: fakeTools(tmp.dir),
        clock: new FakeClock(AT),
      });
      expect(result.previousScenarios).toBeUndefined();
      expect(await readFile(join(tmp.dir, 'scenarios', 'keep.yaml'), 'utf8')).toBe('mine');
      expect((await readdir(tmp.dir)).filter((name) => name.startsWith('scenarios.'))).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses a folder that is missing, has no manifest, or has no store file, touching nothing', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'store.sqlite'), 'live');
      const input = { dataDir: tmp.dir, tools: fakeTools(tmp.dir), clock: new FakeClock(AT) };
      await expect(restoreBackup({ ...input, backupPath: join(tmp.dir, 'nope') })).rejects.toThrow(
        NotFound,
      );

      const stranger = join(tmp.dir, 'stranger');
      await mkdir(stranger);
      await writeFile(join(stranger, 'store.sqlite'), 'who knows');
      await expect(restoreBackup({ ...input, backupPath: stranger })).rejects.toThrow(InvalidInput);

      const folder = await makeBackup(tmp.dir, 'store_only');
      await rename(join(folder, 'store.sqlite'), join(folder, 'moved'));
      await expect(restoreBackup({ ...input, backupPath: folder })).rejects.toThrow(
        /no store\.sqlite/,
      );

      expect(await readFile(join(tmp.dir, 'store.sqlite'), 'utf8')).toBe('live');
    } finally {
      await tmp.dispose();
    }
  });
});
