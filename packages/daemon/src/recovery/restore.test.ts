// SPDX-License-Identifier: MPL-2.0
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

  describe('daemon-id (Phase 6, P3)', () => {
    const SAVED = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11';
    const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

    async function restore(dir: string, folder: string): ReturnType<typeof restoreBackup> {
      return restoreBackup({
        dataDir: dir,
        backupPath: folder,
        tools: fakeTools(dir),
        clock: new FakeClock(AT + 1000),
      });
    }

    it('goes into the backup and comes back with the restore, the live id kept aside', async () => {
      const tmp = await makeTempDataDir();
      try {
        await writeFile(join(tmp.dir, 'store.sqlite'), 'live');
        await writeFile(join(tmp.dir, 'daemon-id'), `${SAVED}\n`);
        const folder = await makeBackup(tmp.dir, 'store_only');
        expect(await readFile(join(folder, 'daemon-id'), 'utf8')).toBe(`${SAVED}\n`);

        // A fresh data folder (other machine): its own id is replaced by the one of the backup.
        await writeFile(join(tmp.dir, 'daemon-id'), `${OTHER}\n`);
        const result = await restore(tmp.dir, folder);
        expect(result.daemonIdRestored).toBe(true);
        expect(await readFile(join(tmp.dir, 'daemon-id'), 'utf8')).toBe(`${SAVED}\n`);
        expect(result.previousDaemonId).toMatch(
          /daemon-id\.before-restore-2026-11-16T15-30-06-000Z$/,
        );
        expect(await readFile(result.previousDaemonId ?? '', 'utf8')).toBe(`${OTHER}\n`);
      } finally {
        await tmp.dispose();
      }
    });

    it('restores the id into a data folder that has none', async () => {
      const tmp = await makeTempDataDir();
      try {
        await writeFile(join(tmp.dir, 'store.sqlite'), 'live');
        await writeFile(join(tmp.dir, 'daemon-id'), `${SAVED}\n`);
        const folder = await makeBackup(tmp.dir, 'store_only');
        await rm(join(tmp.dir, 'daemon-id'));
        const result = await restore(tmp.dir, folder);
        expect(result).toMatchObject({ daemonIdRestored: true, previousDaemonId: undefined });
        expect(await readFile(join(tmp.dir, 'daemon-id'), 'utf8')).toBe(`${SAVED}\n`);
      } finally {
        await tmp.dispose();
      }
    });

    it('touches nothing when the id is the same, or when the backup has none or a damaged one', async () => {
      const tmp = await makeTempDataDir();
      try {
        await writeFile(join(tmp.dir, 'store.sqlite'), 'live');
        await writeFile(join(tmp.dir, 'daemon-id'), `${SAVED}\n`);
        const folder = await makeBackup(tmp.dir, 'store_only');
        const same = await restore(tmp.dir, folder);
        expect(same).toMatchObject({ daemonIdRestored: false, previousDaemonId: undefined });

        await writeFile(join(tmp.dir, 'store.sqlite'), 'live');
        await writeFile(join(tmp.dir, 'daemon-id'), `${OTHER}\n`);
        await writeFile(join(folder, 'daemon-id'), 'garbage');
        const damaged = await restore(tmp.dir, folder);
        expect(damaged.daemonIdRestored).toBe(false);
        await rm(join(folder, 'daemon-id'));
        await writeFile(join(tmp.dir, 'store.sqlite'), 'live');
        const none = await restore(tmp.dir, folder);
        expect(none.daemonIdRestored).toBe(false);
        expect(await readFile(join(tmp.dir, 'daemon-id'), 'utf8')).toBe(`${OTHER}\n`);
      } finally {
        await tmp.dispose();
      }
    });
  });
});
