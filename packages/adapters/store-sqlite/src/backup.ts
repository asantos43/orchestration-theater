// SPDX-License-Identifier: MPL-2.0
import { access, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Conflict, InvalidInput, NotFound, Transient, type Clock } from '@otheater/core';
import type { SqliteDriverName } from './config.js';
import { integrityCheck, openRawDatabase, type RawDatabase } from './driver.js';
import { BackupFailed, toStoreError } from './errors.js';

/** The two ways to copy a live database (key `backup.method`, architecture 5.21). */
export const BACKUP_METHODS = ['online_api', 'vacuum_into'] as const;
export type BackupMethod = (typeof BACKUP_METHODS)[number];

/** Narrows a method name coming from config or a command line; unknown names are `InvalidInput`. */
export function parseBackupMethod(name: string): BackupMethod {
  const found = BACKUP_METHODS.find((method) => method === name);
  if (found === undefined) {
    throw new InvalidInput(
      `Unknown backup method "${name}"; expected one of: ${BACKUP_METHODS.join(', ')}`,
    );
  }
  return found;
}

/**
 * [proposta] `online_api` until step 7 measures both (architecture 5.21: "a escolher na Fase 1").
 * It copies page by page and lets other connections keep working between steps; `vacuum_into`
 * is one statement that blocks the event loop until it finishes, but also defragments the copy.
 */
export const DEFAULT_BACKUP_METHOD: BackupMethod = 'online_api';

/**
 * [proposta] Default `pagesPerStep` of `online_api`: every page in a single `sqlite3_backup_step`.
 *
 * Why: SQLite restarts a stepped copy from page 1 whenever another connection changes the source
 * between two steps (verified with both drivers, see `backup.test.ts`), so with a writer that
 * never stops a stepped copy never ends, and the destination grows without bound. A single step
 * reads one snapshot, cannot be restarted and always finishes. Cost: it holds the event loop for
 * the whole copy (time proportional to the database size), like `vacuum_into`. A smaller
 * `pagesPerStep` frees the event loop between steps, under the {@link DEFAULT_BACKUP_TIMEOUT_MS}
 * guard.
 */
export const ALL_PAGES_IN_ONE_STEP = 0x7fffffff;

/**
 * [proposta] Default `timeoutMs`: a stepped `online_api` copy (`pagesPerStep` smaller than the
 * database) that has not finished by then is abandoned with `Transient` and its partial file
 * removed. It is the guard against the restart livelock; a single-step copy never trips it.
 */
export const DEFAULT_BACKUP_TIMEOUT_MS = 60_000;

/** Default wait for a lock; matches the default of `SqliteStoreConfig.busyTimeoutMs`. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface BackupOptions {
  /**
   * One of {@link BACKUP_METHODS}; default {@link DEFAULT_BACKUP_METHOD}. Typed as a string
   * because it comes from configuration (`StoreMaintenance`); an unknown name rejects with
   * `InvalidInput`.
   */
  readonly method?: string;
  /**
   * `online_api` only: pages copied per step. Default {@link ALL_PAGES_IN_ONE_STEP} (always
   * finishes, blocks the event loop meanwhile). A smaller value lets the loop breathe but the copy
   * restarts when something writes in between; see {@link DEFAULT_BACKUP_TIMEOUT_MS}.
   */
  readonly pagesPerStep?: number;
  /**
   * `online_api` only: how long a stepped copy may keep running (restarts included) before it is
   * abandoned with `Transient`. Default {@link DEFAULT_BACKUP_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number;
}

export interface BackupResult {
  /** Absolute path of the finished backup. */
  readonly path: string;
  readonly bytes: number;
  readonly method: BackupMethod;
  readonly durationMs: number;
  /** Times the online copy started over because the source changed (always 0 for `vacuum_into`). */
  readonly restarts: number;
}

