// SPDX-License-Identifier: MPL-2.0
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { win32 } from 'node:path';
import {
  AdapterUnavailable,
  assertLaunchOptions,
  DEFAULT_KILL_GRACE_MS,
  InvalidInput,
  type Adapter,
  type KillOptions,
  type KillReport,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessExit,
  type ProcessLauncher,
} from '@otheater/core';
import {
  WINDOWS_PROCESS_LAUNCHER_ADAPTER,
  WindowsLauncherConfigSchema,
  type WindowsLauncherConfig,
  type WindowsLauncherConfigInput,
} from './config.js';
import { refusedScript, resolveProgram } from './resolve.js';
import { resolveNpmShim } from './shim.js';

/** [proposta] Longest wait for the launcher to end once it was terminated. */
const ROOT_REAP_WAIT_MS = 3000;

/** Exit codes of the launcher itself (`native/job-launcher/README.md`, "Exit codes"). */
const LAUNCHER_FAILURES: Readonly<Record<number, string>> = {
  0x4f540001: 'wrong command line',
  0x4f540002: 'the job could not be created or configured',
  0x4f540003: 'the program could not be started',
  0x4f540004: 'the process could not be assigned to the job',
  0x4f540005: 'the main thread could not be resumed',
  0x4f540006: 'waiting for the process failed',
  0x4f540007: 'the program is a .cmd or .bat script',
  0x4f540008: 'the parent process (--parent-pid) does not exist or is already gone',
  0x4f540009: 'the parent process ended, so the launcher ended the job',
};

/**
 * What an exit code says when it is one of the launcher's own (an Executor could return the same
 * number, but it is a very unlikely value), or `undefined` for any other code.
 */
export function launcherFailureOf(code: number | null): string | undefined {
  if (code === null) return undefined;
  return LAUNCHER_FAILURES[code >>> 0];
}

/**
 * The command line of the launcher
 * (`ot-job-launcher [--memory-limit-bytes <n>] [--parent-pid <pid>] -- <exe> [args...]`).
 * Everything after the first `--` belongs to the Executor and is never interpreted, so `args` go
 * as they are. `parentPid` (the daemon) ties the launcher to it: when that process ends, however
 * it ends, the launcher ends the job.
 */
export function launcherArguments(
  exe: string,
  args: readonly string[],
  options: { readonly memoryLimitBytes?: number; readonly parentPid?: number } = {},
): string[] {
  const limit =
    options.memoryLimitBytes === undefined
      ? []
      : ['--memory-limit-bytes', String(options.memoryLimitBytes)];
  const parent = options.parentPid === undefined ? [] : ['--parent-pid', String(options.parentPid)];
  return [...limit, ...parent, '--', exe, ...args];
}

/** What a test may replace; the defaults are the real system. */
export interface WindowsLauncherDeps {
  readonly spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** True when the launcher file exists (checked once, when the adapter is built). */
  readonly exists?: (path: string) => boolean;
  /** True when `path` is a file, for the search of the program (default: the file system). */
  readonly isFile?: (path: string) => boolean;
  /** Text of a `.cmd` shim, for `shims: resolve` (default: the file). */
  readonly readFile?: (path: string) => string;
  /** The pid the launcher is tied to (default: `process.pid`, the daemon). */
  readonly parentPid?: number;
  /** `process.platform`; the adapter refuses to be built anywhere but on Windows. */
  readonly platform?: NodeJS.Platform;
}

/**
 * `ProcessLauncher` for Windows (architecture 5.9, N58; Phase 10, P2): every Executor is started
 * by `ot-job-launcher.exe`, which puts it in a Job Object with `KILL_ON_JOB_CLOSE` before it runs.
 * The tree ends when the launcher does, so `killTree` terminates the launcher and Windows closes
 * the job around everything that is left, a grandchild included.
 *
 * - `capabilities()`: `treeKill: 'job-object'`, a memory limit (`--memory-limit-bytes`: the
 *   committed memory of the whole job) and a suspended start (the launcher creates the Executor
 *   suspended and resumes it inside the job).
 * - `pid` is the launcher's: the Executor is its child.
 * - The Executor sees exactly `env` (the launcher is started with it and the Executor inherits it
 *   from the launcher). The streams are WHATWG streams over the pipes of the launcher, which the
 *   Executor inherits.
 * - `exited` is the exit of the launcher, whose code is the Executor's ({@link launcherFailureOf}
 *   names the codes that are the launcher's own). The tree does not outlive the root here: when
 *   the Executor ends, the launcher ends and the job takes what is left.
 * - `killTree` has no polite step: the launcher does not forward a signal, and ACP's
 *   `session/cancel` plus the end of stdin are the caller's. `graceMs` is validated and not used;
 *   the report says `forced: true`, and `found: 1` (the launcher stands for the job, which does not
 *   list its members to the daemon).
 * - The launcher is started with `--parent-pid` of this process: if the daemon is killed at once,
 *   with no chance to run anything, the launcher sees its parent end and ends the job, so no tree
 *   is left behind. That is why this is not an `OrphanReaper`: there is nothing to find again.
 * - A `.cmd` shim of npm (`codex.cmd`) is read ({@link resolveNpmShim}) and `node.exe <script>`
 *   runs in its place when `shims` is `resolve`; the launcher itself still refuses any `.cmd`.
 */
