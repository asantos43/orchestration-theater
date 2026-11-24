// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isOTheaterError,
  QuotaExhausted,
  Transient,
  type AgentSession,
  type NormalizedUpdate,
  type SharedCancelMode,
} from '@otheater/core';
import { FakeClientAdapter } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpTransport } from './acp-transport.js';
import {
  allLaunchers,
  checkNothingOutlives,
  FAKE_AGENT_CLI,
  policy,
  profile,
  prompts,
  rig,
  script,
  tempDirs,
  text,
  type Rig,
} from './testing/acp-e2e-rig.test-support.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';
import { removeDir } from './testing/remove-dir.js';

// End to end over ACP with the real fake agent: see `testing/acp-e2e-rig.test-support.ts`.

checkNothingOutlives();

describe('several sessions on one fake agent process, end to end', () => {
  const cleanup: Rig[] = [];
  afterEach(async () => {
    for (const r of cleanup.splice(0)) await r.dispose();
  });

  async function started(): Promise<Rig> {
    const r = await rig('multi-session');
    cleanup.push(r);
    return r;
  }

  it('one session ending while the other goes on, then the last one ends the process', async () => {
    const r = await started();
    // The fake agent answers the cancel; a grace long enough for a loaded runner keeps the kill of
    // a deaf client (the 300 ms of the rig) out of this test, which is about the answer.
    const via = new AcpTransport({
      cancelGraceMs: 10_000,
      killGraceMs: 1000,
      startTimeoutMs: 10_000,
    });
    const a = await r.adapter.openSession(profile, policy, r.cwd, via);
    const b = await r.adapter.openSession(profile, policy, r.cwd, via);
    expect(r.alive()).toBe(1);
    const seenB: string[] = [];
    b.onUpdate((update) => seenB.push(text(update)));
    const hanging = a.prompt(prompts.hang);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await a.cancel();
    await expect(hanging).resolves.toMatchObject({ stopReason: 'cancelled' });
    // `a` is over; the process stays for `b`, which keeps working.
    expect(r.alive()).toBe(1);
    await expect(b.prompt(prompts.echo('b goes on'))).resolves.toMatchObject({
      stopReason: 'end_turn',
    });
    expect(seenB.join('')).toContain('b goes on');
    await b.close();
    expect(r.alive()).toBe(0);
  });

  describe('a cancel the client ignores (shared_cancel)', () => {
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    /** Opens two sessions; the first runs a deaf turn whose tool child is left running. */
    async function deafPair(mode: SharedCancelMode) {
      const r = await rig('multi-session', mode);
      cleanup.push(r);
      const a = await r.adapter.openSession(profile, policy, r.cwd, r.via);
      const b = await r.adapter.openSession(profile, policy, r.cwd, r.via);
      let seen = '';
      a.onUpdate((update) => {
        seen += text(update);
      });
      const turnA = a.prompt(script('deaf', '{"child":true}'));
      const turnB = b.prompt(prompts.hang).then(
        () => undefined,
        (error: unknown) => error,
      );
      const until = Date.now() + 10_000;
      while (!/child pid \d+/.test(seen) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const pid = Number(/child pid (\d+)/.exec(seen)?.[1]);
      expect(Number.isInteger(pid)).toBe(true);
      return { r, a, b, turnA, turnB, pid };
    }

    it('escalate: the tree of the shared process ends, the tool child with it, the sibling drops', async () => {
      const { r, a, turnA, turnB, pid } = await deafPair('escalate');
      expect(alive(pid)).toBe(true);
      await a.cancel();
      await expect(turnA).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(alive(pid)).toBe(false);
      expect(r.alive()).toBe(0);
      expect(await turnB).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    });

    it('release: only the lease goes back, so the child and the process stay for the sibling', async () => {
      const { r, a, b, turnA, turnB, pid } = await deafPair('release');
      try {
        await a.cancel();
        await expect(turnA).resolves.toMatchObject({ stopReason: 'cancelled' });
        expect(alive(pid)).toBe(true);
        expect(r.alive()).toBe(1);
        await b.cancel();
        expect(await turnB).toBeUndefined();
      } finally {
        // The orphan the mode leaves behind is this test's own: end it by pid.
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
      await b.close();
      expect(r.alive()).toBe(0);
    });
  });

  it('K+1 sessions: the session over the limit gets a process of its own', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'otheater-acp-e2e-k-'));
    tempDirs.push(cwd);
    const launcher = new NodeProcessLauncher();
    allLaunchers.push(launcher);
    const adapter = new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
      processModel: 'multi-session',
      sessionsPerProcess: 2,
    });
    const via = new AcpTransport({ cancelGraceMs: 300, killGraceMs: 1000, startTimeoutMs: 10_000 });
    cleanup.push({
      launcher,
      adapter,
      via,
      cwd,
      alive: () => launcher.aliveGroups(),
      dispose: async () => {
        await launcher.killAll();
        await removeDir(cwd);
      },
    });
    const sessions = [];
    for (let i = 0; i < 3; i += 1) {
      sessions.push(await adapter.openSession(profile, policy, cwd, via));
    }
    expect(launcher.aliveGroups()).toBe(2);
    for (const session of sessions) {
      await expect(session.prompt(prompts.echo('hi'))).resolves.toMatchObject({
        stopReason: 'end_turn',
      });
    }
    await Promise.all(sessions.map((session) => session.close()));
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('a session can ask to have a process of its own', async () => {
    const r = await started();
    const shared = await r.adapter.openSession(profile, policy, r.cwd, r.via);
    const own = await r.adapter.openSession(profile, policy, r.cwd, r.via, {
      process: 'own',
    });
    expect(r.alive()).toBe(2);
    await own.close();
    expect(r.alive()).toBe(1);
    await shared.close();
    expect(r.alive()).toBe(0);
  });
});