export interface BackupDatabaseOptions extends BackupOptions {
  readonly driver: SqliteDriverName;
  readonly sourcePath: string;
  /** Where the backup goes. Must not exist yet; its folder is created when missing. */
  readonly destPath: string;
  readonly busyTimeoutMs?: number;
}

const COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes a database file and its `-wal`/`-shm`/`-journal` companions, if any. */
async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all(
    ['', ...COMPANION_SUFFIXES].map((suffix) => rm(`${path}${suffix}`, { force: true })),
  );
}

/**
 * Copies the database at `sourcePath` to `destPath` while it is in use, then checks the copy.
 *
 * [proposta] Design:
 * - the copy reads through its own read-only connection, so it sees only committed data (one
 *   snapshot) and never queues behind or blocks the store's transactions;
 * - the copy is written to `<dest>.partial`, switched to `journal_mode=DELETE` (a single
 *   self-contained file, no `-wal`), checked with `PRAGMA integrity_check` and only then renamed to
 *   `destPath`: a failed backup never leaves anything at `destPath`;
 * - it refuses to overwrite an existing file (`Conflict`); rotation of old copies is the caller's.
 *
 * Rejects with `Transient` when a stepped online copy keeps restarting past `timeoutMs`, and with
 * `BackupFailed` when the copy cannot be made or does not pass the integrity check.
 */
