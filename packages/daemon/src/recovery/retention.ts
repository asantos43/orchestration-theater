// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BackupManifestSchema, type BackupManifest } from '@otheater/protocol';
import type { BackupSettings } from '../config.js';
import type { Logger } from '../logger.js';
import { situationSubject, situationText, type SituationSink } from '../situations.js';

const DAY_MS = 86_400_000;

/** Folder name of a finished copy: `otheater-YYYYMMDD-HHMMSSZ`, with `-N` when two share a second. */
export const BACKUP_NAME_PATTERN = /^otheater-\d{8}-\d{6}Z(?:-\d+)?$/;
const PARTIAL_SUFFIX = '.partial';

/**
 * [proposta] A `.partial` folder younger than this may belong to a backup running right now (in
 * another process: `ot backup` while the daemon is up), so the rotation leaves it alone.
 */
export const PARTIAL_GRACE_MS = 3_600_000;

/** What the rotation needs to know about one copy. */
export interface RetentionEntry {
  readonly name: string;
  /** Epoch milliseconds the copy was made; the age counts from here (N51, rule a). */
  readonly createdAt: number;
  /** The copy passed its integrity check. */
  readonly ok: boolean;
}

/** The rotation chosen by `backup.retention` (decision N51). */
export type RetentionPolicy =
  | { readonly mode: 'days'; readonly keepDays: number }
  | { readonly mode: 'copies'; readonly copies: number };

export function policyFromSettings(
  settings: Pick<BackupSettings, 'retention' | 'keep_days' | 'copies'>,
): RetentionPolicy {
  return settings.retention === 'days'
    ? { mode: 'days', keepDays: settings.keep_days }
    : { mode: 'copies', copies: settings.copies };
}

function newestFirst(a: RetentionEntry, b: RetentionEntry): number {
  return b.createdAt - a.createdAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}

export interface SelectExpiredOptions {
  /**
   * Never expire the newest copy that is `ok`, however old (N51, rule b): a machine switched off
   * for a week must not come back with no backup. Default `true`; the `.before-restore` files are
   * not backups and turn it off.
   */
  readonly protectNewestGood?: boolean;
}

/**
 * Names of the entries the rotation may delete. Pure (decision N51):
 * - `days`: entries made more than `keepDays` days before `now`;
 * - `copies`: everything but the `copies` newest;
 * - ties on `createdAt` are broken by name, so the result never depends on listing order;
 * - an entry from the future (the clock went back) is never old;
 * - the newest good copy is always kept (see {@link SelectExpiredOptions}).
 * The caller runs this only after a new good copy exists (rule c).
 */
export function selectExpired(
  entries: readonly RetentionEntry[],
  policy: RetentionPolicy,
  now: number,
  options: SelectExpiredOptions = {},
): string[] {
  const sorted = [...entries].sort(newestFirst);
  const protectedName =
    options.protectNewestGood === false ? undefined : sorted.find((entry) => entry.ok)?.name;
  const expired =
    policy.mode === 'days'
      ? sorted.filter((entry) => now - entry.createdAt > policy.keepDays * DAY_MS)
      : sorted.slice(policy.copies);
  return expired.filter((entry) => entry.name !== protectedName).map((entry) => entry.name);
}

export interface ListedBackup {
  readonly name: string;
  readonly dir: string;
  readonly manifest: BackupManifest;
}

export interface Listing {
  /** Folders with a valid `manifest.json`: the only ones this code treats as its own. */
  readonly backups: readonly ListedBackup[];
  /** `*.partial` folders: a backup that did not finish. */
  readonly partials: readonly { name: string; dir: string; mtimeMs: number }[];
}

