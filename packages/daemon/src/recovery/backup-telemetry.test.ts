// SPDX-License-Identifier: MPL-2.0
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { compose } from '../compose.js';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, RecordingSituations } from '../test-helpers.js';
import { BackupService, createBackup } from './backup.js';
import { restoreBackup } from './restore.js';

const AT = Date.UTC(2026, 10, 21, 15, 30, 5);

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const writeCopy = async (dest: string) => {
  await writeFile(dest, 'db');
  return { path: dest, bytes: 2, method: 'online_api', durationMs: 1, restarts: 0 };
};

const base = {
  method: 'online_api',
  trigger: 'manual',
  version: '0.0.0',
  content: 'store_only',
  storeBackup: writeCopy,
} as const;

describe('createBackup: backup.telemetry (Phase 8, P1)', () => {
  it('exclude leaves the telemetry file out and never asks for the copy', async () => {
    const tmp = await makeTempDataDir();
    try {
      let asked = 0;
      const created = await createBackup({
        ...base,
        backupDir: join(tmp.dir, 'backups'),
        dataDir: tmp.dir,
        clock: new FakeClock(AT),
        telemetry: 'exclude',
        telemetryBackup: async (dest) => {
          asked += 1;
          await writeFile(dest, 'telemetry');
          return true;
        },
      });
      expect(asked).toBe(0);
      expect(created.telemetryCopied).toBe(false);
      expect((await readdir(created.dir)).sort()).toEqual(['manifest.json', 'store.sqlite']);
    } finally {
      await tmp.dispose();
    }
  });

  it('include copies it as telemetry.sqlite; a missing base copies nothing', async () => {
    const tmp = await makeTempDataDir();
    try {
      const copy = async (dest: string) => {
        await writeFile(dest, 'telemetry');
        return true;
      };
      const withFile = await createBackup({
        ...base,
        backupDir: join(tmp.dir, 'backups'),
        dataDir: tmp.dir,
        clock: new FakeClock(AT),
        telemetry: 'include',
        telemetryBackup: copy,
      });
      expect(withFile.telemetryCopied).toBe(true);
      expect(await readFile(join(withFile.dir, 'telemetry.sqlite'), 'utf8')).toBe('telemetry');
      const without = await createBackup({
        ...base,
        backupDir: join(tmp.dir, 'backups'),
        dataDir: tmp.dir,
        clock: new FakeClock(AT + 1000),
        telemetry: 'include',
        telemetryBackup: () => Promise.resolve(false),
      });
      expect(without.telemetryCopied).toBe(false);
      expect(await exists(join(without.dir, 'telemetry.sqlite'))).toBe(false);
    } finally {
      await tmp.dispose();
    }
  });

  it('a failed telemetry copy does not fail the backup: it is reported', async () => {
    const tmp = await makeTempDataDir();
    try {
      const created = await createBackup({
        ...base,
        backupDir: join(tmp.dir, 'backups'),
        dataDir: tmp.dir,
        clock: new FakeClock(AT),
        telemetry: 'include',
        telemetryBackup: async (dest) => {
          await writeFile(dest, 'half');
          throw new Error('disk full');
        },
      });
      expect(created.telemetryCopied).toBe(false);
      expect(created.telemetryError).toBeInstanceOf(Error);
      expect(await readdir(created.dir)).not.toContain('telemetry.sqlite');
    } finally {
      await tmp.dispose();
    }
  });
});

describe('BackupService: a failed telemetry copy', () => {
  it('records recovery.notice backup_telemetry_failed and the backup is ok', async () => {
    const tmp = await makeTempDataDir();
    try {
      const situations = new RecordingSituations();
      const service = new BackupService({
        dataDir: tmp.dir,
        settings: parseConfig('backup:\n  telemetry: include\n').backup,
        clock: new FakeClock(AT),
        logger: createSilentLogger(),
        version: '0.0.0',
        storeBackup: writeCopy,
        telemetryBackup: () => Promise.reject(new Error('no space')),
        situations,
      });
      const outcome = await service.run('manual');
      expect(outcome.ok).toBe(true);
      expect(situations.recorded).toHaveLength(1);
      expect(situations.recorded[0]).toMatchObject({
        type: 'recovery.notice',
        payload: { kind: 'backup_telemetry_failed' },
      });
    } finally {
      await tmp.dispose();
    }
  });
});

describe('BackupService with the real telemetry base', () => {
  async function runWith(mode: 'exclude' | 'include') {
    const tmp = await makeTempDataDir();
    const config = parseConfig(
      `adapters:\n  vault: encrypted-file\nvault:\n  scrypt: { N: 16384, r: 8, p: 1 }\nlog:\n  destination: file\nbackup:\n  telemetry: ${mode}\n`,
    );
    const composition = await compose(config, { dataDir: tmp.dir });
    const store = composition.rawStore as unknown as {
      backup: (dest: string, options: object) => Promise<never>;
    };
    try {
      composition.telemetry?.write({
        logs: [
          {
            scenarioId: null,
            playId: null,
            attemptId: null,
            sessionId: null,
            timeUnixNano: 1_700_000_000_000_000_456n,
            severity: 9,
            severityText: 'INFO',
            body: 'kept?',
            traceId: null,
            spanId: null,
            attributes: {},
            resource: {},
          },
        ],
      });
      const situations = new RecordingSituations();
      const service = new BackupService({
        dataDir: tmp.dir,
        settings: config.backup,
        clock: composition.clock,
        logger: createSilentLogger(),
        version: '0.0.0',
        storeBackup: (dest, options) => store.backup(dest, options),
        telemetryBackup: composition.telemetryBackup,
        situations,
      });
      const outcome = await service.run('manual');
      if (!outcome.ok) throw outcome.cause as Error;
      return { tmp, composition, folder: outcome.created.dir };
    } catch (error) {
      await composition.close();
      await tmp.dispose();
      throw error;
    }
  }

  it('backup.telemetry exclude (default): the file is not in the backup', async () => {
    const { tmp, composition, folder } = await runWith('exclude');
    try {
      expect(await exists(join(folder, 'telemetry.sqlite'))).toBe(false);
      expect(await exists(join(folder, 'store.sqlite'))).toBe(true);
    } finally {
      await composition.close();
      await tmp.dispose();
    }
  });

  it('backup.telemetry include: a consistent copy is in the backup and restore puts it back', async () => {
    const { tmp, composition, folder } = await runWith('include');
    try {
      expect(await exists(join(folder, 'telemetry.sqlite'))).toBe(true);
      await composition.telemetry?.close();
      const live = join(tmp.dir, 'telemetry.sqlite');
      await writeFile(live, 'later-state');
      const result = await restoreBackup({
        dataDir: tmp.dir,
        backupPath: folder,
        tools: {
          restoreFile: () =>
            Promise.resolve({ databasePath: 'x', previousDatabase: undefined, bytes: 0 }),
        },
        clock: new FakeClock(AT + 5000),
        telemetryFile: live,
      });
      expect(result.telemetryRestored).toBe(true);
      expect(result.previousTelemetry).toMatch(/telemetry\.sqlite\.before-restore-/);
      expect(await readFile(result.previousTelemetry ?? '', 'utf8')).toBe('later-state');
      expect((await readFile(live)).subarray(0, 15).toString()).toBe('SQLite format 3');
    } finally {
      await composition.close();
      await tmp.dispose();
    }
  });
});
