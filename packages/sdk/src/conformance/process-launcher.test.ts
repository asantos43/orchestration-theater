// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  assertLaunchOptions,
  AdapterUnavailable,
  DEFAULT_KILL_GRACE_MS,
  InvalidInput,
  PROCESS_LAUNCHER_PORT_VERSION,
  type KillReport,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessLauncher,
} from '@otheater/core';
import { describe } from 'vitest';
import { describeProcessLauncherConformance } from '../index.js';

/** Pids of the live members of process group `pgid` (Linux `/proc`). */
function groupMembers(pgid: number): number[] {
  const members: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(group) === pgid && state !== 'Z') members.push(Number(name));
    } catch {
      // Ended while scanning.
    }
  }
  return members;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Smallest launcher that can pass the suite's group-agnostic tests: a detached process, one
 * `kill(-pgid)`. It says `job-object` only so the suite skips the tests that need signals
 * (polite signal, SIGKILL escalation, a grandchild that left the group); it is NOT the contract
 * of a Job Object. The real posix adapter runs the whole suite in its own package.
 */
class GroupOnlyLauncher implements ProcessLauncher {
  readonly id = 'group-only-test';
  readonly implements = {
    port: 'ProcessLauncher',
    range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
  } as const;

  capabilities() {
    return { treeKill: 'job-object', memoryLimit: false, suspendedStart: false } as const;
  }

  async launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    assertLaunchOptions(opts);
    if (opts.memoryLimitBytes !== undefined) throw new InvalidInput('no memory limit');
    const child = spawn(opts.cmd, [...opts.args], {
      cwd: opts.cwd,
      env: { ...opts.env },
      detached: true,
      stdio: 'pipe',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    }).catch((error: unknown) => {
      throw new AdapterUnavailable('cannot start', { cause: error });
    });
    const pid = child.pid ?? -1;
    child.stdin.on('error', () => undefined);
    let ended = false;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => {
        ended = true;
        resolve({ code, signal });
      });
    });
    return {
      pid,
      stdin: Writable.toWeb(child.stdin),
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      exited,
      killTree: async (killOpts): Promise<KillReport> => {
        const graceMs = killOpts?.graceMs ?? DEFAULT_KILL_GRACE_MS;
        if (!Number.isFinite(graceMs) || graceMs < 0) throw new InvalidInput('bad graceMs');
        const found = groupMembers(pid).length;
        if (found === 0) return { found: 0, forced: false, remaining: [] };
        const send = (signal: NodeJS.Signals): void => {
          try {
            process.kill(-pid, signal);
          } catch {
            // Group already gone.
          }
        };
        send('SIGTERM');
        const until = Date.now() + graceMs;
        while (groupMembers(pid).length > 0 && Date.now() < until) await wait(20);
        const forced = groupMembers(pid).length > 0;
        if (forced) send('SIGKILL');
        const settle = Date.now() + 2000;
        while (groupMembers(pid).length > 0 && Date.now() < settle) await wait(20);
        if (!ended) await Promise.race([exited, wait(1000)]);
        return { found, forced, remaining: groupMembers(pid) };
      },
    };
  }
}

// The suite itself is tested here: it must pass on a minimal launcher and skip, not fail, the
// tests that need signals when the launcher says it has none. Linux only (it reads /proc).
describe.skipIf(process.platform !== 'linux')(
  'process launcher suite on a reference launcher',
  () => {
    describeProcessLauncherConformance('group-only reference (test-only)', () => ({
      launcher: new GroupOnlyLauncher(),
    }));
  },
);
