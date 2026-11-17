// SPDX-License-Identifier: MPL-2.0
import { Readable, Writable } from 'node:stream';
import { execa } from 'execa';
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
  type OrphanKillReport,
  type OrphanReaper,
  type OrphanTarget,
  type ProcessExit,
  type ProcessLauncher,
} from '@otheater/core';
import {
  POSIX_PROCESS_LAUNCHER_ADAPTER,
  PosixLauncherConfigSchema,
  type PosixLauncherConfig,
  type PosixLauncherConfigInput,
} from './config.js';
import { killProcessTree, sendSignal, type KillDeps } from './kill-tree.js';
import { START_TOLERANCE_MS, systemProcessTable, type ProcessTable } from './process-table.js';
import { findSystemdRun, scopeCommand } from './systemd-scope.js';

/** [proposta] Longest wait for the root's `exit` event once the tree is gone. */
const ROOT_REAP_WAIT_MS = 1000;

/** What a test may replace; the defaults are the real system. */
export interface PosixLauncherDeps {
  readonly table?: ProcessTable;
}

/**
 * `ProcessLauncher` for Linux and macOS (architecture 5.9, 5.18): every process is born as the
 * leader of its own process group (and session), so one `kill(-pgid)` reaches the whole tree, and
 * `killTree` adds a walk over the descendants for whatever left the group with `setsid`.
 *
 * - `capabilities()`: `treeKill: 'process-group'`, no suspended start (posix has no such thing:
 *   the group exists from the `exec`, so there is no window), and a memory limit only with
 *   `memoryLimit: 'systemd-scope'`.
 * - The child sees exactly `env`; `process.env` is never read for it.
 * - The streams are WHATWG streams over the pipes. The caller must read `stdout` and `stderr`: a
 *   child that fills a pipe nobody reads blocks (as in any pipe), until `killTree`.
 */
export class PosixProcessLauncher implements ProcessLauncher, OrphanReaper {
  readonly id: Adapter['id'] = POSIX_PROCESS_LAUNCHER_ADAPTER.id;
  readonly implements: Adapter['implements'] = POSIX_PROCESS_LAUNCHER_ADAPTER.implements;
  readonly config: PosixLauncherConfig;
  readonly #table: ProcessTable;