export async function backupDatabase(options: BackupDatabaseOptions): Promise<BackupResult> {
  const method = parseBackupMethod(options.method ?? DEFAULT_BACKUP_METHOD);
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const dest = resolve(options.destPath);
  const partial = `${dest}.partial`;
  const pagesPerStep = options.pagesPerStep ?? ALL_PAGES_IN_ONE_STEP;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BACKUP_TIMEOUT_MS;
  if (!Number.isInteger(pagesPerStep) || pagesPerStep < 1) {
    throw new InvalidInput(`pagesPerStep must be an integer >= 1, got ${String(pagesPerStep)}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidInput(`timeoutMs must be > 0, got ${String(timeoutMs)}`);
  }
  const started = performance.now();
  let restarts = 0;

  if (await exists(dest)) throw new Conflict(`The backup destination already exists: ${dest}`);
  await mkdir(dirname(dest), { recursive: true });
  await removeDatabaseFiles(partial);

  try {
    const source = await openRawDatabase(options.driver, options.sourcePath, {
      readonly: true,
      busyTimeoutMs,
    });
    try {
      if (method === 'online_api') {
        let remaining = Infinity;
        await source.backupTo(partial, {
          pagesPerStep,
          onProgress: ({ remainingPages }) => {
            // More pages left than after the previous step: SQLite started over.
            if (remainingPages > remaining) restarts++;
            remaining = remainingPages;
            if (performance.now() - started > timeoutMs) {
              throw new Transient(
                `Online backup did not finish in ${String(timeoutMs)} ms: the database kept ` +
                  `changing under it (${String(restarts)} restarts); try a larger pagesPerStep ` +
                  'or the vacuum_into method',
              );
            }
          },
        });
      } else {
        // `VACUUM INTO` takes the target as an expression, so it can be bound (no quoting).
        source.prepare('VACUUM INTO ?').run([partial]);
      }
    } finally {
      source.close();
    }
    await verifyCopy(options.driver, partial, busyTimeoutMs);
    await rename(partial, dest);
    const { size } = await stat(dest);
    return { path: dest, bytes: size, method, durationMs: performance.now() - started, restarts };
  } catch (error) {
    await removeDatabaseFiles(partial);
    if (error instanceof BackupFailed || error instanceof Transient) throw error;
    throw new BackupFailed(`Backup (${method}) failed: ${describe(error)}`, {
      cause: toStoreError(error),
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens the finished copy, makes it a single file and runs `PRAGMA integrity_check`. */
async function verifyCopy(
  driver: SqliteDriverName,
  path: string,
  busyTimeoutMs: number,
): Promise<void> {
  const db = await openRawDatabase(driver, path, { readonly: false, busyTimeoutMs });
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    const problems = integrityCheck(db);
    if (problems.length !== 1 || problems[0] !== 'ok') {
      throw new BackupFailed(
        `The backup copy failed PRAGMA integrity_check: ${problems.slice(0, 5).join('; ')}`,
      );
    }
  } finally {
    db.close();
  }
}

export interface RestoreDatabaseOptions {
  readonly driver: SqliteDriverName;
  /** A backup made by {@link backupDatabase}. */
  readonly backupPath: string;
  /** The database file to replace. */
  readonly databasePath: string;
  /** Stamps the name of the file the current database is moved to. Default: system time. */
  readonly clock?: Pick<Clock, 'now'>;
  readonly busyTimeoutMs?: number;
}

export interface RestoreResult {
  /** Absolute path of the restored database. */
  readonly databasePath: string;
  readonly restoredFrom: string;
  /** Where the replaced database went (its `-wal`/`-shm`, if any, sit beside it); none if it did not exist. */
  readonly previousDatabase: string | undefined;
  readonly bytes: number;
}

/**
 * Low-level restore, **only with the store closed** (the daemon's instance lock guarantees that;
 * this function cannot tell if another process has the file open). [proposta] Steps:
 * 1. copy the backup next to the database and run `PRAGMA integrity_check` on the copy
 *    (`InvalidInput` if it fails, `NotFound` if the backup is missing);
 * 2. move the current database, with its `-wal` and `-shm`, to `<db>.before-restore-<time>`;
 * 3. rename the verified copy into place.
 * Nothing is deleted. The `ot restore` command is step 5; this is the part that touches files.
 */
export async function restoreDatabase(options: RestoreDatabaseOptions): Promise<RestoreResult> {
  const backup = resolve(options.backupPath);
  const target = resolve(options.databasePath);
  const staging = `${target}.restoring`;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const now = options.clock?.now() ?? Date.now();

  if (backup === target) throw new InvalidInput('The backup and the database are the same file');
  if (!(await exists(backup))) throw new NotFound(`Backup not found: ${backup}`);

  await mkdir(dirname(target), { recursive: true });
  await removeDatabaseFiles(staging);
  try {
    await copyFile(backup, staging);
    await verifyBackupFile(options.driver, staging, busyTimeoutMs);
    // A copy checked read-only may have made a -shm/-wal if the backup was in WAL mode.
    await Promise.all(
      COMPANION_SUFFIXES.map((suffix) => rm(`${staging}${suffix}`, { force: true })),
    );
  } catch (error) {
    await removeDatabaseFiles(staging);
    throw error;
  }

  let previousDatabase: string | undefined;
  const suffixes = ['', '-wal', '-shm'] as const;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const aside = `${target}.before-restore-${stamp}`;
  for (const suffix of suffixes) {
    if (await exists(`${target}${suffix}`)) {
      await rename(`${target}${suffix}`, `${aside}${suffix}`);
      previousDatabase = aside;
    }
  }
  await rename(staging, target);
  const { size } = await stat(target);
  return { databasePath: target, restoredFrom: backup, previousDatabase, bytes: size };
}

async function verifyBackupFile(
  driver: SqliteDriverName,
  path: string,
  busyTimeoutMs: number,
): Promise<void> {
  let db: RawDatabase | undefined;
  try {
    db = await openRawDatabase(driver, path, { readonly: true, busyTimeoutMs });
    const problems = integrityCheck(db);
    if (problems.length !== 1 || problems[0] !== 'ok') {
      throw new InvalidInput(
        `The backup failed PRAGMA integrity_check: ${problems.slice(0, 5).join('; ')}`,
      );
    }
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    // Not a database at all, or unreadable: the file is not a valid backup.
    throw new InvalidInput(`The file is not a valid SQLite backup: ${describe(error)}`, {
      cause: toStoreError(error),
    });
  } finally {
    db?.close();
  }
}
