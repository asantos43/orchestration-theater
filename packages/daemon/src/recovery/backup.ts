// SPDX-License-Identifier: MPL-2.0
import { access, cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  isOTheaterError,
  type Clock,
  type NewEvent,
  type StoreBackupOptions,
  type StoreBackupResult,
} from '@otheater/core';
import {
  BACKUP_MANIFEST_FORMAT_VERSION,
  DAEMON_ID_FILE,
  BackupManifestSchema,
  buildDaemonEvent,
  type BackupContent,
  type BackupManifest,
  type BackupTrigger,
} from '@otheater/protocol';
import type { BackupSettings } from '../config.js';
import type { Logger } from '../logger.js';
import { situationSubject, situationText, type SituationSink } from '../situations.js';
import { dataPaths } from '../paths.js';
import { applyRetention, latestBackupAt, policyFromSettings } from './retention.js';

/** Name of the database copy inside a backup folder. */
export const BACKUP_STORE_FILE = 'store.sqlite';

/** Makes the copy of the store; `StoreMaintenance.backup` of an open store, or the file tool of the adapter. */
export type StoreBackupFn = (
  dest: string,
  options: StoreBackupOptions,
) => Promise<StoreBackupResult>;

/** `20261116-153000` for 2026-11-16T15:30:00Z. */
function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
}

/** `otheater-YYYYMMDD-HHMMSSZ` (UTC), with `-N` appended when `attempt` > 0. */
export function backupFolderName(createdAt: number, attempt = 0): string {
  return `otheater-${utcStamp(createdAt)}Z${attempt > 0 ? `-${String(attempt)}` : ''}`;
}

export interface CreateBackupInput {
  readonly backupDir: string;
  readonly dataDir: string;
  readonly content: BackupContent;
  readonly method: string;
  /** Pages per step of an `online_api` copy; omitted means one step for everything. */
  readonly pagesPerStep?: number | undefined;
  readonly trigger: BackupTrigger;
  readonly clock: Pick<Clock, 'now'>;
  readonly version: string;
  readonly storeBackup: StoreBackupFn;
}

