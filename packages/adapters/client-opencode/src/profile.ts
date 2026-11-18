// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { InvalidInput } from '@otheater/core';

/**
 * The directories of OpenCode that can be moved into the profile through the XDG variables. The
 * login of the client lives in `data` (Phase 0, item 8 [V]); `config` holds its settings; `state`
 * holds the lock files the client takes before it connects to an MCP server (Phase 4, measured
 * 2026-11-17 [V]: with a read-only `state` the MCP servers of the session stay unavailable).
 * `cache` was not measured [N].
 */
export const ISOLATED_HOMES = ['data', 'config', 'state', 'cache'] as const;
export type IsolatedHome = (typeof ISOLATED_HOMES)[number];

const XDG_VARIABLE: Readonly<Record<IsolatedHome, string>> = {
  data: 'XDG_DATA_HOME',
  config: 'XDG_CONFIG_HOME',
  state: 'XDG_STATE_HOME',
  cache: 'XDG_CACHE_HOME',
};

/**
 * [proposta] key `clients.opencode.isolation`. Default: the two homes measured in Phase 0 (`data`
 * and `config`, plus the database) and `state`. Without `state` the client writes its locks in the
 * user's own `~/.local/state/opencode`, which the sandbox (layer 3) keeps read-only, and then it
 * reaches no MCP server, not even the daemon's (Phase 4 [V]). `cache` stays in the user's own
 * directory: it holds the model list the client downloads, and isolating it costs a download per
 * profile.
 */
export const DEFAULT_ISOLATION: readonly IsolatedHome[] = ['data', 'config', 'state'];

/**
 * What goes into `opencode.json` of the profile (the `config` home), when the setting is not
 * `null`. `autoupdate: false` keeps the pinned version of the client (architecture 5.2: "Fixar a
 * versão"); `share: disabled` keeps conversations from being published. Both keys come from the
 * OpenCode config docs [S]; neither was measured [N]. [proposta] key `clients.opencode.profile_config`.
 */
export const DEFAULT_PROFILE_CONFIG: Readonly<Record<string, unknown>> = {
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  share: 'disabled',
};

/** Settings of the profile directory that both `prepareProfile` and the model catalog use. */
export interface ProfileFilesOptions {
  readonly isolation?: readonly IsolatedHome[];
  /** `null`: write no `opencode.json`. */
  readonly profileConfig?: Readonly<Record<string, unknown>> | null;
}

function assertDir(dir: string): void {
  if (dir.length === 0 || dir.includes('\0') || !isAbsolute(dir)) {
    throw new InvalidInput(
      `the profile directory must be an absolute path: ${JSON.stringify(dir)}`,
    );
  }
}

/** Where each piece lives inside the profile directory. */
export function profileLayout(dir: string): {
  readonly homes: Readonly<Record<IsolatedHome, string>>;
  readonly dbDir: string;
  readonly db: string;
  readonly configFile: string;
} {
  assertDir(dir);
  const homes = {
    data: join(dir, 'data'),
    config: join(dir, 'config'),
    state: join(dir, 'state'),
    cache: join(dir, 'cache'),
  };
  const dbDir = join(dir, 'db');
  return {
    homes,
    dbDir,
    db: join(dbDir, 'opencode.db'),
    configFile: join(homes.config, 'opencode', 'opencode.json'),
  };
}

/**
 * The variables that point OpenCode at the profile: the XDG homes and `OPENCODE_DB`. With them a
 * profile starts with zero logins and its own database (Phase 0, item 8 [V]). Pure.
 */
export function isolationEnv(
  dir: string,
  homes: readonly IsolatedHome[] = DEFAULT_ISOLATION,
): Record<string, string> {
  const layout = profileLayout(dir);
  const env: Record<string, string> = {};
  for (const home of ISOLATED_HOMES) {
    if (homes.includes(home)) env[XDG_VARIABLE[home]] = layout.homes[home];
  }
  env.OPENCODE_DB = layout.db;
  return env;
}

/**
 * Layer 1 in files: makes the directories of the profile and writes `opencode.json` of the
 * profile. It creates the directory of the login (`data`) and nothing inside it: the login file
 * belongs to the client, and this function never reads, writes or lists it.
 */
export async function ensureProfileFiles(
  dir: string,
  options: ProfileFilesOptions = {},
): Promise<void> {
  const layout = profileLayout(dir);
  const homes = options.isolation ?? DEFAULT_ISOLATION;
  const profileConfig =
    options.profileConfig === undefined ? DEFAULT_PROFILE_CONFIG : options.profileConfig;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const home of homes) await mkdir(layout.homes[home], { recursive: true, mode: 0o700 });
  await mkdir(layout.dbDir, { recursive: true, mode: 0o700 });
  if (profileConfig === null || !homes.includes('config')) return;
  const text = `${JSON.stringify(profileConfig, null, 2)}\n`;
  let current: string | undefined;
  try {
    current = await readFile(layout.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === text) return;
  await mkdir(join(layout.homes.config, 'opencode'), { recursive: true, mode: 0o700 });
  const temporary = `${layout.configFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, layout.configFile);
}
