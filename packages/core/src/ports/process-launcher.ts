// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import type { Adapter } from './adapter.js';

/** Semver of the `ProcessLauncher` port contract (architecture 5.18, "Versão dos contratos"). */
export const PROCESS_LAUNCHER_PORT_VERSION = '0.1.0';

/** Default wait between SIGTERM (or its equivalent) and the forced kill in `killTree`. [proposta] */
export const DEFAULT_KILL_GRACE_MS = 5000;

/** How the launcher ends a whole process tree (architecture 5.9). */
export type TreeKillMode =
  /** Windows Job Object with `KILL_ON_JOB_CLOSE`: nothing escapes, not even a grandchild. */
  | 'job-object'
  /** Posix process group (`setsid`): reaches every descendant that did not leave the group. */
  | 'process-group'
  /** Walks the descendants of the pid (`execa`-style fallback): a race window exists. */
  | 'descendants';

/** What this launcher can do on this machine; the core asks instead of checking the platform. */
export interface LauncherCapabilities {
  readonly treeKill: TreeKillMode;
  /** `memoryLimitBytes` is enforced (Job Object limit, cgroup...). */
  readonly memoryLimit: boolean;
  /** The process is created suspended and joins the job/group before it runs (no escape window). */
  readonly suspendedStart: boolean;
}

/** What to start (architecture 5.9). The launcher never reads `process.env` on its own. */
export interface LaunchOptions {
  /** Executable name or path. No shell is involved: `args` go to the process as they are. */
  readonly cmd: string;
  readonly args: readonly string[];
  /** Absolute working directory. */
  readonly cwd: string;
  /**
   * The COMPLETE environment of the process. Whatever is not here does not exist for the child;
   * the caller (the `ClientAdapter`) builds it from the profile and the vault, so a stray
   * `ANTHROPIC_API_KEY` of the daemon never reaches an Executor (architecture 5.6).
   */
  readonly env: Readonly<Record<string, string>>;
  /** Memory ceiling of the whole tree. Only when `capabilities().memoryLimit`; see {@link ProcessLauncher.launch}. */
  readonly memoryLimitBytes?: number;
}

/** How a process ended: exit `code`, or the `signal` that killed it (the other is `null`). */
export interface ProcessExit {
  readonly code: number | null;
  /** Signal name (`SIGTERM`, `SIGKILL`...) on posix; always `null` on Windows. */
  readonly signal: string | null;
}

/**
 * How the client answered a `session/cancel`: `honored` when the turn ended within the grace
 * period, `ignored` when it did not.
 */
export type CancelOutcome = 'honored' | 'ignored';

export interface KillOptions {
  /** Time to wait after the polite signal before SIGKILL. Default {@link DEFAULT_KILL_GRACE_MS}. */
  readonly graceMs?: number;
  /**
   * Set by a session that ends because of a `session/cancel` (and by nothing else: `close` leaves
   * it out). A real launcher ignores it and kills the whole tree, as before. It matters to a
   * LEASE of a process shared by several sessions (`SharedProcessRegistry`, the daemon's session
   * pool): there `killTree` only gives the lease back, unless the sharing policy
   * (`shared_cancel`, see `endsSharedProcess`) says that this outcome ends the process of every
   * session on it. [proposta] Additive field: a one-field alternative to a new method on
   * `LaunchedProcess`, so no launcher and no fake has to change.
   */
  readonly cancel?: CancelOutcome;
}

/** What `killTree` found and did. */
export interface KillReport {
  /** Pids of the tree seen when the kill started (the root included). */
  readonly found: number;
  /** The polite signal did not end the tree within `graceMs` and the forced kill was used. */
  readonly forced: boolean;
  /** Pids still alive when `killTree` returned. Non-empty means the cancel did not clean up. */
  readonly remaining: readonly number[];
}

/**
 * A running process under the launcher (architecture 5.9). Streams are WHATWG streams, the same
 * kind `@agentclientprotocol/sdk` takes in `ndJsonStream`.
 * [proposta] Not `node:stream`: the dependency rule keeps Node built-ins out of core, even as types.
 */
export interface LaunchedProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves once, when the ROOT process ends (never rejects). Descendants may outlive it. */
  readonly exited: Promise<ProcessExit>;
  /**
   * Ends the whole tree: polite signal to the group/tree, wait up to `graceMs`, then SIGKILL (or the
   * Job Object kill). Idempotent; resolves with the report even if the root had already exited.
   */
  killTree(opts?: KillOptions): Promise<KillReport>;
}

/**
 * Creates, limits and kills process trees (architecture 5.9, 5.18). Every Executor process is born
 * here, so cancelling a session can end the client together with whatever it started (5.2, "Casca
 * de agente").
 *
 * Contract (the conformance suite is written by each adapter step):
 * - `launch` rejects with `InvalidInput` for options that fail {@link assertLaunchOptions}, and for
 *   `memoryLimitBytes` when `capabilities().memoryLimit` is false (the limit is never ignored in silence).
 * - `launch` rejects with `AdapterUnavailable` when the process cannot be started (missing
 *   executable, bad `cwd`, no permission).
 * - The child sees exactly `env`; nothing is inherited.
 * - `killTree` never rejects because the process was already gone.
 */
