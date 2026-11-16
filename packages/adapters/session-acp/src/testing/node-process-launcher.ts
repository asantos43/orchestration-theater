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
 * the real one is `adapter-launcher-*`, a later step): `node:child_process` with `detached`, so the
 * child leads a process group of its own, and a group kill (`kill(-pid)`) that reaches whatever the
 * child started. The child sees exactly `env`.
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
    return { treeKill: 'process-group', memoryLimit: false, suspendedStart: false };
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
        detached: true,
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
          killTree: (options) => killGroup(pid, options),
        });
      });
    });
  }

  /** How many launched trees still have a live member (a zombie not yet reaped counts as live). */
  aliveGroups(): number {
    return this.pids.filter(groupAlive).length;
  }
}

/** True while any process of the group `pgid` exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
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

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!groupAlive(pgid)) return true;
    await sleep(10);
  }
  return !groupAlive(pgid);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

async function killGroup(pgid: number, options?: KillOptions): Promise<KillReport> {
  if (!groupAlive(pgid)) return { found: 0, forced: false, remaining: [] };
  signalGroup(pgid, 'SIGTERM');
  if (await waitGone(pgid, options?.graceMs ?? DEFAULT_KILL_GRACE_MS)) {
    return { found: 1, forced: false, remaining: [] };
  }
  signalGroup(pgid, 'SIGKILL');
  const gone = await waitGone(pgid, 2000);
  return { found: 1, forced: true, remaining: gone ? [] : [pgid] };
}
