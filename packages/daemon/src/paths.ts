// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, stat } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { API_DISCOVERY_FILE, API_TOKEN_FILE, DAEMON_ID_FILE } from '@otheater/protocol';

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
   * Where a running daemon publishes where its API is (`api.json`: url, daemon id, pid, API version;
   * never the token). Mode 0600; removed when the daemon stops cleanly (P3, N166).
   */
  readonly apiDiscovery: string;
  /** The API token (mode 0600). Kept apart from `api.json`: with `api.token: persistent` it outlives a start. */
  readonly apiToken: string;
  /** The id of the daemon (N168): a UUID made on the first start. Goes into a backup and back with `ot restore`. */
  readonly daemonId: string;
  /**
   * The commands by profile (P28b, N159): one small script per profile (`codex-personal`) that only
   * calls `ot profile exec`. The person puts this folder in `PATH`, by hand or with
   * `ot profile shims path --install`.
   */
  readonly bin: string;
  /** The ACP adapters OTheater installs (`<adapters>/<id>/<version>`; P13, N254 revised). */
  readonly adapters: string;
  /** The layout preferences of the interfaces, one file each (`<layout>/<interface>.json`; P12, N170). */
  readonly layout: string;
  /**
   * Test seam (`ComposeOverrides.profileDir`): where a profile lives instead of
   * `<profiles>/<client>/<profile>`, for the sessions and the clients ({@link profileDirOf}). The
   * product never sets it. The real tests point a profile at a logged-in folder outside the data
   * directory with it: a link inside `<data>` is hidden by the sandbox (layer 3), which denies
   * `<data>` and does not follow the link when it reads the profile again (measured 2026-11-20:
   * ENOENT on read and write through the link; with `<data>` open, the write is EROFS).
   */
  readonly profileDirOverride?: ((ref: ProfileNames) => string) | undefined;
}

export function dataPaths(
  dataDir: string,
  profileDirOverride?: (ref: ProfileNames) => string,
): DataPaths {
  const root = resolve(dataDir);
  return {
    ...(profileDirOverride === undefined ? {} : { profileDirOverride }),
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
    apiDiscovery: resolve(root, API_DISCOVERY_FILE),
    apiToken: resolve(root, API_TOKEN_FILE),
    daemonId: resolve(root, DAEMON_ID_FILE),
    bin: resolve(root, 'bin'),
    adapters: resolve(root, 'adapters'),
    layout: resolve(root, 'layout'),
  };
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Absolute directory of one profile: `<data>/profiles/<client>/<profile>`. Both names become one
 * path segment each, so a name with a separator, `..` or a leading dot is refused (`InvalidInput`)
 * instead of leading out of the data directory. With the test seam
 * ({@link DataPaths.profileDirOverride}) the names are checked the same way and the seam answers.
 */
export function profileDirOf(
  paths: Pick<DataPaths, 'profiles' | 'profileDirOverride'>,
  ref: ProfileNames,
): string {
  for (const [what, value] of [
    ['client', ref.client],
    ['profile', ref.profile],
  ] as const) {
    if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
      throw new InvalidInput(`Profile ${what} "${value}" cannot be a directory name`);
    }
  }
  if (paths.profileDirOverride !== undefined) return resolve(paths.profileDirOverride(ref));
  return resolve(paths.profiles, ref.client, ref.profile);
}

/** The two names that locate a profile (a `ProfileRef` of the core). */
export interface ProfileNames {
  readonly client: string;
  readonly profile: string;
}

/**
 * Creates the data directory (and its parents) with mode 0700 where POSIX permissions exist. An
 * existing directory that others can enter (group or other bits) is closed to them (`chmod g-rwx,o-rwx`,
 * the owner's bits stay as they are): the folder holds the API token, the store and the profiles, so a
 * mode the user did not choose on purpose is the likelier case, and the files in it are 0600 anyway. A
 * folder of another user is left alone (`chmod` would fail, and it is not ours to change). On Windows
 * the folder is private to the user by its place (`%LOCALAPPDATA%`), and nothing is changed.
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  const root = resolve(dataDir);
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  // `mkdir` is subject to the umask, which can only remove bits; set the exact mode on what we made.
  if (created !== undefined) {
    await chmod(root, 0o700);
    return;
  }
  const info = await stat(root);
  const uid = process.getuid?.();
  if ((info.mode & 0o077) !== 0 && (uid === undefined || info.uid === uid)) {
    await chmod(root, info.mode & ~0o077);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
