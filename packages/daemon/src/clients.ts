// SPDX-License-Identifier: MPL-2.0
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import type {
  ClientAdapter,
  Clock,
  LaunchWrapper,
  ProcessLauncher,
  SandboxCapabilities,
  SessionTransport,
} from '@otheater/core';
import { CLIENT_IDS, type ClientId, type DaemonConfig } from './config.js';
import type { Logger } from './logger.js';
import type { DataPaths, Env } from './paths.js';

/**
 * What a factory of clients may need to build its adapters. The daemon fills it in; a test
 * factory takes only what it needs.
 */
export interface ClientFactoryParts {
  readonly launcher: ProcessLauncher;
  readonly clock: Clock;
  /** The wire the sessions speak: what a probe that opens its own session goes through. */
  readonly transport: SessionTransport;
  /** Where the profiles and the scratch worktrees live (`<data>/profiles`, `<data>/scratch`). */
  readonly paths: DataPaths;
  readonly logger: Logger;
  /**
   * Layer 3 (architecture 5.8), when it is on: what it guarantees (for `guarantee()`) and the wrapper
   * that confines the launch of the client. Absent when the sandbox is off or not available; a
   * factory that does not pass it on starts its clients unconfined.
   */
  readonly sandbox?: SandboxParts;
}

/** What a client adapter takes of layer 3 (`ClientAdapterOptions.sandbox` and `.launchWrapper`). */
export interface SandboxParts {
  readonly capabilities: SandboxCapabilities;
  readonly launchWrapper: LaunchWrapper;
}

/**
 * Builds the `ClientAdapter`s the daemon executes attempts with. They are injected, not named
 * here: the daemon imports adapters only in `compose.ts` (architecture 5.18). The three real
 * clients are wired by `productionClients`; tests pass the fake.
 */
export type ClientFactory = (parts: ClientFactoryParts) => readonly ClientAdapter[];

/**
 * Looks an executable up without running it: the path where it is, or `undefined`. A function,
 * so a test can say what is installed without touching the machine's `PATH`.
 */
export type FindExecutable = (command: string) => string | undefined;

/** Does `path` name a file the user may run? Injected in tests; never executes anything. */
export type IsExecutable = (path: string) => boolean;

/** The real check: a regular file with the execute bit (on Windows, any regular file). */
export const fileIsExecutable: IsExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface PathSearchOptions {
  /** Value of `PATH` (`Path` on Windows); an unset one finds nothing. */
  readonly path: string | undefined;
  readonly platform?: NodeJS.Platform;
  /** Value of `PATHEXT`, for Windows. Default `.COM;.EXE;.BAT;.CMD`. */
  readonly pathExt?: string | undefined;
  readonly isExecutable?: IsExecutable;
}

/**
 * The `which` of the daemon, in code: a command with a separator is checked as it is; a bare name
 * is looked for in each `PATH` directory, in order, and the first executable file wins (on Windows
 * each `PATHEXT` extension is tried too). It reads the file system and never runs the binary.
 */
