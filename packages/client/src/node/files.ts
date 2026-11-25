// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_DISCOVERY_FILE, API_TOKEN_FILE, ApiDiscoverySchema } from '@otheater/protocol';
import {
  DAEMON_LIST_VERSION,
  DaemonListFileSchema,
  type DaemonConnection,
  type DaemonListStore,
  type LocalDaemon,
  type LocalDaemonSource,
} from '../directory.js';
import { DaemonDirectoryError } from '../errors.js';
import { isPidAlive } from './pid.js';
import { sweepTemporaries, temporaryPathOf, type SweepTemporariesOptions } from './temporaries.js';

export { isPidAlive };

/**
 * The only module of the client that touches files (plan docs/17 P9): the list of daemons, with
 * its atomic write at mode 0600, and the discovery of the local daemon from the data folder. The
 * dependency rule (`.dependency-cruiser.js`) keeps Node modules out of everything else.
 */

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT';
}

/** Codes of a rename that Windows refuses while another handle has the target open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function isTransientRename(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code);
}

export interface FileDaemonListStoreOptions {
  /**
   * How many times a rename over the list is tried when Windows refuses it because another
   * handle (another process, an antivirus) has the file open. Default 5, with a delay that
   * doubles from 10 ms. 1 means no retry.
   */
  readonly renameAttempts?: number | undefined;
}

/** Default of `FileDaemonListStoreOptions.renameAttempts`. */
export const DEFAULT_RENAME_ATTEMPTS = 5;

/** The shape of the temporary of {@link writePrivateFileAtomic}: `<file>.<pid>.<8 hex>.tmp`. */
export const ATOMIC_TEMPORARY_SHAPE = { hexLength: 8 } as const;

export interface WritePrivateFileOptions {
  /** See {@link FileDaemonListStoreOptions.renameAttempts}. Default {@link DEFAULT_RENAME_ATTEMPTS}. */
  readonly renameAttempts?: number | undefined;
  /**
   * The cleaning of the orphan temporaries of this file that runs after the write (N306): the policy,
   * the clock, the check of a pid and the handler of a failure. Default: the policy in force and the
   * sink of `onTemporarySweepFailure`.
   */
  readonly sweep?: Omit<SweepTemporariesOptions, 'hexLength' | 'hidden'> | undefined;
}

/**
 * Writes `text` to `path` so a reader never sees half a file, at mode 0600: a temporary file in the
 * same folder, renamed over the target (retried while Windows refuses it, see `renameAttempts`).
 * The folder is made with mode 0700 where POSIX modes exist. Used for `client.json`, for the
 * layout file of the `local` mode and for the registry of plugins of the daemon.
 *
 * The temporary is `<file>.<pid>.<8 hex>.tmp`. A process killed between the write and the rename
 * leaves it, so after a successful write the orphans of this file are removed (N306; see
 * `sweepTemporaries` for what an orphan is). A failure to remove one never fails the write.
 */
export async function writePrivateFileAtomic(
  path: string,
  text: string,
  options: WritePrivateFileOptions = {},
): Promise<void> {
  const attempts = Math.max(1, options.renameAttempts ?? DEFAULT_RENAME_ATTEMPTS);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPathOf(path, ATOMIC_TEMPORARY_SHAPE);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    // `writeFile` is subject to the umask, which only removes bits: set the exact mode.
    await chmod(temporary, 0o600);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (attempt >= attempts || !isTransientRename(error)) throw error;
        await sleep(10 * 2 ** (attempt - 1));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await sweepTemporaries(path, { ...options.sweep, ...ATOMIC_TEMPORARY_SHAPE });
}

/**
 * The list of saved daemons as a JSON file (`client.json`), mode 0600 because it holds tokens.
 * A write goes to a temporary file in the same folder and is renamed over the list, so a reader
 * never sees half a file; the folder is made with mode 0700 where POSIX modes exist. On Windows the
 * mode is not enforced, as for the other 0600 files of the daemon (the user profile is the guard).
 */
export class FileDaemonListStore implements DaemonListStore {
  readonly #path: string;
  readonly #renameAttempts: number;
  /** Saves of this store run one at a time, in call order: Windows refuses concurrent renames. */
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, options: FileDaemonListStoreOptions = {}) {
    this.#path = resolve(path);
    this.#renameAttempts = Math.max(1, options.renameAttempts ?? DEFAULT_RENAME_ATTEMPTS);
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<readonly DaemonConnection[]> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new DaemonDirectoryError('unreadable_file', `Cannot read ${this.#path}`, {
        cause: error,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new DaemonDirectoryError('unreadable_file', `${this.#path} is not valid JSON`, {
        cause,
      });
    }
    const parsed = DaemonListFileSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new DaemonDirectoryError(
        'unreadable_file',
        `${this.#path} is not a list of daemons: ${first?.path.join('.') ?? ''}: ${first?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data.daemons;
  }

  save(list: readonly DaemonConnection[]): Promise<void> {
    const file = DaemonListFileSchema.parse({ version: DAEMON_LIST_VERSION, daemons: list });
    const run = this.#queue.then(() => this.#write(file));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #write(file: unknown): Promise<void> {
    return writePrivateFileAtomic(this.#path, `${JSON.stringify(file, null, 2)}\n`, {
      renameAttempts: this.#renameAttempts,
    });
  }
}

export interface ReadLocalDaemonOptions {
  /** Replaces the check of the pid; tests use it. */
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Absent, or not readable by this user: either way there is no daemon to talk to from here.
    return undefined;
  }
}

/**
 * The daemon that runs on this machine, from its data folder: `api.json` (URL, id, pid) and
 * `api-token`, as the schema of `@otheater/protocol` defines. `undefined` when there is none: no
 * file, a file that is not valid, no token, or a pid that is gone (the file of a daemon that
 * crashed is stale, N166). A pid that was reused by another process passes this check; the
 * connect then fails with a network error or an id mismatch, never with a wrong daemon.
 */
export async function readLocalDaemon(
  dataDir: string,
  options: ReadLocalDaemonOptions = {},
): Promise<(LocalDaemon & { readonly pid: number; readonly apiVersion: number }) | undefined> {
  const alive = options.isPidAlive ?? isPidAlive;
  const discoveryText = await readIfExists(resolve(dataDir, API_DISCOVERY_FILE));
  if (discoveryText === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(discoveryText);
  } catch {
    return undefined;
  }
  const discovery = ApiDiscoverySchema.safeParse(json);
  if (!discovery.success || !alive(discovery.data.pid)) return undefined;
  const token = (await readIfExists(resolve(dataDir, API_TOKEN_FILE)))?.trim();
  if (token === undefined || token === '') return undefined;
  return {
    url: discovery.data.url,
    daemonId: discovery.data.daemonId,
    token,
    pid: discovery.data.pid,
    apiVersion: discovery.data.apiVersion,
  };
}

/** Discovery of the local daemon in a data folder, for the `DaemonDirectory`. */
export function localDaemonSource(
  dataDir: string,
  options: ReadLocalDaemonOptions = {},
): LocalDaemonSource {
  return { discover: () => readLocalDaemon(dataDir, options) };
}
