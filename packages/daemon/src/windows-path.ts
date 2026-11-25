// SPDX-License-Identifier: MPL-2.0
import type { ClientPathMode } from './config.js';
import type { Env } from './paths.js';
import { execRunner, type CommandRunner } from './service/command-runner.js';

/**
 * The `Path` of the Windows registry (P18, N321). A process keeps the `PATH` it was started with,
 * so a daemon that started before a client was installed (or that the logon service started with
 * a short environment) does not see the new folder. The registry has the one Windows gives a new
 * logon: the machine's (`HKLM\...\Session Manager\Environment`) and then the user's
 * (`HKCU\Environment`). `reg query` only reads; nothing here writes the registry.
 */
export const REGISTRY_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const;

/** [proposta] How long one `reg query` may take before its answer is left out. */
const REG_TIMEOUT_MS = 5_000;

/**
 * The value of `Path` in the output of `reg query <key> /v Path`, or `undefined`. A line is
 * `    Path    REG_EXPAND_SZ    C:\a;%USERPROFILE%\b` (or `REG_SZ`); the name is matched with no
 * regard to case, as Windows does.
 */
export function parseRegQueryPath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return undefined;
}

/**
 * Expands `%NAME%` with `env`, the name with no regard to case (as `cmd` does). A name that is not
 * set stays as it is written, so the folder is simply not found.
 */
export function expandWindowsVars(value: string, env: Env): string {
  const byName = new Map<string, string>();
  for (const [name, entry] of Object.entries(env)) {
    if (entry !== undefined) byName.set(name.toUpperCase(), entry);
  }
  return value.replace(
    /%([^%;]+)%/g,
    (whole, name: string) => byName.get(name.toUpperCase()) ?? whole,
  );
}

/** A folder as Windows compares them: no case, no trailing separator, `/` as `\`. */
function folderKey(folder: string): string {
  return folder.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * `first` and then the folders of each of `more` that are not in it yet, in order, joined with
 * `;`. Empty entries are dropped; the folders of `first` keep their place, so what the daemon got
 * still wins.
 */
export function mergeWindowsPath(first: string | undefined, more: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [first ?? '', ...more]) {
    for (const folder of list.split(';')) {
      const trimmed = folder.trim();
      if (trimmed === '') continue;
      const key = folderKey(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.join(';');
}

export interface ClientEnvOptions {
  readonly mode: ClientPathMode;
  readonly platform?: NodeJS.Platform;
  /** Runs `reg`; the fake of the tests answers from a table. */
  readonly run?: CommandRunner;
}

/** What {@link clientSearchEnv} did, for the log and the event of a degraded read. */
export interface ClientEnvResult {
  readonly env: Env;
  /** Folders the registry added to the `PATH` the daemon got. */
  readonly added: number;
  /** The keys whose `reg query` failed (the `PATH` goes on without them). */
  readonly failed: readonly string[];
}

/**
 * The environment the clients are searched in and started with: `env` itself, or on Windows with
 * `merge` the same with its `Path` (or `PATH`) completed from the registry. It never throws: a
 * `reg query` that fails is named in `failed` and its folders are left out.
 */
export async function clientSearchEnv(
  env: Env,
  options: ClientEnvOptions,
): Promise<ClientEnvResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || options.mode === 'process') return { env, added: 0, failed: [] };
  const run = options.run ?? execRunner;
  const failed: string[] = [];
  const more: string[] = [];
  for (const key of REGISTRY_PATH_KEYS) {
    const result = await run('reg', ['query', key, '/v', 'Path'], { timeoutMs: REG_TIMEOUT_MS });
    const value = result.code === 0 ? parseRegQueryPath(result.stdout) : undefined;
    if (value === undefined) {
      // `reg` ends with 1 when the value is not there (the user's key may have no `Path`): nothing
      // to add. Not starting at all, or another code, is a failure the caller tells.
      if (result.spawnFailed === true || (result.code !== 0 && result.code !== 1)) failed.push(key);
      continue;
    }
    more.push(expandWindowsVars(value, env));
  }
  // Windows names it `Path`; a daemon started by something else may have `PATH`.
  const name = env.Path !== undefined ? 'Path' : env.PATH !== undefined ? 'PATH' : 'Path';
  const before = env[name];
  const merged = mergeWindowsPath(before, more);
  const count = (list: string | undefined): number =>
    (list ?? '').split(';').filter((folder) => folder.trim() !== '').length;
  const added = Math.max(0, count(merged) - count(mergeWindowsPath(before, [])));
  if (added === 0) return { env, added: 0, failed };
  return { env: { ...env, [name]: merged }, added, failed };
}
