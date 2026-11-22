// SPDX-License-Identifier: MPL-2.0
import { readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { AdapterUnavailable } from '@otheater/core';

/** A shim is a few lines; anything bigger is not one. */
const MAX_SHIM_BYTES = 64 * 1024;

/** What {@link resolveNpmShim} reads; a test replaces it. */
export interface ShimOptions {
  /** The environment of the child: its `PATH` (any case) is where `node.exe` is looked for after the shim's folder. */
  readonly env: Readonly<Record<string, string>>;
  /** The environment to fall back on when `env` has no `PATH` (default: `process.env`). */
  readonly fallbackEnv?: Readonly<Record<string, string | undefined>>;
  /** Text of the shim (default: the file, as UTF-8). Throws when it cannot be read. */
  readonly readFile?: (path: string) => string;
  /** True when `path` is a file (default: the file system). */
  readonly isFile?: (path: string) => boolean;
}

/** What the launcher runs in place of the shim. */
export interface ResolvedShim {
  /** Absolute path of `node.exe`. */
  readonly exe: string;
  /** The script (absolute path); the caller's own arguments come after it. */
  readonly args: readonly string[];
}

const dp0 = String.raw`%(?:~dp0|dp0%)`;
/**
 * The line of a Node shim of npm (`cmd-shim`, npm 6 to 11) that runs the script. Both generations:
 * - npm 7 and later: `... & "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*`, with `_prog` set
 *   to `node` or to `%dp0%\node.exe` above (checked separately);
 * - npm 6 and earlier: `"%~dp0\node.exe" "%~dp0\node_modules\pkg\bin\cli.js" %*` and
 *   `node "%~dp0\node_modules\pkg\bin\cli.js" %*`.
 * Group 1 is the interpreter (`"%_prog%"` or a node name), group 2 the script relative to the
 * folder of the shim, group 3 whatever sits between the script and `%*` (arguments baked in).
 */
const RUN_LINE = new RegExp(
  String.raw`(?:^|[\s&|(])("%_prog%"|"${dp0}\\?node\.exe"|node(?:\.exe)?)\s+"${dp0}\\?([^"\r\n]+)"([^\r\n]*?)%\*`,
  'i',
);
/** `SET "_prog=node"` (npm 7 and later), for the `"%_prog%"` form. */
const PROG_IS_NODE = /^\s*@?SET\s+"?_prog=node"?\s*$/im;

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

const readText = (path: string): string => {
  if (statSync(path).size > MAX_SHIM_BYTES) throw new Error('the file is too big for a shim');
  return readFileSync(path, 'utf8');
};

/**
 * Reads a `.cmd` shim in the standard format of the `cmd-shim` of npm and returns what it runs:
 * `node.exe <script>` (Phase 10, P2). The shim exists because npm puts a `.cmd` in the PATH for
 * every Node tool (`codex`, `claude-agent-acp`), and the launcher refuses `.cmd` (it runs through
 * `cmd.exe`, which re-parses arguments); the shim only says which script `node` runs, so the
 * launcher can run the same thing directly.
 *
 * - The script is the one the shim names, relative to its folder (`%dp0%`, `%~dp0`).
 * - `node.exe` is the one in the folder of the shim, else the first in `PATH`. Never
 *   `process.execPath`: in a single-executable build that is OTheater itself.
 * - A shim that is not of this format (another interpreter, arguments baked in, no script, no
 *   `node.exe`) is refused with `AdapterUnavailable` naming the path and the reason.
 *
 * Paths follow Windows rules whatever the platform, so this is testable anywhere.
 */
export function resolveNpmShim(shimPath: string, options: ShimOptions): ResolvedShim {
  const isFile = options.isFile ?? fileExists;
  const refuse = (reason: string): AdapterUnavailable =>
    new AdapterUnavailable(
      `${JSON.stringify(shimPath)} is a .cmd script that is not an npm shim OTheater can run: ${reason}. ` +
        'The Job Object launcher refuses .cmd; use the real executable, for example node.exe ' +
        'with the script as the first argument.',
    );

  let text: string;
  try {
    text = (options.readFile ?? readText)(shimPath);
  } catch (error) {
    throw new AdapterUnavailable(`Cannot read the shim ${JSON.stringify(shimPath)}`, {
      cause: error,
    });
  }
  if (text.length > MAX_SHIM_BYTES) throw refuse('the file is too big for a shim');

  const found = RUN_LINE.exec(text);
  if (found === null) throw refuse('no line that runs a script with node was found');
  const [, interpreter, relative, baked] = found;
  if (interpreter === undefined || relative === undefined) throw refuse('the format is unknown');
  if (interpreter.toLowerCase() === '"%_prog%"' && !PROG_IS_NODE.test(text)) {
    throw refuse('the interpreter is not node');
  }
  if ((baked ?? '').trim() !== '') throw refuse('it has arguments of its own before %*');
  if (relative.includes('%')) throw refuse('the script path has a variable in it');

  const folder = win32.dirname(shimPath);
  const script = win32.resolve(folder, relative);
  if (!isFile(script)) throw refuse(`the script ${JSON.stringify(script)} is not there`);

  const beside = win32.join(folder, 'node.exe');
  if (isFile(beside)) return { exe: beside, args: [script] };
  const searched = (pathOf(options.env) ?? pathOf(options.fallbackEnv ?? process.env) ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '');
  for (const entry of searched) {
    const candidate = win32.join(entry, 'node.exe');
    if (win32.isAbsolute(candidate) && isFile(candidate)) {
      return { exe: win32.normalize(candidate), args: [script] };
    }
  }
  throw refuse('there is no node.exe beside it nor in PATH');
}
