// SPDX-License-Identifier: MPL-2.0
import { access, cp, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InvalidInput, NotFound, type Clock } from '@otheater/core';
import type { BackupManifest } from '@otheater/protocol';
import type { StoreFileTools } from '../compose.js';
import { dataPaths } from '../paths.js';
import { BACKUP_STORE_FILE } from './backup.js';
import { readManifest } from './retention.js';

export interface RestoreInput {
  readonly dataDir: string;
  /** A backup folder (the one with `manifest.json`), not its `store.sqlite`. */
  readonly backupPath: string;
  readonly tools: Pick<StoreFileTools, 'restoreFile'>;
  readonly clock: Pick<Clock, 'now'>;
}

export interface RestoreResult {
  readonly manifest: BackupManifest;
  readonly databasePath: string;
  /** Where the replaced database went; `undefined` when there was none. */
  readonly previousDatabase: string | undefined;
  /** Where the replaced `scenarios/` went; `undefined` when it was left alone or did not exist. */
  readonly previousScenarios: string | undefined;
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
  return {
    manifest,
    databasePath: restored.databasePath,
    previousDatabase: restored.previousDatabase,
    previousScenarios,
  };
}
