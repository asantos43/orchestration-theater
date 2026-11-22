// SPDX-License-Identifier: MPL-2.0
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { AdapterUnavailable } from '@otheater/core';

/** Extensions the launcher refuses: they run through `cmd.exe`, which re-parses the arguments. */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.cmd', '.bat']);
/** What a bare name may become, in this order (a subset of `PATHEXT` that `CreateProcessW` runs). */
const PROGRAM_EXTENSIONS = ['.exe', '.com'] as const;

/** What {@link resolveExecutable} reads; a test replaces it. */
export interface ResolveOptions {
  /** Absolute working directory of the child: a relative path with a folder part is read from it. */
  readonly cwd: string;
  /** The environment of the child. Its `PATH` (any case) is searched; the daemon's is the fallback. */
  readonly env: Readonly<Record<string, string>>;
  /** The environment to fall back on when `env` has no `PATH` (default: `process.env`). */
  readonly fallbackEnv?: Readonly<Record<string, string | undefined>>;
  /** True when `path` is a file. Default: the file system. */
  readonly isFile?: (path: string) => boolean;
}

/** The value of `PATH` in `env`, whatever the case of the name (Windows environments ignore it). */
function pathOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path') return value;
  }
  return undefined;
}

const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** What a command is: a program the launcher can start, or a `.cmd`/`.bat` script it refuses. */
export type ResolvedProgram =
  | { readonly kind: 'exe'; readonly path: string }
  | { readonly kind: 'script'; readonly path: string };

/**
 * Finds the real program behind `cmd`, as an absolute path (Phase 10, P2). The launcher gets only
 * absolute paths, so no `CreateProcessW` search (which also reads the current directory) is ever
 * left to chance. Throws `AdapterUnavailable` when nothing is found (the folders searched are
 * named) and for `.cmd` and `.bat` (the launcher refuses them: argument injection through
 * `cmd.exe`). The text asks for the real executable, for example `node.exe` plus the script as an
 * argument. Paths follow Windows rules whatever the platform, so this is testable anywhere.
 */
export function resolveExecutable(cmd: string, options: ResolveOptions): string {
  const program = resolveProgram(cmd, options);
  if (program.kind === 'script') throw refusedScript(program.path);
  return program.path;
}

/**
 * Like {@link resolveExecutable}, but a `.cmd` or `.bat` (named, or the only thing a bare name
 * resolves to) is answered as `{ kind: 'script' }` with its path, for the caller to refuse or to
 * read as a shim of a package manager. A named script that is not there is answered with the name
 * as given.
 */
export function resolveProgram(cmd: string, options: ResolveOptions): ResolvedProgram {
  const isFile = options.isFile ?? fileExists;
  const extension = win32.extname(cmd).toLowerCase();
  const named = SCRIPT_EXTENSIONS.has(extension);

  const hasFolder = /[\\/]/.test(cmd) || /^[A-Za-z]:/.test(cmd);
  const folders = hasFolder
    ? [undefined]
    : (pathOf(options.env) ?? pathOf(options.fallbackEnv ?? process.env) ?? '')
        .split(';')
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter((entry) => entry !== '');
  const names = extension === '' ? PROGRAM_EXTENSIONS.map((ext) => `${cmd}${ext}`) : [cmd];

  for (const folder of folders) {
    for (const name of names) {
      const candidate =
        folder === undefined ? win32.resolve(options.cwd, name) : win32.join(folder, name);
      if (win32.isAbsolute(candidate) && isFile(candidate)) {
        return { kind: named ? 'script' : 'exe', path: win32.normalize(candidate) };
      }
    }
  }
  if (named) return { kind: 'script', path: cmd };
  // A shim of the package managers (`codex.cmd`) is the usual reason a name does not resolve.
  if (extension === '') {
    for (const folder of folders) {
      for (const ext of SCRIPT_EXTENSIONS) {
        const candidate =
          folder === undefined
            ? win32.resolve(options.cwd, cmd + ext)
            : win32.join(folder, cmd + ext);
        if (win32.isAbsolute(candidate) && isFile(candidate)) {
          return { kind: 'script', path: win32.normalize(candidate) };
        }
      }
    }
  }
  const where = hasFolder ? 'at that path' : `in PATH (${String(folders.length)} folders)`;
  throw new AdapterUnavailable(`Cannot find the executable ${JSON.stringify(cmd)} ${where}`);
}

/** The error for a `.cmd` or `.bat` that is not going to be run. */
export function refusedScript(cmd: string): AdapterUnavailable {
  return new AdapterUnavailable(
    `${JSON.stringify(cmd)} is a .cmd or .bat script, which the Job Object launcher refuses ` +
      '(it runs through cmd.exe and re-parses the arguments). Use the real executable, for ' +
      'example node.exe with the script as the first argument.',
  );
}
