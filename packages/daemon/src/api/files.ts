// SPDX-License-Identifier: MPL-2.0
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ApiDiscoverySchema,
  DaemonIdSchema,
  type ApiDiscovery,
  type DaemonId,
} from '@otheater/protocol';
import type { ApiTokenMode } from '../config.js';
import type { Logger } from '../logger.js';
import { situationSubject, situationText, type SituationSink } from '../situations.js';

/**
 * The three small files of the daemon API in the data folder (P3 of docs/17; decisions N165, N166
 * and N168): `daemon-id`, `api-token` and `api.json`. All are written atomically (a temporary
 * file with the mode, then a rename) so a reader never sees half of one. The mode `0600` does not
 * apply on Windows, where the data folder is private to the user by its place (and `O_NOFOLLOW` does
 * not exist there: the Windows behaviour is the one these files always had).
 */

const FILE_MODE = 0o600;

/** A token as the daemon makes it: 32 random bytes in base64url (43 characters). [proposta] */
export function generateApiToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A token the daemon accepts to reuse from `api-token`: base64url text, at least 32 characters. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,}$/;

/**
 * Writes `text` to `path` atomically, with mode 0600. The temporary file has a name nobody can guess
 * (random, next to the target), is created with `O_EXCL` (a file or a link that is already there is an
 * error, never written through) and `O_NOFOLLOW`, and gets its mode on the open descriptor, so there is
 * no moment where it is readable by others or where a link planted in the data folder redirects the write.
 * The rename then replaces `path` itself, even when `path` is a link (the link is replaced, not followed).
 */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`;
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    ((constants.O_NOFOLLOW as number | undefined) ?? 0);
  const handle = await open(temporary, flags, FILE_MODE);
  try {
    try {
      // `open` is subject to the umask, which only removes bits; the descriptor says the exact mode.
      await handle.chmod(FILE_MODE);
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** What follows `<file>` in the name of a temporary of {@link writePrivateFile}: `.<pid>.<16 hex>.tmp`. */
const TEMPORARY_TAIL = /^\.(\d+)\.[0-9a-f]{16}\.tmp$/;

export interface SweepTemporariesOptions {
  /** Whether a pid is a live process. Default {@link isProcessAlive}; tests replace it. */
  readonly alive?: ((pid: number) => boolean) | undefined;
  /**
   * Whether a temporary that carries this process's own pid is an orphan too. Right at start-up it is:
   * nothing of this process has written the file yet, so the name is a left-over of an earlier process
   * that had the same pid (a daemon that runs as pid 1 in a container always has it). Default `false`.
   */
  readonly includeOwnPid?: boolean | undefined;
  /** Told about a temporary that could not be removed, or a folder that could not be read; never throws. */
  readonly onError?: ((error: unknown, name: string) => void) | undefined;
}

/**
 * Removes the orphan temporaries of `path` (Phase 11, N306): the `<name>.<pid>.<16 hex>.tmp` that
 * {@link writePrivateFile} leaves when its process dies between the write and the rename, whose pid is no
 * longer alive. Only that exact shape of name, for that exact file, is ever touched: nothing else in the
 * folder, and no temporary of another file. A pid that was reused by a live process keeps its file (the
 * safe side). It never throws. Returns the names it removed.
 */
export async function sweepOrphanTemporaries(
  path: string,
  options: SweepTemporariesOptions = {},
): Promise<string[]> {
  const alive = options.alive ?? isProcessAlive;
  const folder = dirname(path);
  const prefix = basename(path);
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.onError?.(error, prefix);
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = TEMPORARY_TAIL.exec(name.slice(prefix.length));
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (pid === process.pid ? options.includeOwnPid !== true : alive(pid)) continue;
    try {
      await rm(join(folder, name), { force: true });
      removed.push(name);
    } catch (error) {
      options.onError?.(error, name);
    }
  }
  return removed;
}

export interface SweepApiTemporariesOptions {
  readonly logger?: Logger | undefined;
  readonly situations?: SituationSink | undefined;
  readonly alive?: ((pid: number) => boolean) | undefined;
}

/**
 * The start-up cleaning of the three files of this module (`daemon-id`, `api-token`, `api.json`): the
 * temporaries a killed daemon left are removed before the files are written again. A removal that fails
 * is a warning in the log and a `daemon.notice` (`temporary_cleanup_failed`), and the start goes on.
 */
export async function sweepApiTemporaries(
  paths: readonly string[],
  options: SweepApiTemporariesOptions = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const path of paths) {
    const names = await sweepOrphanTemporaries(path, {
      alive: options.alive,
      includeOwnPid: true,
      onError: (error, name) => {
        options.logger?.warn(
          { err: situationText(error, 200), file: name },
          'an orphan temporary file could not be removed',
        );
        options.situations?.record('daemon.notice', {
          kind: 'temporary_cleanup_failed',
          subject: situationSubject(name),
          detail: situationText(error),
        });
      },
    });
    removed.push(...names);
  }
  if (removed.length > 0) {
    options.logger?.info(
      { files: removed },
      'orphan temporary files of a killed daemon were removed',
    );
  }
  return removed;
}

/**
 * Whether `path` is a regular file (not a link) that only its owner can read or write. Where POSIX
 * modes do not exist (Windows) a regular file is enough.
 */
async function isPrivateRegularFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) return false;
  if (process.platform === 'win32') return true;
  const uid = process.getuid?.();
  return (info.mode & 0o077) === 0 && (uid === undefined || info.uid === uid);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The id of the daemon: the UUID in `daemon-id`, made on the first start and kept after. A file
 * that holds anything else is replaced (and the daemon says so in the log): the id must always be
 * a UUID, and a damaged file is no reason to stop the start-up.
 */
export async function loadOrCreateDaemonId(path: string, logger?: Logger): Promise<DaemonId> {
  const text = await readText(path);
  if (text !== undefined) {
    const parsed = DaemonIdSchema.safeParse(text.trim());
    if (parsed.success) return parsed.data;
    logger?.warn('daemon-id does not hold a UUID; a new id was made');
  }
  const id = randomUUID();
  await writePrivateFile(path, `${id}\n`);
  return id;
}

/** Reads `daemon-id`; `undefined` when the file is missing or does not hold a UUID. */
export async function readDaemonId(path: string): Promise<DaemonId | undefined> {
  const parsed = DaemonIdSchema.safeParse((await readText(path))?.trim());
  return parsed.success ? parsed.data : undefined;
}

/**
 * The token of this start. `persistent` reuses the one in `api-token` when it is well formed;
 * otherwise (and always with `per_start`) a new one is made and written.
 */
export async function loadOrCreateApiToken(
  path: string,
  mode: ApiTokenMode,
  logger?: Logger,
): Promise<string> {
  if (mode === 'persistent') {
    // A token that someone else could have read (a mode looser than 0600, another owner) or that
    // sits behind a link is not reused: it is as good as published, so a new one replaces it.
    if (await isPrivateRegularFile(path)) {
      const existing = (await readText(path))?.trim();
      if (existing !== undefined && TOKEN_FORMAT.test(existing)) return existing;
    } else if ((await lstat(path).catch(() => undefined)) !== undefined) {
      logger?.warn('api-token is not a private regular file; a new token was made');
    }
  }
  const token = generateApiToken();
  await writePrivateFile(path, `${token}\n`);
  return token;
}

/** Reads `api-token`; `undefined` when the file is missing or empty. */
export async function readApiToken(path: string): Promise<string | undefined> {
  const text = (await readText(path))?.trim();
  return text === undefined || text === '' ? undefined : text;
}

/**
 * Compares a token a client sent with the one the daemon holds, in constant time whatever the
 * sizes: both go through SHA-256 first, so the two buffers of `timingSafeEqual` always have the
 * same length and the length of the token never shows.
 */
export function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Publishes `api.json` (never the token). */
export async function publishDiscovery(path: string, info: ApiDiscovery): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(ApiDiscoverySchema.parse(info))}\n`);
}

/** Removes `api.json`. Idempotent. */
export async function removeDiscovery(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** True when a process with this pid exists (a process of another user counts as alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a read of `api.json` found. */
export type DiscoveryReading =
  | { readonly kind: 'none' }
  /** A file that is not a valid `api.json`. */
  | { readonly kind: 'invalid' }
  /** A valid file whose pid is gone: the daemon that wrote it died without removing it. */
  | { readonly kind: 'stale'; readonly info: ApiDiscovery }
  | { readonly kind: 'live'; readonly info: ApiDiscovery };

/** Reads `api.json` and tells a live file from a stale one by the pid it names. */
export async function readDiscovery(
  path: string,
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<DiscoveryReading> {
  const text = await readText(path);
  if (text === undefined) return { kind: 'none' };
  let info: ApiDiscovery;
  try {
    info = ApiDiscoverySchema.parse(JSON.parse(text));
  } catch {
    return { kind: 'invalid' };
  }
  return alive(info.pid) ? { kind: 'live', info } : { kind: 'stale', info };
}
