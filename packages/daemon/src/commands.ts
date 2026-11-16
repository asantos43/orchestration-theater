// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, hasErrorCode, hasStoreMaintenance } from '@otheater/core';
import type { TFunction } from 'i18next';
import { compose, composeClock, composeStoreFileTools, type ComposeOverrides } from './compose.js';
import { loadConfig } from './config.js';
import { InstanceLock } from './instance-lock.js';
import { createSilentLogger } from './logger.js';
import { dataPaths, ensureDataDir } from './paths.js';
import { BackupService, type BackupOutcome } from './recovery/backup.js';
import { restoreBackup } from './recovery/restore.js';
import { packageVersion } from './version.js';

/** What a command needs from its caller: where to write and how to speak. No `process` here. */
export interface CommandContext {
  readonly dataDir: string;
  readonly t: TFunction;
  /** Normal output (stdout). */
  readonly out: (line: string) => void;
  /** Problems (stderr). */
  readonly err: (line: string) => void;
  readonly overrides?: ComposeOverrides | undefined;
  readonly version?: string | undefined;
}

/** Exit codes of `ot` (architecture 5.22): 0 good, 1 the command failed, 2 it was used wrongly. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/**
 * `ot backup`. [proposta] Two paths, decided by the instance lock:
 * - no daemon: this process takes the lock, opens the store, copies, rotates and records the
 *   `daemon.backup` event, as the daemon would;
 * - daemon running (`Conflict`): the store is the daemon's, so the copy goes through the database
 *   file (online, safe beside a writer) and no event is recorded; the rotation still runs.
 */
export async function runBackupCommand(context: CommandContext): Promise<number> {
  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  const version = context.version ?? packageVersion();

  let lock: InstanceLock | undefined;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (!hasErrorCode(error, 'CONFLICT')) throw error;
  }

  let outcome: BackupOutcome;
  if (lock !== undefined) {
    const composition = await compose(config, {
      dataDir: paths.dataDir,
      ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
    });
    try {
      const { store } = composition;
      if (!hasStoreMaintenance(store)) {
        throw new AdapterUnavailable('This store cannot make backups');
      }
      const service = new BackupService({
        dataDir: paths.dataDir,
        settings: config.backup,
        clock: composition.clock,
        logger: composition.logger,
        version,
        storeBackup: (dest, options) => store.backup(dest, options),
        recordEvent: (event) => store.events.append(event),
      });
      outcome = await service.run('manual');
    } finally {
      await composition.close().catch(() => undefined);
      await lock.release();
    }
  } else {
    context.out(context.t('backup.daemonRunning'));
    const tools = composeStoreFileTools(config, paths.dataDir);
    const service = new BackupService({
      dataDir: paths.dataDir,
      settings: config.backup,
      clock: composeClock(context.overrides),
      logger: createSilentLogger(),
      version,
      storeBackup: (dest, options) => tools.backupFile(dest, options),
    });
    outcome = await service.run('manual');
  }

  if (!outcome.ok) {
    context.err(context.t('errors.prefix', { message: outcome.error.message }));
    return EXIT_FAILED;
  }
  context.out(
    context.t('backup.done', {
      path: outcome.created.dir,
      bytes: outcome.created.result.bytes,
      method: outcome.created.result.method,
    }),
  );
  if (outcome.removed.length > 0) {
    context.out(context.t('backup.removed', { names: outcome.removed.join(', ') }));
  }
  return EXIT_OK;
}

/**
 * `ot restore <backup folder>`. Refuses while a daemon holds the data directory; otherwise holds
 * the lock itself while the files are swapped, so a daemon cannot start halfway through.
 */
export async function runRestoreCommand(
  context: CommandContext,
  backupPath: string,
): Promise<number> {
  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);

  let lock: InstanceLock;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (hasErrorCode(error, 'CONFLICT')) {
      context.err(context.t('restore.daemonRunning'));
      return EXIT_FAILED;
    }
    throw error;
  }
  try {
    const result = await restoreBackup({
      dataDir: paths.dataDir,
      backupPath,
      tools: composeStoreFileTools(config, paths.dataDir),
      clock: composeClock(context.overrides),
    });
    context.out(context.t('restore.done', { path: result.databasePath }));
    if (result.previousDatabase !== undefined) {
      context.out(context.t('restore.keptDatabase', { path: result.previousDatabase }));
    }
    if (result.previousScenarios !== undefined) {
      context.out(context.t('restore.keptScenarios', { path: result.previousScenarios }));
    }
    return EXIT_OK;
  } finally {
    await lock.release();
  }
}