export interface CreatedBackup {
  readonly name: string;
  readonly dir: string;
  readonly manifest: BackupManifest;
  readonly result: StoreBackupResult;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * One copy: `<backupDir>/otheater-<stamp>Z/` with `store.sqlite` (already checked by the store's
 * own `integrity_check`), `manifest.json`, the `daemon-id` file when the data folder has one
 * (N168), and, by `content`, the `scenarios/` folder (architecture 5.21). Everything is written in `<name>.partial/` and renamed to its final name last, so a
 * folder with the final name is always complete; on any failure the partial folder is removed.
 */
export async function createBackup(input: CreateBackupInput): Promise<CreatedBackup> {
  const createdAt = input.clock.now();
  await mkdir(input.backupDir, { recursive: true, mode: 0o700 });
  let attempt = 0;
  let name = backupFolderName(createdAt);
  while (
    (await exists(join(input.backupDir, name))) ||
    (await exists(join(input.backupDir, `${name}.partial`)))
  ) {
    attempt += 1;
    name = backupFolderName(createdAt, attempt);
    // Bounded: a hundred copies in one second means something is wrong, not a collision.
    if (attempt > 100) throw new Error(`Could not find a free backup folder name for ${name}`);
  }
  const dir = join(input.backupDir, name);
  const partial = `${dir}.partial`;
  await mkdir(partial, { mode: 0o700 });
  try {
    const result = await input.storeBackup(join(partial, BACKUP_STORE_FILE), {
      method: input.method,
      ...(input.pagesPerStep === undefined ? {} : { pagesPerStep: input.pagesPerStep }),
    });
    if (input.content !== 'store_only') {
      await copyScenarios(
        dataPaths(input.dataDir).scenarios,
        join(partial, 'scenarios'),
        input.content,
      );
    }
    // The id of the daemon (N168) travels with every backup, so a restore keeps the identity.
    const daemonIdFile = dataPaths(input.dataDir).daemonId;
    if (await exists(daemonIdFile)) await cp(daemonIdFile, join(partial, DAEMON_ID_FILE));
    const manifest = BackupManifestSchema.parse({
      formatVersion: BACKUP_MANIFEST_FORMAT_VERSION,
      createdAt,
      trigger: input.trigger,
      method: result.method,
      content: input.content,
      integrity: 'ok',
      storeBytes: (await stat(join(partial, BACKUP_STORE_FILE))).size,
      otheaterVersion: input.version,
    } satisfies BackupManifest);
    await writeFile(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(partial, dir);
    return { name, dir, manifest, result: { ...result, path: join(dir, BACKUP_STORE_FILE) } };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Copies `<data>/scenarios` when it exists. `without_runs` leaves out every `runs/` folder (what
 * a run produced is big and can be redone); `all` copies everything. No scenarios folder, nothing
 * to copy: there are no scenarios yet.
 */
async function copyScenarios(
  source: string,
  target: string,
  content: Exclude<BackupContent, 'store_only'>,
): Promise<void> {
  if (!(await exists(source))) return;
  await cp(source, target, {
    recursive: true,
    filter: async (path) =>
      content === 'all' || basename(path) !== 'runs' || !(await stat(path)).isDirectory(),
  });
}

export type BackupOutcome =
  | {
      readonly ok: true;
      readonly created: CreatedBackup;
      /** Old copies the rotation removed after this one. */
      readonly removed: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
      readonly cause: unknown;
    };

export interface BackupServiceOptions {
  readonly dataDir: string;
  readonly settings: BackupSettings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly version: string;
  readonly storeBackup: StoreBackupFn;
  /** Where the `daemon.backup` event goes; none when this process does not own the store (`ot backup` beside a running daemon). */
  readonly recordEvent?: ((event: NewEvent) => Promise<unknown>) | undefined;
  /**
   * Where a rotation that failed and an old copy that could not be removed are also written, as
   * `recovery.notice` (P24, N146). Like `recordEvent`, none when this process does not own the store.
   */
  readonly situations?: SituationSink | undefined;
}

/**
 * Backup of the store, rotation and event, one at a time (architecture 5.21, decision N51).
 * Order inside `run`: copy, then (only if it succeeded) the rotation, then the `daemon.backup`
 * event, good or failed. A failed copy leaves the old ones alone.
 */
export class BackupService {
  readonly #options: BackupServiceOptions;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: BackupServiceOptions) {
    this.#options = options;
  }

  get backupDir(): string {
    const { dir } = this.#options.settings;
    return resolve(this.#options.dataDir, dir);
  }

  /** `createdAt` of the newest good copy (what the scheduler compares with the due moment). */
  latestBackupAt(): Promise<number | undefined> {
    return latestBackupAt(this.backupDir);
  }

  /** Runs after any backup already in progress. Never rejects for a failed copy: see the outcome. */
  run(trigger: BackupTrigger): Promise<BackupOutcome> {
    const next = this.#tail.then(() => this.#run(trigger));
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #run(trigger: BackupTrigger): Promise<BackupOutcome> {
    const { settings, clock, logger } = this.#options;
    let created: CreatedBackup;
    try {
      created = await createBackup({
        backupDir: this.backupDir,
        dataDir: this.#options.dataDir,
        content: settings.content,
        method: settings.method,
        pagesPerStep: settings.pages_per_step === 'all' ? undefined : settings.pages_per_step,
        trigger,
        clock,
        version: this.#options.version,
        storeBackup: this.#options.storeBackup,
      });
    } catch (error) {
      const failure = {
        code: isOTheaterError(error) ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      };
      logger.warn({ err: error, trigger }, 'backup failed; older copies kept');
      await this.#record(
        buildDaemonEvent('daemon.backup', { ok: false, trigger, error: failure, removed: [] }),
      );
      return { ok: false, error: failure, cause: error };
    }

    let removed: string[] = [];
    try {
      removed = await applyRetention({
        backupDir: this.backupDir,
        dataDir: this.#options.dataDir,
        policy: policyFromSettings(settings),
        now: clock.now(),
        logger,
        situations: this.#options.situations,
      });
    } catch (error) {
      // The new copy is good; a rotation problem must not turn it into a failure.
      logger.warn({ err: error }, 'backup rotation failed; the new copy is kept');
      this.#options.situations?.record('recovery.notice', {
        kind: 'backup_rotation_failed',
        subject: situationSubject(created.name),
        detail: situationText(error),
      });
    }
    logger.info(
      { trigger, path: created.dir, bytes: created.result.bytes, removed },
      'backup finished',
    );
    await this.#record(
      buildDaemonEvent('daemon.backup', {
        ok: true,
        trigger,
        path: created.dir,
        method: created.result.method,
        durationMs: created.result.durationMs,
        bytes: created.result.bytes,
        restarts: created.result.restarts,
        integrity: 'ok',
        removed,
      }),
    );
    return { ok: true, created, removed };
  }

  async #record(event: NewEvent): Promise<void> {
    const { recordEvent, logger } = this.#options;
    if (recordEvent === undefined) return;
    try {
      await recordEvent(event);
    } catch (error) {
      logger.error({ err: error }, 'could not record the daemon.backup event');
    }
  }
}
