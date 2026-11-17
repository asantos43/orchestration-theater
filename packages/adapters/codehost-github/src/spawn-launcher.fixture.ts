// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  AdapterUnavailable,
  assertLaunchOptions,
  type Adapter,
  type KillReport,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessExit,
  type ProcessLauncher,
} from '@otheater/core';

/**
 * A `ProcessLauncher` for the tests of this adapter only: it starts the real process with
 * `child_process.spawn` (the fake `gh` script, the real `git`) in its own process group and kills
 * the group in `killTree`. The adapters do not import each other, so the posix launcher of the
 * daemon is not available here; the contract used is the same.
 */
export class SpawnLauncher implements ProcessLauncher {
  readonly id = 'test-spawn';
  readonly implements: Adapter['implements'] = { port: 'ProcessLauncher', range: '^0.1.0' };
  /** Every launch, in order, for the tests that look at the environment the tool was given. */
  readonly launched: LaunchOptions[] = [];

  capabilities(): LauncherCapabilities {
    return { treeKill: 'process-group', memoryLimit: false, suspendedStart: false };
  }

  async launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    assertLaunchOptions(opts);
    this.launched.push(opts);
    const child = spawn(opts.cmd, [...opts.args], {
      cwd: opts.cwd,
      env: { ...opts.env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        reject(new AdapterUnavailable(`cannot start ${opts.cmd}`, { cause: error }));
      });
    });
    const pid = child.pid;
    if (pid === undefined) throw new AdapterUnavailable(`cannot start ${opts.cmd}`);
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
    // The tool may exit before it reads stdin; that is not an error of the test.
    child.stdin.on('error', () => undefined);
    return {
      pid,
      stdin: Writable.toWeb(child.stdin),
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      exited,
      killTree: (): Promise<KillReport> => {
        let found = 0;
        try {
          process.kill(-pid, 'SIGKILL');
          found = 1;
        } catch {
          // The group is already gone.
        }
        return Promise.resolve({ found, forced: found > 0, remaining: [] });
      },
    };
  }
}
