// SPDX-License-Identifier: MPL-2.0
import { access, cp, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { InvalidInput, NotFound, type Clock } from '@otheater/core';
import { DAEMON_ID_FILE, DaemonIdSchema, type BackupManifest } from '@otheater/protocol';
import type { StoreFileTools } from '../compose.js';
import { dataPaths } from '../paths.js';
import { BACKUP_STORE_FILE, BACKUP_TELEMETRY_FILE } from './backup.js';
import { readManifest } from './retention.js';

export interface RestoreInput {
  readonly dataDir: string;
  /** A backup folder (the one with `manifest.json`), not its `store.sqlite`. */
  readonly backupPath: string;
  readonly tools: Pick<StoreFileTools, 'restoreFile'>;
  readonly clock: Pick<Clock, 'now'>;
  /**
   * Where the telemetry base lives (`telemetry.file` resolved). When the backup carries a
   * `telemetry.sqlite` (`backup.telemetry: include`) it replaces this file; without it the
   * telemetry file is left alone, as the backup says nothing about it.
   */
  readonly telemetryFile?: string | undefined;
}

export interface RestoreResult {
  readonly manifest: BackupManifest;
  readonly databasePath: string;
  /** Where the replaced database went; `undefined` when there was none. */
  readonly previousDatabase: string | undefined;
  /** Where the replaced `scenarios/` went; `undefined` when it was left alone or did not exist. */
  readonly previousScenarios: string | undefined;
  /**
   * True when the backup carried a `daemon-id` and it is now the id of this data folder (N168: the
   * restored daemon is the same daemon). False when the backup has none (older ones) or it already
   * was this folder's id: the id is left alone.
   */
  readonly daemonIdRestored: boolean;
  /** Where the replaced `daemon-id` went; `undefined` when there was none or it was the same id. */
  readonly previousDaemonId: string | undefined;
  /** True when the telemetry file of the backup replaced the live one. */
  readonly telemetryRestored: boolean;
  /** Where the replaced telemetry file went; `undefined` when there was none. */
  readonly previousTelemetry: string | undefined;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Puts a backup back (architecture 5.21). The caller holds the instance lock, so no daemon has the
 * store open. Order: check the manifest and the store file (nothing is touched if they are bad),
 * replace the database (the adapter verifies the copy with `integrity_check` and keeps the old one
 * as `<db>.before-restore-<stamp>`), then replace `scenarios/` when the backup carries it, keeping
 * the old one as `scenarios.before-restore-<stamp>`. A `store_only` backup leaves `scenarios/`
 * alone. Nothing is deleted: the rotation removes the `.before-restore-*` files later (N51).
 */
export async function restoreBackup(input: RestoreInput): Promise<RestoreResult> {
  const folder = resolve(input.backupPath);
  if (!(await exists(folder))) throw new NotFound(`Backup folder not found: ${folder}`);
  const manifest = await readManifest(folder);
  if (manifest === undefined) {
    throw new InvalidInput(`Not a backup of this program (no valid manifest.json): ${folder}`);
  }
  const storeFile = join(folder, BACKUP_STORE_FILE);
  if (!(await exists(storeFile))) {
    throw new InvalidInput(`The backup has no ${BACKUP_STORE_FILE}: ${folder}`);
  }

  const restored = await input.tools.restoreFile(storeFile, input.clock);

  let previousScenarios: string | undefined;
  if (manifest.content !== 'store_only') {
    const live = dataPaths(input.dataDir).scenarios;
    if (await exists(live)) {
      previousScenarios = `${live}.before-restore-${new Date(input.clock.now()).toISOString().replace(/[:.]/g, '-')}`;
      await rename(live, previousScenarios);
    }
    const saved = join(folder, 'scenarios');
    if (await exists(saved)) await cp(saved, live, { recursive: true });
  }
  const daemonId = await restoreDaemonId(folder, input);
  const telemetry = await restoreTelemetry(folder, input);
  return {
    ...telemetry,
    manifest,
    databasePath: restored.databasePath,
    previousDatabase: restored.previousDatabase,
    previousScenarios,
    ...daemonId,
  };
}

/**
 * Puts the telemetry file of the backup in place (only a backup made with `backup.telemetry:
 * include` has one). The live file, with its `-wal` and `-shm`, is kept as
 * `<file>.before-restore-<stamp>`; a telemetry file is a mirror, but nothing is deleted here.
 */
async function restoreTelemetry(
  folder: string,
  input: RestoreInput,
): Promise<Pick<RestoreResult, 'telemetryRestored' | 'previousTelemetry'>> {
  const none = { telemetryRestored: false, previousTelemetry: undefined };
  const saved = join(folder, BACKUP_TELEMETRY_FILE);
  if (input.telemetryFile === undefined || !(await exists(saved))) return none;
  const live = input.telemetryFile;
  let previousTelemetry: string | undefined;
  if (await exists(live)) {
    previousTelemetry = `${live}.before-restore-${new Date(input.clock.now()).toISOString().replace(/[:.]/g, '-')}`;
    await rename(live, previousTelemetry);
    for (const suffix of ['-wal', '-shm']) {
      if (await exists(`${live}${suffix}`))
        await rename(`${live}${suffix}`, `${previousTelemetry}${suffix}`);
    }
  }
  await mkdir(dirname(live), { recursive: true });
  await cp(saved, live);
  return { telemetryRestored: true, previousTelemetry };
}

/**
 * Puts the `daemon-id` of the backup in the data folder (N168), so the events and the scenarios
 * the backup holds still belong to the daemon they were made by. A backup with no (or a damaged)
 * `daemon-id` leaves the folder's id alone; a different id that was there is kept as
 * `daemon-id.before-restore-<stamp>`, like the database.
 */
async function restoreDaemonId(
  folder: string,
  input: RestoreInput,
): Promise<Pick<RestoreResult, 'daemonIdRestored' | 'previousDaemonId'>> {
  const none = { daemonIdRestored: false, previousDaemonId: undefined };
  const saved = join(folder, DAEMON_ID_FILE);
  if (!(await exists(saved))) return none;
  const savedId = DaemonIdSchema.safeParse((await readFile(saved, 'utf8')).trim());
  if (!savedId.success) return none;
  const live = dataPaths(input.dataDir).daemonId;
  let previousDaemonId: string | undefined;
  if (await exists(live)) {
    const liveId = DaemonIdSchema.safeParse((await readFile(live, 'utf8')).trim());
    if (liveId.success && liveId.data === savedId.data) return none;
    previousDaemonId = `${live}.before-restore-${new Date(input.clock.now()).toISOString().replace(/[:.]/g, '-')}`;
    await rename(live, previousDaemonId);
  }
  await cp(saved, live);
  return { daemonIdRestored: true, previousDaemonId };
}
