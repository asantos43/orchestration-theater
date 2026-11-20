// SPDX-License-Identifier: MPL-2.0
import { posix, resolve, win32 } from 'node:path';

/** Environment as the path functions need it; tests pass a plain object, never `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Overrides the folder of the client's own files (a path, not a secret). Used by the tests. [proposta] */
export const CLIENT_CONFIG_DIR_ENV = 'OT_CLIENT_CONFIG_DIR';

/** The list of daemons, inside the client folder. */
export const CLIENT_CONFIG_FILE = 'client.json';

/** Same name as in the daemon (`packages/daemon/src/paths.ts`). */
export const DATA_DIR_ENV = 'OT_DATA_DIR';

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * [proposta] Folder of the client's own files (`client.json`), one per user, by platform:
 * - Linux and the other Unixes: `$XDG_CONFIG_HOME/otheater`, or `~/.config/otheater` (an
 *   `XDG_CONFIG_HOME` that is empty or not absolute is ignored, as the XDG spec says);
 * - macOS: `~/Library/Application Support/OTheater` (the same folder as the daemon's data);
 * - Windows: `%APPDATA%\OTheater`, or `<home>\AppData\Roaming\OTheater`.
 *
 * Pure, like `defaultDataDir` of the daemon, so every platform is testable from any machine.
 */
export function defaultClientConfigDir(
  platform: NodeJS.Platform,
  env: Env,
  homedir: string,
): string {
  if (platform === 'win32') {
    const base = nonEmpty(env.APPDATA) ?? win32.join(homedir, 'AppData', 'Roaming');
    return win32.join(base, 'OTheater');
  }
  if (platform === 'darwin') {
    return posix.join(homedir, 'Library', 'Application Support', 'OTheater');
  }
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  const base = xdg !== undefined && posix.isAbsolute(xdg) ? xdg : posix.join(homedir, '.config');
  return posix.join(base, 'otheater');
}

export interface ResolvePathsInput {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}

/** `OT_CLIENT_CONFIG_DIR`, else {@link defaultClientConfigDir}. */
export function resolveClientConfigDir(input: ResolvePathsInput): string {
  const explicit = nonEmpty(input.env[CLIENT_CONFIG_DIR_ENV]);
  if (explicit !== undefined) return resolve(explicit);
  return defaultClientConfigDir(input.platform, input.env, input.homedir);
}

/** The list file inside the client folder. */
export function clientConfigFile(configDir: string): string {
  return resolve(configDir, CLIENT_CONFIG_FILE);
}

/**
 * [proposta] The data folder of the local daemon: a COPY of `defaultDataDir` and `resolveDataDir`
 * of `packages/daemon/src/paths.ts`, because the client must not import the daemon. Keep the two
 * in step: a change there is a change here (`paths.test.ts` of this package pins the same table).
 * Order: the explicit folder, then `OT_DATA_DIR`, then the platform default.
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

export interface ResolveDataDirInput extends ResolvePathsInput {
  /** An explicit folder, when the caller has one (the `--data-dir` option). */
  readonly explicit?: string | undefined;
}

export function resolveDataDir(input: ResolveDataDirInput): string {
  const explicit = nonEmpty(input.explicit) ?? nonEmpty(input.env[DATA_DIR_ENV]);
  if (explicit !== undefined) return resolve(explicit);
  return defaultDataDir(input.platform, input.env, input.homedir);
}