export interface ProcessLauncher extends Adapter {
  capabilities(): LauncherCapabilities;
  launch(opts: LaunchOptions): Promise<LaunchedProcess>;
}

/** A process of a previous daemon: its pid and the instant it started (epoch ms, as the OS says). */
export interface OrphanTarget {
  readonly pid: number;
  readonly startedAt: number;
}

/** What {@link OrphanReaper.killOrphan} found. */
export interface OrphanKillReport {
  /**
   * The pid was alive and started at the recorded instant, so the tree was ended. `false` when the
   * process is gone, or the pid now belongs to another process (it is never signalled then).
   */
  readonly matched: boolean;
  readonly report: KillReport;
}

/**
 * Optional capability of a `ProcessLauncher` (architecture 5.21, step 2 of the reconciliation): end
 * the client processes a dead daemon left behind. A process is identified by pid AND start instant,
 * so a recycled pid is never killed. Check with {@link supportsOrphanKill}. [proposta] An optional
 * capability, like `VcsHistory`, so the port version does not change.
 */
export interface OrphanReaper {
  /** When the process `pid` started (epoch ms), or `undefined` if there is no such live process. */
  processStartedAt(pid: number): Promise<number | undefined>;
  /** Ends the tree of `target` if, and only if, the process is the one that was recorded. */
  killOrphan(target: OrphanTarget, opts?: KillOptions): Promise<OrphanKillReport>;
}

/** Narrows a `ProcessLauncher` to one that can find and end orphans. */
export function supportsOrphanKill(
  launcher: ProcessLauncher,
): launcher is ProcessLauncher & OrphanReaper {
  const candidate = launcher as Partial<OrphanReaper>;
  return (
    typeof candidate.processStartedAt === 'function' && typeof candidate.killOrphan === 'function'
  );
}

/**
 * The name of the environment variable that carries a launch marker (Phase 11, P3): the id of the
 * `sessions` row the daemon wrote BEFORE it started the process. The child and its descendants
 * inherit it, so a daemon that died between the start of the process and the write of its pid can
 * still be found: see {@link MarkerScanner}.
 */
export const LAUNCH_MARKER_ENV = 'OT_LAUNCH_ID';

/** A live process that carries a launch marker (see {@link MarkerScanner}). */
export interface MarkedProcess {
  /** The value of {@link LAUNCH_MARKER_ENV} in its environment. */
  readonly marker: string;
  readonly pid: number;
  /** When it started (epoch ms, as the OS says), the same measure as {@link OrphanTarget.startedAt}. */
  readonly startedAt: number;
}

/**
 * Optional capability of a `ProcessLauncher` (Phase 11, P3; [proposta], so the port version does
 * not change): find the live processes of this user that carry a {@link LAUNCH_MARKER_ENV}. It is
 * what closes the window between "the process started" and "its pid is written down": the daemon
 * writes the row first, puts its id in the child's environment, and the next daemon finds the
 * process, and every descendant that inherited the variable, by that id. A launcher that cannot
 * read the environment of other processes does not have it (Windows does not need it: the Job Object
 * ends the tree when the daemon dies). Check with {@link supportsMarkerScan}.
 */
export interface MarkerScanner {
  /** Every live process with a marker, at the moment of the call. Never rejects: an unreadable table is an empty one. */
  findMarked(): Promise<readonly MarkedProcess[]>;
}

/** Narrows a `ProcessLauncher` to one that can scan for launch markers. */
export function supportsMarkerScan(
  launcher: ProcessLauncher,
): launcher is ProcessLauncher & MarkerScanner {
  return typeof (launcher as Partial<MarkerScanner>).findMarked === 'function';
}

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Checks the shape of {@link LaunchOptions}; every adapter calls it first. Throws `InvalidInput`.
 * Pure: it does not touch the file system, so a missing directory is the adapter's
 * `AdapterUnavailable`, not this check's.
 */
export function assertLaunchOptions(opts: LaunchOptions): void {
  if (opts.cmd.length === 0 || opts.cmd.includes('\0')) {
    throw new InvalidInput('LaunchOptions.cmd must be a non-empty string without NUL');
  }
  if (opts.args.some((arg) => arg.includes('\0'))) {
    throw new InvalidInput('LaunchOptions.args must not contain NUL');
  }
  if (!ABSOLUTE_PATH.test(opts.cwd) || opts.cwd.includes('\0')) {
    throw new InvalidInput(
      `LaunchOptions.cwd must be an absolute path: ${JSON.stringify(opts.cwd)}`,
    );
  }
  for (const [key, value] of Object.entries(opts.env)) {
    if (key.length === 0 || key.includes('=') || key.includes('\0') || value.includes('\0')) {
      throw new InvalidInput(`LaunchOptions.env has an invalid entry: ${JSON.stringify(key)}`);
    }
  }
  if (
    opts.memoryLimitBytes !== undefined &&
    !(Number.isSafeInteger(opts.memoryLimitBytes) && opts.memoryLimitBytes > 0)
  ) {
    throw new InvalidInput('LaunchOptions.memoryLimitBytes must be a positive integer');
  }
}
