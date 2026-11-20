// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

/**
 * The only module of the client that touches files (plan docs/17 P9): the list of daemons, with
 * its atomic write at mode 0600, and the discovery of the local daemon from the data folder. The
 * dependency rule (`.dependency-cruiser.js`) keeps Node modules out of everything else.
 */

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT';
}

/**
 * The list of saved daemons as a JSON file (`client.json`), mode 0600 because it holds tokens.
 * A write goes to a temporary file in the same folder and is renamed over the list, so a reader
 * never sees half a file; the folder is made with mode 0700 where POSIX modes exist. On Windows the
 * mode is not enforced, as for the other 0600 files of the daemon (the user profile is the guard).
 */
export class FileDaemonListStore implements DaemonListStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = resolve(path);
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

  async save(list: readonly DaemonConnection[]): Promise<void> {
    const file = DaemonListFileSchema.parse({ version: DAEMON_LIST_VERSION, daemons: list });
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      // `writeFile` is subject to the umask, which only removes bits: set the exact mode.
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** True when a process with this pid exists (signal 0 only checks). `EPERM` means it exists. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | undefined)?.code === 'EPERM';
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