/** Reads and validates a `manifest.json`; `undefined` when missing or invalid. */
export async function readManifest(dir: string): Promise<BackupManifest | undefined> {
  try {
    const parsed = BackupManifestSchema.safeParse(
      JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lists `backupDir`. A folder without a valid manifest (or with another name) is not ours and
 * never shows up here, so nothing downstream can delete it. A missing `backupDir` is empty.
 */
export async function listBackups(backupDir: string): Promise<Listing> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(backupDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { backups: [], partials: [] };
    throw error;
  }
  const backups: ListedBackup[] = [];
  const partials: { name: string; dir: string; mtimeMs: number }[] = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dir = join(backupDir, entry.name);
    if (BACKUP_NAME_PATTERN.test(entry.name)) {
      const manifest = await readManifest(dir);
      if (manifest !== undefined) backups.push({ name: entry.name, dir, manifest });
    } else if (
      entry.name.endsWith(PARTIAL_SUFFIX) &&
      BACKUP_NAME_PATTERN.test(entry.name.slice(0, -PARTIAL_SUFFIX.length))
    ) {
      partials.push({ name: entry.name, dir, mtimeMs: (await stat(dir)).mtimeMs });
    }
  }
  return { backups, partials };
}

/** `createdAt` of the newest good copy, or `undefined` when there is none. */
export async function latestBackupAt(backupDir: string): Promise<number | undefined> {
  const { backups } = await listBackups(backupDir);
  return backups.reduce<number | undefined>(
    (latest, { manifest }) =>
      latest === undefined || manifest.createdAt > latest ? manifest.createdAt : latest,
    undefined,
  );
}

const BEFORE_RESTORE =
  /^(.+)\.before-restore-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(-wal|-shm)?$/;

/** A `<name>.before-restore-<stamp>` left by `ot restore`, with its `-wal`/`-shm` companions. */
export interface BeforeRestoreGroup {
  /** `store.sqlite.before-restore-2026-11-16T12-00-00-000Z` (no companion suffix). */
  readonly name: string;
  readonly createdAt: number;
  /** Every file or folder of the group, as names inside the data directory. */
  readonly members: readonly string[];
}

export function parseBeforeRestoreName(
  fileName: string,
): { base: string; createdAt: number; name: string } | undefined {
  const match = BEFORE_RESTORE.exec(fileName);
  if (match === null) return undefined;
  const [, base, date, hour, minute, second, millis, companion] = match;
  const createdAt = Date.parse(
    `${date ?? ''}T${hour ?? ''}:${minute ?? ''}:${second ?? ''}.${millis ?? ''}Z`,
  );
  if (Number.isNaN(createdAt) || base === undefined) return undefined;
  const name = companion === undefined ? fileName : fileName.slice(0, -companion.length);
  return { base, createdAt, name };
}

/** The `.before-restore` files of the data directory, grouped. */
export async function listBeforeRestore(dataDir: string): Promise<BeforeRestoreGroup[]> {
  const groups = new Map<string, { createdAt: number; members: string[] }>();
  for (const fileName of await readdir(dataDir)) {
    const parsed = parseBeforeRestoreName(fileName);
    if (parsed === undefined) continue;
    const group = groups.get(parsed.name) ?? { createdAt: parsed.createdAt, members: [] };
    group.members.push(fileName);
    groups.set(parsed.name, group);
  }
  return [...groups].map(([name, group]) => ({ name, ...group }));
}

export interface ApplyRetentionInput {
  readonly backupDir: string;
  readonly dataDir: string;
  readonly policy: RetentionPolicy;
  readonly now: number;
  readonly logger?: Logger | undefined;
  /** Where an item that could not be removed is also written (`recovery.notice`, P24). */
  readonly situations?: SituationSink | undefined;
}

/**
 * The rotation on disk, to be called only after a new good copy exists. Removes, in this order:
 * expired copies (N51), `.partial` leftovers older than {@link PARTIAL_GRACE_MS} and expired
 * `.before-restore-*` files. Returns the names it removed. A failure to remove one item is logged
 * and does not stop the others.
 */
export async function applyRetention(input: ApplyRetentionInput): Promise<string[]> {
  const removed: string[] = [];
  const remove = async (path: string, name: string): Promise<void> => {
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      input.logger?.warn({ err: error, path }, 'retention could not remove an old item');
      input.situations?.record('recovery.notice', {
        kind: 'retention_remove_failed',
        subject: situationSubject(name),
        detail: situationText(error),
      });
    }
  };

  const { backups, partials } = await listBackups(input.backupDir);
  const expired = new Set(
    selectExpired(
      backups.map(({ name, manifest }) => ({ name, createdAt: manifest.createdAt, ok: true })),
      input.policy,
      input.now,
    ),
  );
  for (const backup of backups) if (expired.has(backup.name)) await remove(backup.dir, backup.name);

  for (const partial of partials) {
    if (input.now - partial.mtimeMs > PARTIAL_GRACE_MS) await remove(partial.dir, partial.name);
  }

  const groups = await listBeforeRestore(input.dataDir);
  const old = new Set(
    selectExpired(
      groups.map(({ name, createdAt }) => ({ name, createdAt, ok: true })),
      input.policy,
      input.now,
      { protectNewestGood: false },
    ),
  );
  for (const group of groups) {
    if (!old.has(group.name)) continue;
    for (const member of group.members) await remove(join(input.dataDir, member), member);
  }
  return removed;
}
