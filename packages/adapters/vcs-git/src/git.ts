// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { stat } from 'node:fs/promises';
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  NotFound,
  PermissionDenied,
  Transient,
} from '@otheater/core';

/** Identity written on the commits (`user.name` and `user.email`). */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Default identity of the commits [proposta]. */
export const DEFAULT_GIT_IDENTITY: GitIdentity = {
  name: 'OTheater',
  email: 'otheater@localhost',
};

/** Default ceiling for one `git` command [proposta]. */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Largest stdout accepted from one command (a listing of a huge tree stays well below). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Variables of the parent environment that `git` needs to run; everything else is dropped. */
const INHERITED_ENV = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TMPDIR', 'TEMP', 'TMP'];

export interface GitRunnerOptions {
  /** Executable. Default `git` (looked up in `PATH`). */
  readonly binary?: string;
  /** Ceiling for one command, in ms. Default {@link DEFAULT_GIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly identity?: GitIdentity;
}

export interface GitRunOptions {
  /** Extra environment variables for this one command. */
  readonly env?: Readonly<Record<string, string>>;
  /** Do not throw on a non-zero exit; return the result instead. */
  readonly allowFailure?: boolean;
  /** Written to the standard input of the command, which is then closed. */
  readonly input?: string;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * The environment of every command (architecture 5.5): the user's configuration never changes
 * the behavior of the adapter and is never written. Only a short allow-list of variables is
 * inherited, so a `GIT_DIR`, `GIT_INDEX_FILE` or `GIT_CONFIG_*` of the parent cannot leak in.
 * `HOME` and `XDG_CONFIG_HOME` point at the null device: no global config, no global ignore file.
 */
export function isolatedGitEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: 'echo',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    HOME: devNull,
    XDG_CONFIG_HOME: devNull,
    LC_ALL: 'C',
    LANG: 'C',
  };
}

/** The `-c` options of every command: no user hooks, no signing, a fixed identity. */
export function isolatedGitConfig(identity: GitIdentity): string[] {
  return [
    '-c',
    `core.hooksPath=${devNull}`,
    '-c',
    'commit.gpgsign=false',
    '-c',
    'tag.gpgsign=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
  ];
}

interface ExecError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Runs `git` with an argument array (never a shell, never string interpolation), in the isolated
 * environment, with a time ceiling. A failure becomes a typed error of `@otheater/core`.
 */
export class GitRunner {
  readonly binary: string;
  readonly timeoutMs: number;
  readonly identity: GitIdentity;

  constructor(options: GitRunnerOptions = {}) {
    this.binary = options.binary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.identity = options.identity ?? DEFAULT_GIT_IDENTITY;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new InvalidInput(`timeoutMs must be a positive integer, got ${String(this.timeoutMs)}`);
    }
    if (this.identity.name.trim() === '' || this.identity.email.trim() === '') {
      throw new InvalidInput('The commit identity needs a name and an email');
    }
  }

  /** Runs `git <args>` in `cwd` (an existing directory) and returns stdout. */
  async run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
    const result = await this.exec(cwd, args, options);
    return result.stdout;
  }

  /** Like {@link run}, but returns the exit code and stderr and never throws on exit != 0. */
  async try(
    cwd: string,
    args: readonly string[],
    options: Omit<GitRunOptions, 'allowFailure'> = {},
  ): Promise<GitResult> {
    return this.exec(cwd, args, { ...options, allowFailure: true });
  }

  private async exec(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions,
  ): Promise<GitResult> {
    await assertDirectory(cwd);
    const fullArgs = [...isolatedGitConfig(this.identity), ...args];
    const env = { ...isolatedGitEnv(), ...options.env };
    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        this.binary,
        fullArgs,
        {
          cwd,
          env,
          timeout: this.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr, code: 0 });
            return;
          }
          const failure = error as ExecError;
          if (options.allowFailure === true && typeof failure.code === 'number') {
            resolve({ stdout, stderr, code: failure.code });
            return;
          }
          reject(classifyGitFailure(args, failure, stderr, this.timeoutMs));
        },
      );
      // `git` may exit before reading its input (EPIPE): the exit code already tells the story.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    });
  }
}

async function assertDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new NotFound(`Directory not found: ${path}`, { cause: error });
  }
  if (!info.isDirectory()) throw new NotFound(`Not a directory: ${path}`);
}

function describeCommand(args: readonly string[]): string {
  return `git ${args.slice(0, 3).join(' ')}`.trim();
}

/** Maps a failed `git` run to the typed error of the port's contract. */
export function classifyGitFailure(
  args: readonly string[],
  failure: ExecError,
  stderr: string,
  timeoutMs: number,
): Error {
  const command = describeCommand(args);
  const text = stderr.trim();
  const detail = text === '' ? failure.message : text;

  if (failure.code === 'ENOENT') {
    return new AdapterUnavailable(`The git executable could not be started (${command})`, {
      cause: failure,
    });
  }
  if (failure.code === 'EACCES') {
    return new AdapterUnavailable(`The git executable is not executable (${command})`, {
      cause: failure,
    });
  }
  if (failure.killed === true || failure.signal === 'SIGKILL' || failure.signal === 'SIGTERM') {
    return new Transient(`${command} did not finish within ${String(timeoutMs)} ms`, {
      cause: failure,
    });
  }
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new Transient(`${command} produced more output than the adapter accepts`, {
      cause: failure,
    });
  }
  const message = `${command} failed: ${detail}`;
  if (/dubious ownership/i.test(text)) return new PermissionDenied(message, { cause: failure });
  if (/not a git repository|must be run in a work tree/i.test(text)) {
    return new NotFound(message, { cause: failure });
  }
  if (
    /unknown revision|not a valid object name|invalid reference|bad revision|needed a single revision|ambiguous argument|not a working tree|no such (file|worktree)/i.test(
      text,
    )
  ) {
    return new NotFound(message, { cause: failure });
  }
  if (
    /already exists|cannot lock ref|unable to create .*\.lock|file exists|contains modified or untracked|is locked|is already (checked out|used by worktree)|used by worktree|already checked out|could not lock|index\.lock/i.test(
      text,
    )
  ) {
    return new Conflict(message, { cause: failure });
  }
  if (/not a valid branch name|invalid branch name|is not a valid ref/i.test(text)) {
    return new InvalidInput(message, { cause: failure });
  }
  return new AdapterUnavailable(message, { cause: failure });
}
