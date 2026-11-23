// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type ClientContext,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { QUOTA_EXHAUSTED_CODE } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseScriptSpec, ScriptError, SCRIPT_NAMES } from './scripts.js';

// Each script of the failure family (Phase 11, P2) is played by the real binary, `dist/cli.js`,
// as a child process of the test, over ACP on its stdio: a script that kills the process cannot be
// proved in process. The test ends every process it created: the agents it started and, by the
// pid the agent wrote, the grandchildren. The scripts also end their own processes after `lifeMs`,
// but that is the safety net.

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const onLinux = process.platform === 'linux';

let sandbox: string;
let cwd: string;
let stateDir: string;
const agents: ChildProcess[] = [];
const grandchildren: number[] = [];

beforeEach(async () => {
  if (!existsSync(CLI)) throw new Error('dist/cli.js not found: run `pnpm build` first');
  sandbox = realpathSync(await mkdtemp(join(tmpdir(), 'fake-agent-failure-')));
  cwd = join(sandbox, 'session');
  stateDir = join(sandbox, 'state');
  await mkdir(cwd);
  await mkdir(stateDir);
});

afterEach(async () => {
  for (const pid of grandchildren.splice(0)) killIfAlive(pid);
  for (const child of agents.splice(0)) {
    if (child.pid !== undefined) killIfAlive(child.pid);
  }
  await rm(sandbox, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  if (isAlive(pid)) process.kill(pid, 'SIGKILL');
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const limit = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > limit) throw new Error('timed out waiting for the condition');
    await new Promise((done) => setTimeout(done, 20));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Running {
  readonly child: ChildProcessByStdio<Writable, Readable, null>;
  readonly pid: number;
  readonly exited: Promise<Exit>;
  readonly hasExited: () => boolean;
}

function start(env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, [CLI], {
    cwd,
    env: { ...process.env, FAKE_AGENT_STATE_DIR: stateDir, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  agents.push(child);
  child.stdin.on('error', () => undefined);
  let done = false;
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => {
      done = true;
      resolve({ code, signal });
    });
  });
  if (child.pid === undefined) throw new Error('the fake agent did not start');
  return { child, pid: child.pid, exited, hasExited: () => done };
}

interface Session {
  readonly running: Running;
  readonly cx: ClientContext;
  readonly sessionId: string;
  readonly updates: SessionUpdate[];
  /** Text of the agent message chunks so far. */
  readonly text: () => string;
}

/** Starts the agent, opens a session and runs `fn`. The agent is NOT ended afterwards: `afterEach` does it. */
async function withSession<T>(
  env: Record<string, string>,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const running = start(env);
  const updates: SessionUpdate[] = [];
  const stream = ndJsonStream(
    Writable.toWeb(running.child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(running.child.stdout) as ReadableStream<Uint8Array>,
  );
  const app = client({ name: 'failure-scripts-test' }).onNotification(
    methods.client.session.update,
    ({ params }) => {
      updates.push(params.update);
    },
  );
  // A script that kills the agent closes the connection under the test, and `connectWith` then
  // rejects while `fn` is still checking what happened. That close is the point of the script, so
  // `fn` is left to finish by itself and its outcome is the one that counts.
  let body: Promise<T> | undefined;
  await app
    .connectWith(stream, async (cx) => {
      await cx.request(methods.agent.initialize, { protocolVersion: 1 });
      const { sessionId } = await cx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      body = fn({
        running,
        cx,
        sessionId,
        updates,
        text: () =>
          updates
            .map((u) =>
              u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text'
                ? u.content.text
                : '',
            )
            .join(''),
      });
      return body;
    })
    .catch((error: unknown) => {
      if (body === undefined) throw error;
    });
  if (body === undefined) throw new Error('the session did not run');
  return body;
}

function prompt(s: Session, text: string) {
  return s.cx.request(methods.agent.session.prompt, {
    sessionId: s.sessionId,
    prompt: [{ type: 'text', text }],
  });
}

/** Attaches the outcome of a request at once: a turn that fails is never an unhandled rejection. */
function outcome<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  const done = promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return { state, done };
}

async function rejection(promise: Promise<unknown>): Promise<RequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

function pidOf(text: string, label: string): number {
  const pid = Number(new RegExp(`${label} pid (\\d+)`).exec(text)?.[1]);
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

function groupOf(pid: number): number {
  // `/proc/<pid>/stat`: "pid (comm) state ppid pgrp ..." and comm may hold spaces, so cut after ")".
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[2]);
}

describe('failure scripts: parsing', () => {
  it('lists every new script and gives each its defaults', () => {
    for (const name of [
      'die',
      'stall',
      'ignore-term',
      'spawn-child',
      'slow',
      'fail-auth',
      'fail-quota',
      'fail-transient',
    ] as const) {
      expect(SCRIPT_NAMES).toContain(name);
      expect(parseScriptSpec(name).name).toBe(name);
    }
    expect(parseScriptSpec('die')).toEqual({ name: 'die', afterChunks: 0, at: 'turn' });
    expect(parseScriptSpec('die {"afterChunks":3}')).toMatchObject({ afterChunks: 3 });
    expect(parseScriptSpec('ignore-term')).toMatchObject({ signals: ['SIGTERM'] });
    expect(parseScriptSpec('spawn-child')).toMatchObject({
      file: 'grandchild.pid',
      detached: false,
      after: 'end_turn',
    });
    expect(parseScriptSpec('slow {"chunks":2,"intervalMs":10}')).toEqual({
      name: 'slow',
      chunks: 2,
      intervalMs: 10,
    });
  });

  it('bounds the life of every process the scripts leave and rejects what it does not know', () => {
    expect(() => parseScriptSpec('spawn-child {"lifeMs":60001}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('stall {"lifeMs":99}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('ignore-term {"lifeMs":120000}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('die {"afterChunks":-1}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('die {"when":"now"}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('ignore-term {"signals":["SIGKILL"]}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('slow {"chunks":0}')).toThrow(ScriptError);
    expect(() => parseScriptSpec('spawn-child {"after":"exit"}')).toThrow(ScriptError);
  });
});

describe('die', () => {
  it('kills itself with SIGKILL after N chunks, and the peer saw all of them', async () => {
    await withSession({}, async (s) => {
      const turn = outcome(prompt(s, '#script:die {"afterChunks":2}'));
      expect((await s.running.exited).signal).toBe('SIGKILL');
      await turn.done;
      expect(s.text()).toBe('die chunk 1\ndie chunk 2\n');
      expect(turn.state.error).toBeDefined();
      expect(isAlive(s.running.pid)).toBe(false);
    });
  });

  it('dies as the turn opens when afterChunks is 0', async () => {
    await withSession({}, async (s) => {
      const turn = outcome(prompt(s, '#script:die'));
      expect((await s.running.exited).signal).toBe('SIGKILL');
      await turn.done;
      expect(s.text()).toBe('');
    });
  });

  it('as the default script with at "open", the process dies before it serves anything', async () => {
    const running = start({ FAKE_AGENT_SCRIPT: 'die {"at":"open"}' });
    const exit = await running.exited;
    expect(exit.signal).toBe('SIGKILL');
    expect(isAlive(running.pid)).toBe(false);
  });
});

describe('stall', () => {
  it('stays alive and mute: it ignores the cancel, keeps the stdout open and survives the EOF', async () => {
    await withSession({}, async (s) => {
      const turn = outcome(prompt(s, '#script:stall {"chunks":1,"lifeMs":20000}'));
      await until(() => s.text() === 'stall chunk 1\n');
      await s.cx.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
      await sleep(300);
      expect(turn.state.settled).toBe(false);
      expect(s.text()).toBe('stall chunk 1\n');
      expect(s.running.hasExited()).toBe(false);
      expect(s.running.child.stdout.destroyed).toBe(false);
      expect(s.running.child.stdout.readableEnded).toBe(false);
      s.running.child.stdin.end();
      await sleep(300);
      expect(s.running.hasExited()).toBe(false);
      expect(isAlive(s.running.pid)).toBe(true);
      // Only a signal ends it: SIGTERM is not ignored by this script.
      s.running.child.kill('SIGTERM');
      expect((await s.running.exited).signal).toBe('SIGTERM');
    });
  });

  it('ends itself with SIGKILL after lifeMs, so a failed test leaves no orphan', async () => {
    await withSession({}, async (s) => {
      void outcome(prompt(s, '#script:stall {"lifeMs":400}'));
      expect((await s.running.exited).signal).toBe('SIGKILL');
    });
  });
});

describe('ignore-term', () => {
  it('survives SIGTERM and ends only with SIGKILL', async () => {
    await withSession({}, async (s) => {
      const turn = outcome(prompt(s, '#script:ignore-term {"lifeMs":20000}'));
      await until(() => s.text().includes('ignoring SIGTERM'));
      s.running.child.kill('SIGTERM');
      await sleep(400);
      expect(s.running.hasExited()).toBe(false);
      expect(isAlive(s.running.pid)).toBe(true);
      expect(turn.state.settled).toBe(false);
      s.running.child.kill('SIGKILL');
      expect((await s.running.exited).signal).toBe('SIGKILL');
    });
  });

  it('as the default script it ignores SIGTERM from the start of the process', async () => {
    await withSession({ FAKE_AGENT_SCRIPT: 'ignore-term {"lifeMs":20000}' }, async (s) => {
      // The session is open: the process is up and serving, no turn has run.
      s.running.child.kill('SIGTERM');
      await sleep(400);
      expect(s.running.hasExited()).toBe(false);
      s.running.child.kill('SIGKILL');
      expect((await s.running.exited).signal).toBe('SIGKILL');
    });
  });
});

describe('spawn-child', () => {
  it('leaves a grandchild in the cwd of the session and writes its pid to FAKE_AGENT_STATE_DIR', async () => {
    await withSession({}, async (s) => {
      expect((await prompt(s, '#script:spawn-child {"lifeMs":20000}')).stopReason).toBe('end_turn');
      const pid = pidOf(s.text(), 'grandchild');
      grandchildren.push(pid);
      expect(Number((await readFile(join(stateDir, 'grandchild.pid'), 'utf8')).trim())).toBe(pid);
      expect(pid).not.toBe(s.running.pid);
      expect(isAlive(pid)).toBe(true);
      if (onLinux) expect(readlinkSync(`/proc/${String(pid)}/cwd`)).toBe(cwd);
      // It is a grandchild of the test: its group is the one of the agent.
      if (onLinux) expect(groupOf(pid)).toBe(groupOf(s.running.pid));
    });
  });

  it('survives the agent: after "die" the parent is gone and the grandchild is not', async () => {
    await withSession({}, async (s) => {
      const turn = outcome(
        prompt(s, '#script:spawn-child {"after":"die","lifeMs":20000,"file":"gc.pid"}'),
      );
      expect((await s.running.exited).signal).toBe('SIGKILL');
      await turn.done;
      const pid = Number((await readFile(join(stateDir, 'gc.pid'), 'utf8')).trim());
      grandchildren.push(pid);
      expect(pidOf(s.text(), 'grandchild')).toBe(pid);
      expect(isAlive(s.running.pid)).toBe(false);
      expect(isAlive(pid)).toBe(true);
      // The pid file is what a test uses to end it.
      process.kill(pid, 'SIGKILL');
      await until(() => !isAlive(pid));
    });
  });

  it.skipIf(!onLinux)('detached puts the grandchild in a group of its own', async () => {
    await withSession({}, async (s) => {
      await prompt(s, '#script:spawn-child {"detached":true,"lifeMs":20000}');
      const pid = pidOf(s.text(), 'grandchild');
      grandchildren.push(pid);
      expect(groupOf(pid)).toBe(pid);
      expect(groupOf(pid)).not.toBe(groupOf(s.running.pid));
    });
  });

  it('with "stall" the agent stays alive and mute after the grandchild started', async () => {
    await withSession({}, async (s) => {
      const turn = outcome(prompt(s, '#script:spawn-child {"after":"stall","lifeMs":20000}'));
      await until(() => s.text().includes('grandchild pid'));
      grandchildren.push(pidOf(s.text(), 'grandchild'));
      await sleep(300);
      expect(turn.state.settled).toBe(false);
      expect(s.running.hasExited()).toBe(false);
    });
  });

  it('the grandchild ends itself after lifeMs', async () => {
    await withSession({}, async (s) => {
      await prompt(s, '#script:spawn-child {"lifeMs":300}');
      const pid = pidOf(s.text(), 'grandchild');
      grandchildren.push(pid);
      await until(() => !isAlive(pid), 5000);
    });
  });

  it('fails the turn when FAKE_AGENT_STATE_DIR is not set, starting nothing', async () => {
    await withSession({ FAKE_AGENT_STATE_DIR: '' }, async (s) => {
      const error = await rejection(prompt(s, '#script:spawn-child'));
      expect(error.message).toContain('FAKE_AGENT_STATE_DIR');
      expect(s.text()).toBe('');
    });
  });
});

describe('slow', () => {
  it('sends the chunks with an interval and ends the turn normally', async () => {
    await withSession({}, async (s) => {
      const started = Date.now();
      const response = await prompt(s, '#script:slow {"chunks":4,"intervalMs":120}');
      expect(response.stopReason).toBe('end_turn');
      // Three gaps of 120 ms; the margin keeps a loaded runner from failing it.
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(s.text()).toBe('slow 1/4\nslow 2/4\nslow 3/4\nslow 4/4\n');
    });
  });

  it('stops between two chunks on session/cancel', async () => {
    await withSession({}, async (s) => {
      const turn = prompt(s, '#script:slow {"chunks":50,"intervalMs":100}');
      await until(() => s.text().includes('slow 2/50'));
      await s.cx.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
      expect((await turn).stopReason).toBe('cancelled');
      expect(s.text()).not.toContain('slow 50/50');
    });
  });
});

describe('fail-auth, fail-quota and fail-transient', () => {
  it('fail-auth answers -32000 "authentication required" with the Codex hint', async () => {
    await withSession({}, async (s) => {
      const error = await rejection(prompt(s, '#script:fail-auth'));
      expect(error.code).toBe(-32000);
      expect(error.message).toBe('Authentication required: please run /login');
      expect(error.data).toEqual({ script: 'fail-auth', codexErrorInfo: 'unauthorized' });
      // The agent goes on: a failed turn does not end the process.
      expect(s.running.hasExited()).toBe(false);
    });
  });

  it('fail-quota answers the quota code, the QuotaExhausted type and the reset time', async () => {
    await withSession({}, async (s) => {
      const error = await rejection(
        prompt(s, '#script:fail-quota {"resetsAt":"2026-11-16T20:00:00Z"}'),
      );
      expect(error.code).toBe(QUOTA_EXHAUSTED_CODE);
      expect(error.message).toBe(
        `Claude AI usage limit reached|${String(Date.parse('2026-11-16T20:00:00Z') / 1000)}`,
      );
      expect(error.data).toEqual({
        type: 'QuotaExhausted',
        codexErrorInfo: 'usageLimitExceeded',
        resetsAt: '2026-11-16T20:00:00Z',
      });
    });
  });

  it('fail-quota without a reset time has none anywhere', async () => {
    await withSession({}, async (s) => {
      const error = await rejection(prompt(s, '#script:fail-quota'));
      expect(error.message).toBe('Claude AI usage limit reached');
      expect(error.data).toEqual({ type: 'QuotaExhausted', codexErrorInfo: 'usageLimitExceeded' });
    });
  });

  it('fail-transient answers -32603 "overloaded" with the Codex hint', async () => {
    await withSession({}, async (s) => {
      const error = await rejection(prompt(s, '#script:fail-transient'));
      expect(error.code).toBe(-32603);
      expect(error.message).toBe('Overloaded: API Error 529 overloaded_error');
      expect(error.data).toEqual({ script: 'fail-transient', codexErrorInfo: 'serverOverloaded' });
    });
  });

  it('takes the message of the script', async () => {
    await withSession({}, async (s) => {
      const error = await rejection(prompt(s, '#script:fail-transient {"message":"503 down"}'));
      expect(error.message).toBe('503 down');
    });
  });
});