describe('the scripts of the fake agent, end to end', () => {
  async function opened(): Promise<{ r: Rig; session: AgentSession; updates: NormalizedUpdate[] }> {
    const r = await rig();
    cleanup.push(r);
    const session = await r.adapter.openSession(profile, policy, r.cwd, r.via);
    const updates: NormalizedUpdate[] = [];
    session.onUpdate((update) => updates.push(update));
    return { r, session, updates };
  }
  const cleanup: Rig[] = [];
  afterEach(async () => {
    for (const r of cleanup.splice(0)) await r.dispose();
  });

  it('echo: the text comes back as message chunks, then the turn ends', async () => {
    const { r, session, updates } = await opened();
    const outcome = await session.prompt(prompts.echo('one two three'));
    expect(outcome.stopReason).toBe('end_turn');
    expect(updates.map(text).join('')).toContain('one two three');
    await session.close();
    expect(r.alive()).toBe(0);
  });

  it('tool-call: a tool call and its update reach the listener, normalized', async () => {
    const { session, updates } = await opened();
    await session.prompt(script('tool-call'));
    const call = updates.find((update) => update.kind === 'tool_call');
    expect(call).toMatchObject({ kind: 'tool_call', status: expect.any(String) as unknown });
    expect(updates.some((update) => update.kind === 'tool_call_update')).toBe(true);
    await session.close();
  });

  it('edit-file: the permission request is answered by the policy and the file is not written', async () => {
    const { r, session } = await opened();
    const outcome = await session.prompt(script('edit-file', '{"path":"out.txt"}'));
    expect(['end_turn', 'cancelled']).toContain(outcome.stopReason);
    expect(existsSync(join(r.cwd, 'out.txt'))).toBe(false);
    await session.close();
  });

  it('fail: a scripted failure is a typed error, not a protocol error', async () => {
    const { session } = await opened();
    const error = await session.prompt(prompts.fail).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Transient);
    expect(isOTheaterError(error)).toBe(true);
    await session.close();
  });

  it('hang: cancel by timeout ends the turn as cancelled and leaves no orphan', async () => {
    const { r, session } = await opened();
    const running = session.prompt(prompts.hang);
    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, 300);
    });
    const first = await Promise.race([running, timer]);
    expect(first).toBe('timeout');
    await session.cancel();
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(r.alive()).toBe(0);
  });

  it('quota-signal: the exhausted quota becomes QuotaExhausted, with the signals dropped quietly', async () => {
    const { session } = await opened();
    const error = await session.prompt(prompts.quota).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QuotaExhausted);
    await session.close();
  });

  const failureOf = (running: Promise<unknown>): Promise<unknown> =>
    running.then(
      () => undefined,
      (e: unknown) => e,
    );

  it('fail-quota: the quota error of a client becomes QuotaExhausted', async () => {
    const { r, session } = await opened();
    const error = await failureOf(session.prompt(script('fail-quota')));
    expect(error).toBeInstanceOf(QuotaExhausted);
    await session.close();
    expect(r.alive()).toBe(0);
  });

  it('fail-auth and fail-transient: a typed error the session survives (the fake adapter does not tell them apart)', async () => {
    const { session } = await opened();
    for (const name of ['fail-auth', 'fail-transient']) {
      const error = await failureOf(session.prompt(script(name)));
      expect(isOTheaterError(error)).toBe(true);
      expect(error).not.toBeInstanceOf(QuotaExhausted);
    }
    await session.close();
  });

  it('slow: the chunks arrive one by one, with the interval between them', async () => {
    const { session, updates } = await opened();
    const started = Date.now();
    await session.prompt(script('slow', '{"chunks":3,"intervalMs":150}'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(updates.map(text).join('')).toBe('slow 1/3\nslow 2/3\nslow 3/3\n');
    await session.close();
  });

  it('die: a client that kills itself in the turn rejects it with AdapterUnavailable', async () => {
    const { r, session } = await opened();
    const error = await failureOf(session.prompt(script('die', '{"afterChunks":1}')));
    expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await session.close();
    expect(r.alive()).toBe(0);
  });

  it('stall: a cancel the client does not answer is escalated to a kill, and no process is left', async () => {
    const { r, session } = await opened();
    const running = failureOf(session.prompt(script('stall', '{"chunks":1}')));
    await new Promise((done) => setTimeout(done, 300));
    expect(r.alive()).toBe(1);
    await session.cancel();
    await running;
    expect(r.alive()).toBe(0);
  });

  it('ignore-term: the kill goes through SIGTERM that is ignored and ends with SIGKILL', async () => {
    const { r, session } = await opened();
    const running = failureOf(session.prompt(script('ignore-term')));
    await new Promise((done) => setTimeout(done, 300));
    await session.cancel();
    await running;
    expect(r.alive()).toBe(0);
  });

  it('spawn-child: the grandchild is in the group of the client and ends with it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'otheater-acp-e2e-state-'));
    const r = await rig('process-per-session', undefined, { FAKE_AGENT_STATE_DIR: stateDir });
    // The rig removes its own folder; the state folder goes with it, after the processes.
    const dispose = r.dispose;
    cleanup.push({
      ...r,
      dispose: async () => {
        await dispose();
        await removeDir(stateDir);
      },
    });
    const session = await r.adapter.openSession(profile, policy, r.cwd, r.via);
    const running = failureOf(session.prompt(script('spawn-child', '{"after":"stall"}')));
    const pidFile = join(stateDir, 'grandchild.pid');
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) {
      await new Promise((done) => setTimeout(done, 50));
    }
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    process.kill(grandchild, 0);
    await session.cancel();
    await running;
    expect(r.alive()).toBe(0);
    const gone = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i += 1) {
        try {
          process.kill(grandchild, 0);
        } catch {
          return true;
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      return false;
    };
    const ended = await gone();
    if (!ended) process.kill(grandchild, 'SIGKILL');
    expect(ended).toBe(true);
  });
});
