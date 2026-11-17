// SPDX-License-Identifier: MPL-2.0
import { ShellToolRefusal } from './refusal.js';

/**
 * Path confinement of the shell tools (architecture 5.8, "caminhos confinados ao worktree").
 * `core` imports no Node built-in, so the file system comes in through {@link PathHost}: the
 * daemon hands it `fs.realpath` and `fs.lstat`, a test hands it a map. The rules are here.
 */

/** The two questions the confinement asks of the file system. */
export interface PathHost {
  /** Path separator of the host: `/` on posix, `\` on Windows. */
  readonly sep: '/' | '\\';
  /** Names compare without regard to case (Windows, default macOS). */
  readonly caseInsensitive?: boolean;
  /**
   * `fs.realpath`: the canonical path, symlinks resolved. A missing path rejects with an error
   * whose `code` is `ENOENT` or `ENOTDIR`; any other error is a refusal (`ELOOP`, `EACCES`).
   */
  realpath(path: string): Promise<string>;
  /** `fs.lstat(path).isSymbolicLink()`; `false` when the path does not exist. */
  isSymlink(path: string): Promise<boolean>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Splits a path into its prefix (`/`, `C:\`, `\\`) and its non-empty segments. */
function splitPath(
  host: PathHost,
  path: string,
): { readonly prefix: string; readonly segments: string[] } {
  const separators = host.sep === '\\' ? /[\\/]+/ : /\/+/;
  let prefix = '';
  let rest = path;
  const drive = host.sep === '\\' ? /^[A-Za-z]:[\\/]?/.exec(path) : null;
  if (drive !== null) {
    prefix = `${drive[0].slice(0, 2)}${host.sep}`;
    rest = path.slice(drive[0].length);
  } else if (host.sep === '\\' && path.startsWith('\\\\')) {
    prefix = '\\\\';
    rest = path.slice(2);
  } else if (path.startsWith('/') || (host.sep === '\\' && path.startsWith('\\'))) {
    prefix = host.sep;
    rest = path.slice(1);
  }
  return { prefix, segments: rest.split(separators).filter((s) => s !== '') };
}

function join(host: PathHost, prefix: string, segments: readonly string[]): string {
  const body = segments.join(host.sep);
  if (prefix === '') return body === '' ? '.' : body;
  return `${prefix}${body}`;
}

function isAbsolute(host: PathHost, path: string): boolean {
  return splitPath(host, path).prefix !== '';
}

function fold(host: PathHost, value: string): string {
  return host.caseInsensitive === true ? value.toLowerCase() : value;
}

function startsWithSegments(
  host: PathHost,
  segments: readonly string[],
  base: readonly string[],
): boolean {
  return (
    base.length <= segments.length &&
    base.every((segment, i) => fold(host, segment) === fold(host, segments[i] ?? ''))
  );
}

/**
 * Resolves `target` against `root` and returns the canonical path inside the worktree. Throws
 * {@link ShellToolRefusal} when the path leaves it: with `path_escapes` for an absolute path
 * elsewhere or a `..` that climbs out, with `symlink_escapes` for a symlink (of a file, of a
 * folder, or a chain of them) that points out, and with `invalid_path` for a dangling symlink,
 * a loop, or an error the file system gave.
 *
 * The walk goes one segment at a time and resolves each against the real file system, as the
 * kernel does, so `link/..` is the parent of what the link points to, not of the link. Any
 * step outside `root` is refused, even if a later `..` would come back. The part of the path
 * that does not exist yet (a file about to be created) is appended as it is.
 *
 * It is a check, not a lock: between this call and the use of the path a symlink can change.
 * The sandbox (layer 3, P4) is what holds against that.
 */
export async function confinePath(host: PathHost, root: string, target: string): Promise<string> {
  if (target.includes('\0')) {
    throw new ShellToolRefusal('invalid_path', 'a path must not contain NUL');
  }
  if (!isAbsolute(host, root)) {
    throw new ShellToolRefusal('invalid_path', `the worktree root must be absolute: ${root}`);
  }
  let realRoot: string;
  try {
    realRoot = await host.realpath(root);
  } catch (error) {
    throw new ShellToolRefusal('invalid_path', `the worktree root does not resolve: ${root}`, {
      cause: error,
    });
  }
  const rootParts = splitPath(host, realRoot);

  let segments: string[];
  const wanted = splitPath(host, target);
  if (wanted.prefix === '') {
    segments = wanted.segments;
  } else {
    // An absolute path is accepted only when it starts at the worktree (by its given or its real name).
    const given = splitPath(host, root);
    let skip: number;
    if (
      fold(host, wanted.prefix) === fold(host, given.prefix) &&
      startsWithSegments(host, wanted.segments, given.segments)
    ) {
      skip = given.segments.length;
    } else if (
      fold(host, wanted.prefix) === fold(host, rootParts.prefix) &&
      startsWithSegments(host, wanted.segments, rootParts.segments)
    ) {
      skip = rootParts.segments.length;
    } else {
      throw new ShellToolRefusal(
        'path_escapes',
        `the path is outside the worktree: ${JSON.stringify(target)}`,
      );
    }
    segments = wanted.segments.slice(skip);
  }

  let current = [...rootParts.segments];
  let missing = false;
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (current.length <= rootParts.segments.length) {
        throw new ShellToolRefusal(
          'path_escapes',
          `the path climbs out of the worktree with "..": ${JSON.stringify(target)}`,
        );
      }
      current = current.slice(0, -1);
      continue;
    }
    const next = [...current, segment];
    if (missing) {
      current = next;
      continue;
    }
    const nextPath = join(host, rootParts.prefix, next);
    let resolved: string;
    try {
      resolved = await host.realpath(nextPath);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (await host.isSymlink(nextPath)) {
          throw new ShellToolRefusal(
            'invalid_path',
            `the symlink ${JSON.stringify(segment)} does not resolve to anything`,
            { cause: error },
          );
        }
        missing = true;
        current = next;
        continue;
      }
      throw new ShellToolRefusal(
        'invalid_path',
        `the path does not resolve (${code ?? 'error'}): ${JSON.stringify(target)}`,
        { cause: error },
      );
    }
    const real = splitPath(host, resolved);
    if (
      fold(host, real.prefix) !== fold(host, rootParts.prefix) ||
      !startsWithSegments(host, real.segments, rootParts.segments)
    ) {
      throw new ShellToolRefusal(
        'symlink_escapes',
        `${JSON.stringify(segment)} leads out of the worktree through a symlink`,
      );
    }
    current = real.segments;
  }
  return join(host, rootParts.prefix, current);
}

/** True when an argument looks like a path that could leave the folder it is read from. */
function looksLikePath(host: PathHost, value: string): boolean {
  return (
    value.includes('/') ||
    (host.sep === '\\' && value.includes('\\')) ||
    value === '..' ||
    value.startsWith('~')
  );
}

/**
 * Confines the arguments of an argv to the worktree (`argv[0]` is the program and is not read).
 * Every argument that is not an option is taken as a possible path and resolved, so `cat link` is
 * refused when `link` points out; for `--opt=value` the value is checked when it looks like a
 * path. A `~` at the start is refused (it would be the home folder). Arguments after `--` are
 * checked too. Throws {@link ShellToolRefusal}.
 */
export async function confineArgv(
  host: PathHost,
  root: string,
  argv: readonly string[],
): Promise<void> {
  for (const arg of argv.slice(1)) {
    if (arg === '' || arg === '--') continue;
    let candidate = arg;
    if (arg.startsWith('-')) {
      const equals = arg.indexOf('=');
      if (equals < 0) continue;
      candidate = arg.slice(equals + 1);
      if (!looksLikePath(host, candidate)) continue;
    }
    if (candidate.startsWith('~')) {
      throw new ShellToolRefusal(
        'path_escapes',
        `the home folder is outside the worktree: ${JSON.stringify(arg)}`,
      );
    }
    await confinePath(host, root, candidate);
  }
}