  constructor(config: PosixLauncherConfigInput = {}, deps: PosixLauncherDeps = {}) {
    const parsed = PosixLauncherConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new InvalidInput(`Invalid posix launcher config: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    this.config = parsed.data;
    this.#table = deps.table ?? systemProcessTable();
    if (this.config.memoryLimit === 'systemd-scope') {
      if (process.platform !== 'linux' || findSystemdRun() === undefined) {
        throw new AdapterUnavailable("memoryLimit 'systemd-scope' needs Linux with systemd-run");
      }
    }
  }

  capabilities(): LauncherCapabilities {
    return {
      treeKill: 'process-group',
      memoryLimit: this.config.memoryLimit === 'systemd-scope',
      suspendedStart: false,
    };
  }

  async processStartedAt(pid: number): Promise<number | undefined> {
    const info = (await this.#table()).get(pid);
    return info === undefined || info.zombie ? undefined : info.startedAtMs;
  }

  /**
   * Ends the tree a dead daemon left (architecture 5.21): the process must still be alive and have
   * started at the recorded instant (within {@link START_TOLERANCE_MS}); a recycled pid starts at
   * another time and is left alone. The orphan was launched as a group leader, so its group is
   * its tree, as in `killTree`.
   */
  async killOrphan(target: OrphanTarget, opts: KillOptions = {}): Promise<OrphanKillReport> {
    const none = { found: 0, forced: false, remaining: [] as number[] };
    const info = (await this.#table()).get(target.pid);
    if (info === undefined || info.zombie || info.startedAtMs === undefined) {
      return { matched: false, report: none };
    }
    if (Math.abs(info.startedAtMs - target.startedAt) > START_TOLERANCE_MS) {
      return { matched: false, report: none };
    }
    const deps: KillDeps = {
      table: this.#table,
      signal: sendSignal,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
      now: () => performance.now(),
    };
    const report = await killProcessTree(
      { rootPid: target.pid, rootStart: info.start },
      opts.graceMs ?? DEFAULT_KILL_GRACE_MS,
      deps,
    );
    return { matched: true, report };
  }

  async launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    assertLaunchOptions(opts);
    if (opts.memoryLimitBytes !== undefined && !this.capabilities().memoryLimit) {
      throw new InvalidInput(
        "memoryLimitBytes is not supported by this launcher (memoryLimit: 'none'); the limit is never ignored",
      );
    }

    let file = opts.cmd;
    let args = [...opts.args];
    let env: Record<string, string> = { ...opts.env };
    if (opts.memoryLimitBytes !== undefined) {
      try {
        const scope = scopeCommand(opts.cmd, opts.args, opts.env, opts.memoryLimitBytes, opts.cwd);
        ({ file, args, env } = scope);
      } catch (error) {
        throw new AdapterUnavailable('Cannot build the systemd scope command', { cause: error });
      }
    }

    // `detached` = `setsid` in the child: leader of a new session and process group.
    const child = execa(file, args, {
      cwd: opts.cwd,
      env,
      extendEnv: false,
      detached: true,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      reject: false,
    });

    const node = child.nodeChildProcess;
    try {
      await new Promise<void>((resolve, reject) => {
        node.once('spawn', resolve);
        node.once('error', reject);
      });
    } catch (error) {
      throw new AdapterUnavailable(
        `Cannot start ${JSON.stringify(opts.cmd)} in ${JSON.stringify(opts.cwd)}`,
        { cause: error },
      );
    }
    const pid = child.pid;
    if (pid === undefined) throw new AdapterUnavailable('The process started without a pid');

    // Not awaited: the start time only matters to a later `killTree`, and a scan costs a few ms.
    const rootStart = this.#table().then((table) => table.get(pid)?.start);

    // `exited` follows the `exit` event of the root, not the execa promise: that one also waits for
    // the pipes to close, which a caller that never reads them would hold forever.
    let rootExited = false;
    const exited = new Promise<ProcessExit>((resolve) => {
      node.once('exit', (code, signal) => {
        rootExited = true;
        resolve({ code, signal });
      });
    });
    // With `reject: false` the execa promise never rejects; this only keeps that guaranteed.
    child.catch(() => undefined);

    const { stdin, stdout, stderr } = child;
    // A write to a pipe whose reader is gone raises EPIPE; the WHATWG stream reports it to the
    // writer, and this keeps the Node stream from also throwing it as an unhandled event.
    stdin.on('error', () => undefined);

    let settled = false;
    let inFlight: Promise<KillReport> | undefined;

    const runKill = async (graceMs: number): Promise<KillReport> => {
      if (settled) return { found: 0, forced: false, remaining: [] };
      // The group id stays reserved while any member lives; once it is empty, the number may go
      // to an unrelated process. So an exited root with an empty group means: nothing to do, ever.
      if (rootExited && !groupExists(pid)) {
        settled = true;
        return { found: 0, forced: false, remaining: [] };
      }
      const deps: KillDeps = {
        table: this.#table,
        signal: sendSignal,
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          }),
        now: () => performance.now(),
      };
      const report = await killProcessTree(
        { rootPid: pid, rootStart: await rootStart },
        graceMs,
        deps,
      );
      if (!report.remaining.includes(pid)) await settleRoot(exited);
      if (report.remaining.length === 0) settled = true;
      return report;
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
        inFlight ??= runKill(graceMs).finally(() => {
          inFlight = undefined;
        });
        return inFlight;
      },
    };
  }
}

/** True while some process is in the group `pgid` (zombies included, as `kill(2)` sees them). */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Waits (bounded) for the root's `exit` event, so a returned `killTree` leaves it reaped. */
async function settleRoot(exited: Promise<ProcessExit>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ROOT_REAP_WAIT_MS);
  });
  try {
    await Promise.race([exited, limit]);
  } finally {
    clearTimeout(timer);
  }
}
