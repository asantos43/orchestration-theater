// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from './errors.js';

/**
 * The list of secret paths (architecture 5.19, `security.secret_paths`; `browser.secret_paths` is an
 * alias of the same list [proposta]). One list, two users: the `Sandbox` (layer 3) denies the READ
 * of these paths to an Executor, and `browser_open` refuses a `file://` URL that points at one.
 *
 * Pure: no file system, no `node:path` (rule `core-only-zod`). The caller gives the home directory
 * and the data directory and passes REAL paths (symlinks already resolved) to {@link isSecretPath}.
 * [proposta] Only the POSIX spelling is known: the macOS and Windows equivalents are `[a definir]`
 * in the architecture.
 *
 * An entry is one of:
 * - `~` or `~/...`: relative to the home directory (`~/.ssh`);
 * - `<data>` or `<data>/...`: relative to the data directory of the daemon, which holds the
 *   OTheater profiles (5.6);
 * - an absolute path (`/etc/secret`);
 * - a name with no `/` (`.env`, `.env.*`): matches a file or folder of that name in ANY folder.
 * A segment may use `*` (any run of characters) and `?` (one character), so `~/.var/app/*\/config`
 * covers the Flatpak profiles. A path is secret when it is an entry or lies inside one.
 */
export const DEFAULT_SECRET_PATHS: readonly string[] = [
  // Keys and logins.
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/gcloud',
  '~/.kube',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.git-credentials',
  // Profiles of the clients.
  '~/.claude',
  '~/.claude.json',
  '~/.codex',
  '~/.config/opencode',
  '~/.local/share/opencode',
  // Keyrings and browser profiles.
  '~/.local/share/keyrings',
  '~/.config/google-chrome',
  '~/.config/chromium',
  '~/.mozilla',
  '~/.var/app/*/config',
  // The data of the daemon, with the OTheater profiles (5.6).
  '<data>',
  // `.env` files in any folder.
  '.env',
  '.env.*',
];

/** What {@link resolveSecretPaths} needs. */
export interface SecretPathsOptions {
  /** Absolute home directory of the account that runs the daemon. */
  readonly home: string;
  /** Absolute data directory of the daemon. Without it the `<data>` entry is dropped. */
  readonly dataDir?: string | undefined;
  /** Entries added to the defaults (`security.secret_paths.add`). */
  readonly add?: readonly string[] | undefined;
  /** Entries removed, written as in the list or already resolved (`security.secret_paths.remove`). */
  readonly remove?: readonly string[] | undefined;
}

function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

function assertAbsolute(name: string, value: string): string {
  const clean = trimSlashes(value.replaceAll('\\', '/'));
  if (!clean.startsWith('/') || clean === '/') {
    throw new InvalidInput(`${name} must be an absolute path other than the root (got "${value}")`);
  }
  return clean;
}

/** One entry with `~` and `<data>` expanded; `undefined` for `<data>` when there is no data directory. */
function expandEntry(entry: string, home: string, dataDir: string | undefined): string | undefined {
  const text = entry.trim().replaceAll('\\', '/');
  if (text === '') throw new InvalidInput('a secret path cannot be empty');
  if (text === '~' || text === '~/' || text === '<data>' || text === '<data>/') {
    // The whole home directory is not a "secret": it would deny everything. Refused on purpose.
    if (text.startsWith('~')) {
      throw new InvalidInput(
        'a secret path cannot be the whole home directory ("~"): name what is secret inside it',
      );
    }
    return dataDir;
  }
  if (text.startsWith('~/')) return trimSlashes(`${home}/${text.slice(2)}`);
  if (text.startsWith('<data>/')) {
    return dataDir === undefined ? undefined : trimSlashes(`${dataDir}/${text.slice(7)}`);
  }
  if (text.startsWith('/')) {
    const clean = trimSlashes(text);
    if (clean === '/')
      throw new InvalidInput('a secret path cannot be the root of the file system');
    return clean;
  }
  if (text.includes('/')) {
    throw new InvalidInput(
      `secret path "${entry}" is neither absolute, "~/...", "<data>/..." nor a bare name`,
    );
  }
  return text;
}

/**
 * The effective list: the defaults and the additions, with `~` and `<data>` expanded and the
 * removals applied, each entry once, in order. `remove` takes the entry as written in the list
 * (`~/.mozilla`) or already expanded; an entry that is not in the list is ignored. Throws
 * `InvalidInput` for an empty entry, for `~` alone (it would deny the whole home) and for a
 * relative path with a `/` in it.
 */
export function resolveSecretPaths(options: SecretPathsOptions): readonly string[] {
  const home = assertAbsolute('home', options.home);
  const dataDir =
    options.dataDir === undefined ? undefined : assertAbsolute('dataDir', options.dataDir);
  const removed = new Set<string>();
  for (const entry of options.remove ?? []) {
    removed.add(entry.trim());
    const expanded = expandEntry(entry, home, dataDir);
    if (expanded !== undefined) removed.add(expanded);
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of [...DEFAULT_SECRET_PATHS, ...(options.add ?? [])]) {
    const expanded = expandEntry(entry, home, dataDir);
    if (expanded === undefined) continue;
    if (removed.has(entry.trim()) || removed.has(expanded) || seen.has(expanded)) continue;
    seen.add(expanded);
    list.push(expanded);
  }
  return list;
}

/** Splits a path into its segments, resolving `.` and `..` (an absolute path never climbs above `/`). */
function segmentsOf(path: string): { readonly absolute: boolean; readonly parts: string[] } {
  const text = path.replaceAll('\\', '/');
  const absolute = text.startsWith('/');
  const parts: string[] = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  return { absolute, parts };
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g;

/** Whether one path segment matches one entry segment (`*` and `?` only). */
function segmentMatches(pattern: string, segment: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === segment;
  const source = pattern.replace(GLOB_SPECIAL, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${source}$`, 'su').test(segment);
}

/**
 * Whether `path` is a secret: it is an entry of `list` or lies inside one. Case-sensitive. The path
 * is compared as it is written (after resolving `.` and `..`): the caller passes the real path,
 * because this function does not follow symlinks. A relative path matches only the bare names.
 */
export function isSecretPath(path: string, list: readonly string[]): boolean {
  const target = segmentsOf(path);
  if (target.parts.length === 0) return false;
  for (const entry of list) {
    if (!entry.includes('/')) {
      if (target.parts.some((part) => segmentMatches(entry, part))) return true;
      continue;
    }
    const pattern = segmentsOf(entry).parts;
    if (!target.absolute || target.parts.length < pattern.length) continue;
    if (pattern.every((part, index) => segmentMatches(part, target.parts[index] ?? '')))
      return true;
  }
  return false;
}
