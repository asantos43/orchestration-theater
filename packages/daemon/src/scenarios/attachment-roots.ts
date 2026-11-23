// SPDX-License-Identifier: MPL-2.0
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import type { Store } from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import type { Env } from '../paths.js';

/**
 * Where an attachment taken BY PATH may come from (N287, owner, 2026-11-23). A file the Producer
 * names is read by the daemon and copied into the scenario (or referenced in place), and from there
 * an Actor can read it: with no limit, `{ "path": "~/.ssh/id_ed25519" }` is a way to hand a secret to
 * a model. `security.attachment_roots` limits it:
 *
 * - `any`: any readable file (what it was before);
 * - `list` (default): a file under one of the roots. The roots are, by `defaults`: the project (the
 *   repos of the scenario), the worktrees of its plays, the Documents folder and the Downloads folder
 *   of the user; and whatever the user put in `add`.
 *
 * The path is resolved with `realpath` before the check (and the roots too), so a link that leaves a
 * root does not pass, and a `..` does not either.
 */

/** What the service asks: the roots for a scenario, or `any`. */
export type AttachmentRootsPolicy = (scenarioId: string) => Promise<readonly string[] | 'any'>;

/** The policy of the tests and of a daemon that set `security.attachment_roots.mode: any`. */
export const ANY_ATTACHMENT_ROOT: AttachmentRootsPolicy = () => Promise.resolve('any');

/** The part of the config the roots read. */
export type AttachmentRootsConfig = DaemonConfig['security']['attachment_roots'];

export interface AttachmentRootsOptions {
  /** `config.security.attachment_roots`, read at each attachment. */
  readonly config: () => AttachmentRootsConfig;
  readonly store: Pick<Store, 'scenarioRepos' | 'plays'>;
  /** `<data>/worktrees`: the worktree of a play is `<worktrees>/<playId>`. */
  readonly worktrees: string;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}

/** The policy `security.attachment_roots` describes. */
export function attachmentRootsPolicy(options: AttachmentRootsOptions): AttachmentRootsPolicy {
  return async (scenarioId) => {
    const config = options.config();
    if (config.mode === 'any') return 'any';
    const roots: string[] = [];
    const wants = new Set(config.defaults);
    if (wants.has('project')) {
      for (const repo of await options.store.scenarioRepos.list(scenarioId)) roots.push(repo.path);
    }
    if (wants.has('worktrees')) {
      for (const play of await options.store.plays.list({ scenarioId })) {
        roots.push(join(options.worktrees, play.id));
      }
    }
    if (wants.has('documents')) roots.push(await userFolder('documents', options));
    if (wants.has('downloads')) roots.push(await userFolder('downloads', options));
    for (const added of config.add) roots.push(expandHome(added, options));
    return roots;
  };
}

/** `~` and `~/x` of an entry of `add`, with the home of the user. */
function expandHome(entry: string, options: Pick<AttachmentRootsOptions, 'homedir' | 'platform'>) {
  if (entry === '~') return options.homedir;
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return (options.platform === 'win32' ? win32 : posix).join(options.homedir, entry.slice(2));
  }
  return entry;
}

/**
 * The Documents or the Downloads folder of the user, for the platform:
 *
 * - Linux and the other Unixes: `XDG_DOCUMENTS_DIR` / `XDG_DOWNLOAD_DIR` of the environment, then the
 *   same names in `$XDG_CONFIG_HOME/user-dirs.dirs` (where `xdg-user-dirs` keeps them), then
 *   `~/Documents` and `~/Downloads`;
 * - macOS: `~/Documents` and `~/Downloads`;
 * - Windows: `%USERPROFILE%\Documents` and `\Downloads`. [N] A folder the user moved elsewhere (the
 *   Known Folders of the registry, or OneDrive's Known Folder Move) is not asked of the system here;
 *   `add` is how the user names it.
 *
 * Pure but for the read of `user-dirs.dirs`, which a missing file only skips.
 */
export async function userFolder(
  which: 'documents' | 'downloads',
  options: Pick<AttachmentRootsOptions, 'env' | 'platform' | 'homedir'>,
): Promise<string> {
  const { env, platform, homedir } = options;
  const name = which === 'documents' ? 'Documents' : 'Downloads';
  if (platform === 'win32') return win32.join(env.USERPROFILE ?? homedir, name);
  if (platform === 'darwin') return posix.join(homedir, name);
  const key = which === 'documents' ? 'XDG_DOCUMENTS_DIR' : 'XDG_DOWNLOAD_DIR';
  const fromEnv = env[key];
  if (fromEnv !== undefined && posix.isAbsolute(fromEnv)) return fromEnv;
  const config = env.XDG_CONFIG_HOME;
  const configHome =
    config !== undefined && posix.isAbsolute(config) ? config : posix.join(homedir, '.config');
  const text = await readFile(posix.join(configHome, 'user-dirs.dirs'), 'utf8').catch(
    () => undefined,
  );
  const listed = text === undefined ? undefined : userDirOf(text, key, homedir);
  return listed ?? posix.join(homedir, name);
}

/** The value of `KEY="$HOME/Documents"` in a `user-dirs.dirs`, with `$HOME` expanded; absolute only. */
function userDirOf(text: string, key: string, homedir: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match?.[1] !== key || match[2] === undefined) continue;
    const value = match[2].replace(/^\$HOME(?=\/|$)/, homedir);
    return posix.isAbsolute(value) ? value : undefined;
  }
  return undefined;
}

/** Folds the case on the systems whose file names do not tell `A` from `a` (Windows, macOS). */
function comparable(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? path.toLowerCase() : path;
}

/** Whether `real` (already a `realpath`) is `root` or inside it. */
export function isInsideRoot(real: string, root: string, platform: NodeJS.Platform): boolean {
  const from = comparable(root, platform);
  const to = comparable(real, platform);
  const way = relative(from, to);
  return way === '' || (way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way));
}

/**
 * Whether the real path of a file is under one of the roots. The roots go through `realpath` as well
 * (a project in a linked folder is still the project); a root that does not exist is skipped.
 */
export async function isUnderRoots(
  real: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  for (const root of roots) {
    const resolved = await realpath(resolve(root)).catch(() => undefined);
    if (resolved !== undefined && isInsideRoot(real, resolved, platform)) return true;
  }
  return false;
}
