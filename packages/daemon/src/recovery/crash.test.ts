// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeCodeHost, InMemoryStore, FakeClock } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { assertFakeAgentBuilt, FAKE_AGENT_CLI } from '../orchestration/e2e-fixture.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';
import { CRASH_CHILD_SCRIPT } from './crash-child-fixture.js';

/**
 * `kill -9` of the daemon in the middle of a side effect (architecture 5.21, acceptance of P9).
 * The daemon runs as a child process of the test, with the fake agent and the fake code host. A
 * variable only the test sets (`OT_TEST_CRASH_AT`) makes the code host stop right after it opened
 * the pull request, before the daemon wrote that the effect ended; the test then kills the daemon
 * with SIGKILL, starts another on the same folder and checks what the start-up did.
 */

const DAEMON_DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const CORE_TESTING = pathToFileURL(
  fileURLToPath(new URL('../../../core/dist/testing/index.js', import.meta.url)),
).href;

beforeAll(() => {
  assertFakeAgentBuilt();
  if (!existsSync(join(DAEMON_DIST, 'daemon.js'))) {
    throw new Error(`${DAEMON_DIST} does not exist: run "pnpm build" before the tests`);
  }
});
afterAll(disposeTestGitIsolation);

/** Whether the process is there and running (a zombie waiting for its parent is not). */
function isAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

interface Child {
  readonly process: ChildProcess;
  /** Resolves with the JSON after `prefix` on the first line that starts with it. */
  line(prefix: string, timeoutMs: number): Promise<unknown>;
  exited: Promise<number | null>;
}

function startChild(script: string, env: Record<string, string>): Child {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const waiting: (() => void)[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
    for (const wake of waiting) wake();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      for (const wake of waiting) wake();
      resolve(code);
    });
  });
  return {
    process: child,
    exited,
    line: (prefix, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`No "${prefix}" line in ${String(timeoutMs)} ms.\n${out}\n${err}`));
        }, timeoutMs);
        const check = (): boolean => {
          const found = out.split('\n').find((candidate) => candidate.startsWith(prefix));
          if (found === undefined) return false;
          clearTimeout(timer);
          resolve(JSON.parse(found.slice(prefix.length)));
          return true;
        };
        if (check()) return;
        waiting.push(() => {
          if (child.exitCode !== null && !out.includes(prefix)) {
            clearTimeout(timer);
            reject(new Error(`The child exited before "${prefix}".\n${out}\n${err}`));
            return;
          }
          check();
        });
      }),
  };
}

interface Report {
  timedOut: boolean;
  plays: { id: string; state: string }[];
  recovered: {
    orphansKilled: number;
    sessionsInterrupted: number;
    effectsResolved: number;
    playsResumed: string[];
    pending: unknown[];
  }[];
  events: { type: string; playId: string | null }[];
  sideEffects: { key: string; type: string; state: string; verifier: string | null }[];
  decisions: { kind: string; state: string }[];
  pulls: number;
}

describe.skipIf(process.platform !== 'linux')(
  'kill -9 of the daemon in the middle of a side effect (P9)',
  { timeout: 240_000 },
  () => {
    it('ends the orphan, settles the effect by its verifier and repeats nothing', async () => {
      const tmp = await makeTempDataDir();
      const work = await mkdtemp(join(tmpdir(), 'otheater-crash-'));
      const clock = new FakeClock();
      const rig = await makeWorkspaceRig({
        store: new InMemoryStore({ clock }),
        codeHost: new FakeCodeHost(),
      });
      const script = join(work, 'child.mjs');
      await writeFile(script, CRASH_CHILD_SCRIPT);
      const journal = join(work, 'code-host.jsonl');
      const base = {
        OT_CHILD_DATA_DIR: tmp.dir,
        OT_CHILD_REPO: rig.repo,
        OT_CHILD_JOURNAL: journal,
        OT_CHILD_STATE_DIR: work,
        OT_CHILD_DAEMON_DIST: DAEMON_DIST,
        OT_CHILD_CORE_TESTING: CORE_TESTING,
        OT_CHILD_FAKE_AGENT: FAKE_AGENT_CLI,
      };
      const spawned: number[] = [];
      const children: ChildProcess[] = [];
      try {
        // 1. The daemon runs until the code host has opened the pull request, then it is killed.
        const first = startChild(script, {
          ...base,
          OT_CHILD_MODE: 'first',
          OT_TEST_CRASH_AT: 'open_pr:after',
        });
        children.push(first.process);
        const crash = (await first.line('CRASHPOINT ', 120_000)) as { pids: number[] };
        spawned.push(...crash.pids);
        expect(crash.pids.length).toBeGreaterThan(0);
        first.process.kill('SIGKILL');
        await first.exited;
        // The client outlived the daemon: it is an orphan now.
        const orphans = crash.pids.filter(isAlive);
        expect(orphans.length).toBeGreaterThan(0);

        // 2. Another daemon on the same folder reconciles, resumes the play and ends it.
        const second = startChild(script, { ...base, OT_CHILD_MODE: 'resume' });
        children.push(second.process);
        const report = (await second.line('REPORT ', 150_000)) as Report;
        await second.exited;

        expect(report.timedOut).toBe(false);
        // The orphans died.
        for (const pid of orphans) expect(isAlive(pid)).toBe(false);
        const recovered = report.recovered.at(-1);
        expect(recovered?.orphansKilled).toBeGreaterThanOrEqual(orphans.length);
        expect(recovered?.sessionsInterrupted).toBeGreaterThan(0);
        expect(recovered?.effectsResolved).toBeGreaterThanOrEqual(1);
        expect(recovered?.pending).toEqual([]);
        expect(recovered?.playsResumed).toHaveLength(1);
        // The effect was settled by the verifier, not by asking the Producer.
        const prs = report.sideEffects.filter((row) => row.type === 'open_pr');
        expect(prs).toHaveLength(1);
        expect(prs[0]).toMatchObject({ state: 'done', verifier: 'verifier' });
        expect(report.decisions.filter((row) => row.kind === 'recovery_effect')).toEqual([]);
        // Nothing repeated: one pull request, and the delivery is told once.
        expect(report.pulls).toBe(1);
        const opened = readFileSync(journal, 'utf8')
          .split('\n')
          .filter((line) => line.includes('"op":"openPullRequest"'));
        expect(opened).toHaveLength(1);
        // The dead daemon never wrote `delivery.completed`, and the reconciliation settled the PR,
        // so the resumed delivery only replays what is done and tells nothing again.
        expect(
          report.events.filter((event) => event.type === 'delivery.completed').length,
        ).toBeLessThanOrEqual(1);
        // One per start: the first daemon and the one that took over.
        expect(report.events.filter((event) => event.type === 'daemon.recovered')).toHaveLength(2);
        expect(report.plays.map((play) => play.state)).toEqual(['DONE']);
      } finally {
        for (const pid of spawned) {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
        for (const child of children) child.kill('SIGKILL');
        await rig.dispose();
        await rm(work, { recursive: true, force: true });
        await tmp.dispose();
      }
    });
  },
);
