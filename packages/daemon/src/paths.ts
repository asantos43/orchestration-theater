// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';
import { InvalidInput } from '@otheater/core';

/** Environment as the path functions need it; tests pass a plain object, never `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Name of the environment variable that overrides the data directory (a path, not a secret). */
export const DATA_DIR_ENV = 'OT_DATA_DIR';

/**
 * [proposta] Default data directory, one folder per user holding everything the daemon owns
 * (`config.yaml`, `store.sqlite`, `daemon.lock`, `backups/`, `logs/`):
 * - Linux and the other Unixes: `$XDG_DATA_HOME/otheater`, or `~/.local/share/otheater` (an
 *   `XDG_DATA_HOME` that is empty or not absolute is ignored, as the XDG spec says);
 * - macOS: `~/Library/Application Support/OTheater`;
 * - Windows: `%LOCALAPPDATA%\OTheater`, or `<home>\AppData\Local\OTheater`.
 *
 * Pure: the platform, the environment and the home directory are arguments, so every platform is
 * testable from any machine and no test depends on the real environment.
 */
export function defaultDataDir(platform: NodeJS.Platform, env: Env, homedir: string): string {
  if (platform === 'win32') {
    const base = nonEmpty(env.LOCALAPPDATA) ?? win32.join(homedir, 'AppData', 'Local');
    return win32.join(base, 'OTheater');
  }
  if (platform === 'darwin') {
    return posix.join(homedir, 'Library', 'Application Support', 'OTheater');
  }
  const xdg = nonEmpty(env.XDG_DATA_HOME);
  const base =
    xdg !== undefined && posix.isAbsolute(xdg) ? xdg : posix.join(homedir, '.local', 'share');
  return posix.join(base, 'otheater');
}

export interface ResolveDataDirInput {
  /** The `--data-dir` option, when given. */
  readonly flag?: string | undefined;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}

/**
 * Order: `--data-dir`, then `OT_DATA_DIR`, then {@link defaultDataDir}. An explicit relative path
 * is made absolute against the current directory.
 */
export function resolveDataDir(input: ResolveDataDirInput): string {
  const explicit = nonEmpty(input.flag) ?? nonEmpty(input.env[DATA_DIR_ENV]);
  if (explicit !== undefined) return resolve(explicit);
  return defaultDataDir(input.platform, input.env, input.homedir);
}

/** Where each piece lives inside the data directory. */
export interface DataPaths {
  readonly dataDir: string;
  readonly config: string;
  readonly store: string;
  readonly lock: string;
  /** Who holds the lock, for the "already running" message (the lock itself blocks readers). */
  readonly lockInfo: string;
  readonly backups: string;
  readonly logs: string;
  readonly logFile: string;
  readonly scenarios: string;
  /** The worktrees of the attempts (`<worktrees>/<play>/<demand>-<n>`). */
  readonly worktrees: string;
  /** The profiles of the clients (`<profiles>/<client>/<profile>`, architecture 5.18). */
  readonly profiles: string;
  /** Scratch worktrees of the probes (the OpenCode permission probe creates its own here). */
  readonly scratch: string;
  /**
   * Where a running daemon publishes the address and token of the Producer channel `ot chat`
   * talks to (P8, N78). Mode 0600; removed when the daemon stops.
   */
  readonly channel: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const root = resolve(dataDir);
  return {
    dataDir: root,
    config: resolve(root, 'config.yaml'),
    store: resolve(root, 'store.sqlite'),
    lock: resolve(root, 'daemon.lock'),
    lockInfo: resolve(root, 'daemon.lock.json'),
    backups: resolve(root, 'backups'),
    logs: resolve(root, 'logs'),
    logFile: resolve(root, 'logs', 'daemon.log'),
    scenarios: resolve(root, 'scenarios'),
    worktrees: resolve(root, 'worktrees'),
    profiles: resolve(root, 'profiles'),
    scratch: resolve(root, 'scratch'),
    channel: resolve(root, 'channel.json'),
  };
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Absolute directory of one profile: `<data>/profiles/<client>/<profile>`. Both names become one
 * path segment each, so a name with a separator, `..` or a leading dot is refused (`InvalidInput`)
 * instead of leading out of the data directory.
 */
export function profileDirOf(paths: Pick<DataPaths, 'profiles'>, ref: ProfileNames): string {
  for (const [what, value] of [
    ['client', ref.client],
    ['profile', ref.profile],
  ] as const) {
    if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
      throw new InvalidInput(`Profile ${what} "${value}" cannot be a directory name`);
    }
  }
  return resolve(paths.profiles, ref.client, ref.profile);
}

/** The two names that locate a profile (a `ProfileRef` of the core). */
export interface ProfileNames {
  readonly client: string;
  readonly profile: string;
}

/**
 * Creates the data directory (and its parents) with mode 0700 where POSIX permissions exist. An
 * existing directory keeps the mode it has: the user may have chosen it on purpose.
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  const root = resolve(dataDir);
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  // `mkdir` is subject to the umask, which can only remove bits; set the exact mode on what we made.
  if (created !== undefined && process.platform !== 'win32') await chmod(root, 0o700);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