export class WindowsProcessLauncher implements ProcessLauncher {
  readonly id: Adapter['id'] = WINDOWS_PROCESS_LAUNCHER_ADAPTER.id;
  readonly implements: Adapter['implements'] = WINDOWS_PROCESS_LAUNCHER_ADAPTER.implements;
  readonly config: WindowsLauncherConfig;
  readonly #spawn: NonNullable<WindowsLauncherDeps['spawn']>;
  readonly #isFile: WindowsLauncherDeps['isFile'];
  readonly #readFile: WindowsLauncherDeps['readFile'];
  readonly #parentPid: number;

  constructor(config: WindowsLauncherConfigInput, deps: WindowsLauncherDeps = {}) {
    const parsed = WindowsLauncherConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new InvalidInput(`Invalid Windows launcher config: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    this.config = parsed.data;
    if ((deps.platform ?? process.platform) !== 'win32') {
      throw new AdapterUnavailable('The Job Object launcher only works on Windows');
    }
    if (!win32.isAbsolute(this.config.launcherPath)) {
      throw new InvalidInput('launcherPath must be an absolute path');
    }
    if (!(deps.exists ?? existsSync)(this.config.launcherPath)) {
      throw new AdapterUnavailable(`The launcher is not at ${this.config.launcherPath}`);
    }
    this.#isFile = deps.isFile;
    this.#readFile = deps.readFile;
    this.#parentPid = deps.parentPid ?? process.pid;
    this.#spawn = deps.spawn ?? ((file, args, options) => nodeSpawn(file, [...args], options));
  }

  capabilities(): LauncherCapabilities {
    return { treeKill: 'job-object', memoryLimit: true, suspendedStart: true };
  }

  async launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    assertLaunchOptions(opts);
    // The program is found here, so a missing one is `AdapterUnavailable` before anything starts
    // and the launcher is never left to search (it also reads the current directory).
    const fileCheck = this.#isFile === undefined ? {} : { isFile: this.#isFile };
    const program = resolveProgram(opts.cmd, { cwd: opts.cwd, env: opts.env, ...fileCheck });
    let exe = program.path;
    let args: readonly string[] = opts.args;
    if (program.kind === 'script') {
      // Only the `.cmd` of npm is read; a `.bat` never is, and `refuse` reads nothing.
      if (this.config.shims === 'refuse' || !/\.cmd$/i.test(program.path)) {
        throw refusedScript(program.path);
      }
      const shim = resolveNpmShim(program.path, {
        env: opts.env,
        ...fileCheck,
        ...(this.#readFile === undefined ? {} : { readFile: this.#readFile }),
      });
      exe = shim.exe;
      args = [...shim.args, ...opts.args];
    }

    const child = this.#spawn(
      this.config.launcherPath,
      launcherArguments(exe, args, {
        ...(opts.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: opts.memoryLimitBytes }),
        parentPid: this.#parentPid,
      }),
      {
        cwd: opts.cwd,
        env: { ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      throw new AdapterUnavailable(
        `Cannot start ${JSON.stringify(opts.cmd)} in ${JSON.stringify(opts.cwd)}`,
        { cause: error },
      );
    }
    const pid = child.pid;
    if (pid === undefined) throw new AdapterUnavailable('The launcher started without a pid');
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) {
      child.kill();
      throw new AdapterUnavailable('The launcher started without its pipes');
    }

    // `exited` follows the `exit` event of the launcher, not the close of the pipes: a caller that
    // never reads them would hold the second forever.
    let rootExited = false;
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('exit', (code) => {
        rootExited = true;
        // The tree dies with the launcher; nothing here is a signal, as the port says for Windows.
        resolve({ code, signal: null });
      });
    });
    // A write to a pipe whose reader is gone raises EPIPE; the WHATWG stream reports it to the writer.
    stdin.on('error', () => undefined);

    let settled = false;
    let inFlight: Promise<KillReport> | undefined;
    const runKill = async (): Promise<KillReport> => {
      // The launcher ends when its Executor does, and the job goes with it: nothing is left to end.
      if (settled || rootExited) {
        settled = true;
        return { found: 0, forced: false, remaining: [] };
      }
      child.kill();
      const reaped = await waitFor(exited, ROOT_REAP_WAIT_MS);
      settled = reaped;
      return { found: 1, forced: true, remaining: reaped ? [] : [pid] };
    };

    return {
      pid,
      stdin: Writable.toWeb(stdin),
      stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
      exited,
      killTree: (killOpts: KillOptions = {}): Promise<KillReport> => {
        const graceMs = killOpts.graceMs ?? DEFAULT_KILL_GRACE_MS;
        if (!Number.isFinite(graceMs) || graceMs < 0) {
          return Promise.reject(new InvalidInput('graceMs must be a finite number >= 0'));
        }
        // Concurrent calls share one kill; a later call runs again and sees the real state.
        inFlight ??= runKill().finally(() => {
          inFlight = undefined;
        });
        return inFlight;
      },
    };
  }
}

/** True when `promise` settled within `ms`. */
async function waitFor(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => true), limit]);
  } finally {
    clearTimeout(timer);
  }
}
