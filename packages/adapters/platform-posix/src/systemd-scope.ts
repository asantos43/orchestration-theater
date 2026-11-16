// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const SYSTEMD_RUN_CANDIDATES = ['/usr/bin/systemd-run', '/bin/systemd-run'];
const ENV_CANDIDATES = ['/usr/bin/env', '/bin/env'];

/** Absolute path of `systemd-run`, or `undefined` when it is not installed. */
export function findSystemdRun(): string | undefined {
  return SYSTEMD_RUN_CANDIDATES.find((candidate) => existsSync(candidate));
}

/** Where the systemd user manager listens (`$XDG_RUNTIME_DIR` of the user), without reading the env. */
function runtimeDir(): string | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : `/run/user/${String(uid)}`;
}

/** Default search path when the requested environment has no `PATH` (what libc's `execvp` uses). */
const DEFAULT_PATH = '/usr/bin:/bin';

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the file `cmd` names, as `execvp` would with the PATH of the requested environment.
 * Behind `systemd-run` a missing executable is only a late exit 127, so the launcher looks first
 * and keeps the port's promise of `AdapterUnavailable` at launch.
 */
export function resolveExecutable(
  cmd: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): string | undefined {
  if (cmd.includes('/')) {
    const path = isAbsolute(cmd) ? cmd : join(cwd, cmd);
    return isExecutableFile(path) ? path : undefined;
  }
  for (const dir of (env.PATH ?? DEFAULT_PATH).split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, cmd);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `systemd-run` expands `$VAR`, `${VAR}` and a lone `$` in the words of the command, like an
 * `ExecStart=` line (measured, systemd 262). `$$` is a literal `$`, so doubling every `$` hands
 * the argument to the child unchanged.
 */
function escapeDollar(word: string): string {
  return word.replaceAll('$', '$$$$');
}

/** The executable of a scoped launch was not found; the launcher turns it into `AdapterUnavailable`. */
export class MissingExecutable extends Error {
  constructor(cmd: string) {
    super(`Executable not found: ${JSON.stringify(cmd)}`);
    this.name = 'MissingExecutable';
  }
}

/** The pieces of a `systemd-run` call that wraps a command in a memory-limited scope. */
export interface ScopeCommand {
  readonly file: string;
  readonly args: string[];
  /** The environment `systemd-run` itself needs: the requested one plus the bus location. */
  readonly env: Record<string, string>;
}

/**
 * Wraps `cmd args` as `systemd-run --user --scope -p MemoryMax=N -p MemorySwapMax=0 -- env -u ...
 * cmd args` (architecture 5.9, memory limit; measured on this machine in Fase 2, passo 2).
 *
 * `systemd-run` cannot reach the user manager without `XDG_RUNTIME_DIR` and puts `INVOCATION_ID`
 * in the scope; the `env -u` in front of the command removes both again unless the caller asked
 * for them, so the child still sees exactly the requested environment. `MemorySwapMax=0` makes
 * the ceiling a real one: without it the kernel pushes the excess to swap instead of killing.
 */
export function scopeCommand(
  cmd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  memoryLimitBytes: number,
  cwd: string,
): ScopeCommand {
  const systemdRun = findSystemdRun();
  const envTool = ENV_CANDIDATES.find((candidate) => existsSync(candidate));
  const dir = runtimeDir();
  if (systemdRun === undefined || envTool === undefined || dir === undefined) {
    throw new Error('systemd-run, env or the user runtime directory is not available');
  }
  const executable = resolveExecutable(cmd, env, cwd);
  if (executable === undefined) throw new MissingExecutable(cmd);
  const injected: Record<string, string> = {};
  const unset: string[] = [];
  if (!('XDG_RUNTIME_DIR' in env)) {
    injected.XDG_RUNTIME_DIR = dir;
    unset.push('-u', 'XDG_RUNTIME_DIR');
  }
  if (!('INVOCATION_ID' in env)) unset.push('-u', 'INVOCATION_ID');
  return {
    file: systemdRun,
    args: [
      '--user',
      '--scope',
      '--quiet',
      '-p',
      `MemoryMax=${String(memoryLimitBytes)}`,
      '-p',
      'MemorySwapMax=0',
      '--',
      envTool,
      ...unset,
      ...[executable, ...args].map(escapeDollar),
    ],
    env: { ...env, ...injected },
  };
}

/**
 * True when this machine can run a memory-limited scope as the current user: Linux, `systemd-run`
 * installed, a user manager that answers, and the `memory` controller delegated to it. Runs a
 * `true` in a 1 GiB scope; resolves false on any failure or after `timeoutMs`.
 */
export function probeSystemdScope(timeoutMs = 10_000): Promise<boolean> {
  if (process.platform !== 'linux') return Promise.resolve(false);
  let command: ScopeCommand;
  try {
    command = scopeCommand('true', [], {}, 1024 ** 3, '/');
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(
      command.file,
      command.args,
      { env: command.env, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error) => {
        resolve(error === null);
      },
    );
  });
}