export function searchPath(command: string, options: PathSearchOptions): string | undefined {
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? fileIsExecutable;
  const windows = platform === 'win32';
  const extensions = windows
    ? ['', ...(options.pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')]
    : [''];
  const candidates = (base: string): string[] => extensions.map((ext) => `${base}${ext}`);

  if (command.includes('/') || (windows && command.includes('\\'))) {
    return candidates(command).find((candidate) => isExecutable(candidate));
  }
  const separator = windows ? ';' : delimiter;
  for (const dir of (options.path ?? '').split(separator)) {
    if (dir === '') continue;
    const joined = windows ? win32.join(dir, command) : join(dir, command);
    const found = candidates(joined).find((candidate) => isExecutable(candidate));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A {@link FindExecutable} over the `PATH` of `env`. */
export function pathFinder(
  env: Env,
  options: { platform?: NodeJS.Platform; isExecutable?: IsExecutable } = {},
): FindExecutable {
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH;
  return (command) =>
    searchPath(command, {
      path,
      platform,
      pathExt: env.PATHEXT,
      ...(options.isExecutable === undefined ? {} : { isExecutable: options.isExecutable }),
    });
}

/** Why a client is on or off (what the log says about it). */
export type ClientSelectionReason =
  /** `enabled: false`. */
  | 'disabled'
  /** `command` is set in the config. */
  | 'command_configured'
  /** The default executable is in `PATH`. */
  | 'found_in_path'
  /** `enabled: auto` and the default executable is nowhere in `PATH`. */
  | 'not_found'
  /** `enabled: true`, no `command` and the default executable is not in `PATH`: on, and it will fail when it starts. */
  | 'forced_not_found';

export interface ClientSelection {
  readonly id: ClientId;
  readonly enabled: boolean;
  readonly reason: ClientSelectionReason;
  /** The executable the client starts: `command.cmd` when set, else the default. */
  readonly executable: string;
  /** Where the search found it (`found_in_path` only). */
  readonly resolvedPath?: string;
}

/**
 * Decides which clients are on (architecture 5.2, [proposta] `clients.<id>.enabled`):
 * `false` is off; `true` is on; `auto` (the default) is on when `command` is set or the default
 * executable is found. `defaults` names the executable each client starts without `command`.
 * Pure: the search is `find`.
 */
export function selectClients(
  config: Pick<DaemonConfig, 'clients'>,
  defaults: Readonly<Record<ClientId, string>>,
  find: FindExecutable,
): readonly ClientSelection[] {
  return CLIENT_IDS.map((id): ClientSelection => {
    const section = config.clients[id];
    const configured = section.command?.cmd;
    const executable = configured ?? defaults[id];
    if (section.enabled === false) return { id, enabled: false, reason: 'disabled', executable };
    if (configured !== undefined) {
      return { id, enabled: true, reason: 'command_configured', executable };
    }
    const resolvedPath = find(executable);
    if (resolvedPath !== undefined) {
      return { id, enabled: true, reason: 'found_in_path', executable, resolvedPath };
    }
    return section.enabled === true
      ? { id, enabled: true, reason: 'forced_not_found', executable }
      : { id, enabled: false, reason: 'not_found', executable };
  });
}

/**
 * [proposta] What `env_inherit: minimal` lets through from the daemon's environment: what a
 * program needs to run and find its way (paths, locale, temp folder, shell), the proxy and
 * certificate variables, and on Windows the system folders. No credential of any kind: the login
 * of a client lives in its profile, and a key goes through the vault.
 */
export const MINIMAL_ENV_NAMES: readonly string[] = [
  'PATH',
  'Path',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

export interface ClientEnvSettings {
  readonly env_inherit: 'minimal' | 'none' | 'all';
  readonly env_allow: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The environment a client process starts from (`ClientAdapterOptions.baseEnv`), built from the
 * daemon's own: what `env_inherit` lets through, plus `env_allow`, then the literal `env` on top.
 * The adapter adds the profile variables after this. Unset variables are left out.
 */
export function buildClientEnv(
  settings: ClientEnvSettings,
  source: Env,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const take = (name: string): void => {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  };
  if (settings.env_inherit === 'all') {
    for (const name of Object.keys(source)) take(name);
  } else if (settings.env_inherit === 'minimal') {
    for (const name of MINIMAL_ENV_NAMES) take(name);
  }
  for (const name of settings.env_allow) take(name);
  return { ...out, ...settings.env };
}

/**
 * [proposta] `adapterVersion` of a client: the adapter's own version, then the client's. The
 * conformance cache is keyed by it, so it changes when either does (architecture 5.2). The
 * client version comes from `client_version`, the `package.json` of the installed package or the
 * `initialize` of a session (`clients.<id>.version_source`, N63), or is `unknown`: the daemon
 * never runs a client to ask.
 */
export function adapterVersionOf(adapterBase: string, id: ClientId, clientVersion: string): string {
  return `${adapterBase}+${id}.${clientVersion}`;
}
