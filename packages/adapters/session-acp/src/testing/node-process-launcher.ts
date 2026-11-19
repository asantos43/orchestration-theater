// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  AdapterUnavailable,
  assertLaunchOptions,
  DEFAULT_KILL_GRACE_MS,
  PROCESS_LAUNCHER_PORT_VERSION,
  type AdapterImplements,
  type KillOptions,
  type KillReport,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessExit,
  type ProcessLauncher,
} from '@otheater/core';

/**
 * A `ProcessLauncher` for the tests of this package only (it is not exported by the package, and
 * the real one is `adapter-launcher-*`, a later step): `node:child_process`. On POSIX the child is
 * `detached`, so it leads a process group of its own, and a group kill (`kill(-pid)`) reaches
 * whatever it started. On Windows there are no process groups (a negative pid is not a group there):
 * the tree is ended with the system `taskkill /PID <pid> /T /F`, which walks the descendants of a
 * root that is still alive (a grandchild whose parent already died is out of its reach). The child
 * sees exactly `env`.
 */
export class NodeProcessLauncher implements ProcessLauncher {
  readonly id = 'node-test';
  readonly implements: AdapterImplements = {
    port: 'ProcessLauncher',
    range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
  };
  /** Root pids launched, in order. */
  readonly pids: number[] = [];

  capabilities(): LauncherCapabilities {
    return {
      treeKill: WINDOWS ? 'descendants' : 'process-group',
      memoryLimit: false,
      suspendedStart: false,
    };
  }

  launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    try {
      assertLaunchOptions(opts);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise<LaunchedProcess>((resolve, reject) => {
      const child = spawn(opts.cmd, [...opts.args], {
        cwd: opts.cwd,
        env: { ...opts.env },
        // Windows: `detached` would open a console of its own and gives no group to kill.
        detached: !WINDOWS,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.once('error', (error) => {
        reject(
          new AdapterUnavailable(`cannot start ${opts.cmd}: ${error.message}`, { cause: error }),
        );
      });
      child.once('spawn', () => {
        const pid = child.pid;
        if (pid === undefined) {
          reject(new AdapterUnavailable(`cannot start ${opts.cmd}: no pid`));
          return;
        }
        this.pids.push(pid);
        // A write after the child is gone (EPIPE) must not become an unhandled error.
        child.stdin.on('error', () => undefined);
        const exited = new Promise<ProcessExit>((done) => {
          child.once('exit', (code, signal) => {
            done({ code, signal });
          });
        });
        resolve({
          pid,
          stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
          exited,
          killTree: (options) => killTree(pid, options),
        });
      });
    });
  }

  /** How many launched trees still have a live member (a zombie not yet reaped counts as live). */
  aliveGroups(): number {
    return this.pids.filter(treeAlive).length;
  }

  /**
   * Ends, at once and without grace, every tree this launcher started (a crash, or a cleanup), and
   * waits until the kernel no longer lists them (a killed child is a zombie until it is reaped, and
   * on Windows the root can outlive the end of `taskkill` for a moment).
   */
  async killAll(): Promise<void> {
    await Promise.all(
      this.pids.map(async (pid) => {
        await hardKill(pid);
        await waitGone(pid, 2000);
      }),
    );
  }
}

const WINDOWS = process.platform === 'win32';

/**
 * True while the tree rooted at `pid` is alive. POSIX: any member of the process group `pid`.
 * Windows: the root process only (there is no group to ask; the descendants die with the root
 * through `taskkill /T`).
 */
export function treeAlive(pid: number): boolean {
  try {
    process.kill(WINDOWS ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!treeAlive(pid)) return true;
    await sleep(10);
  }
  return !treeAlive(pid);
}

/** `taskkill /PID <pid> /T /F`: resolves when it ends; an exit code of failure means "not found". */
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      resolve();
    });
    killer.once('close', () => {
      resolve();
    });
  });
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Forced kill of the whole tree, no wait. */
async function hardKill(pid: number): Promise<void> {
  if (WINDOWS) await taskkillTree(pid);
  else signalGroup(pid, 'SIGKILL');
}

async function killTree(pid: number, options?: KillOptions): Promise<KillReport> {
  if (!treeAlive(pid)) return { found: 0, forced: false, remaining: [] };
  if (WINDOWS) {
    // No polite signal for a console process on Windows (`taskkill` without `/F` only asks windows
    // to close), so the kill is forced from the start.
    await taskkillTree(pid);
    const gone = await waitGone(pid, 2000);
    return { found: 1, forced: true, remaining: gone ? [] : [pid] };
  }
  signalGroup(pid, 'SIGTERM');
  if (await waitGone(pid, options?.graceMs ?? DEFAULT_KILL_GRACE_MS)) {
    return { found: 1, forced: false, remaining: [] };
  }
  signalGroup(pid, 'SIGKILL');
  const gone = await waitGone(pid, 2000);
  return { found: 1, forced: true, remaining: gone ? [] : [pid] };
}
