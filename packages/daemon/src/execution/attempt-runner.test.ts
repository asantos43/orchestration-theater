// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attemptInputOf, isCheckpointMessage, NotFound } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { defaultVcs } from '../compose.js';
import { editsPrompt, TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { AttemptRunner } from './attempt-runner.js';
import {
  eventsOf,
  makeRig,
  QUIET_SETTINGS,
  specOf,
  until,
  type Rig,
  type RigParts,
} from './attempt-fixture.js';
import type { ExecutionSettings } from './settings.js';
import type { SharedCancelMode } from '@otheater/core';

const TEST_TIMEOUT_MS = 30_000;

function fakes(shared = false, transport: FakeSessionTransport = new FakeSessionTransport()) {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport,
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
      ...(shared ? { processModel: 'multi-session' as const } : {}),
    }),
  } satisfies RigParts;
}

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];

async function rig(
  overrides: Partial<ExecutionSettings> = {},
  shared = false,
  transport?: FakeSessionTransport,
): Promise<TestRig> {
  const made = await makeRig(fakes(shared, transport), overrides);
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});

afterAll(disposeTestGitIsolation);

/** Waits until the Executor is in the middle of a turn (`#script:hang` said so). */
async function untilHanging(r: TestRig): Promise<void> {
  await until(
    async () =>
      (await eventsOf(r, 'session.update')).some((event) =>
        JSON.stringify(event.payload).includes('hanging until session/cancel'),
      ),
    'the Executor to hang',
  );
}

describe('AttemptRunner, a normal attempt', () => {
  it(
    'runs the session in its own worktree and records everything',
    async () => {
      const r = await rig();
      const outcome = await r.runner.run(specOf(r, 'hello there'));
      expect(outcome).toMatchObject({
        attemptId: 'play-1/demand-1/1',
        state: 'completed',
        stopReason: 'end_turn',
        branch: 'play/play-1/attempts/demand-1/1',
        resumes: 0,
        needsDecision: false,
      });
      // A worktree on the attempt branch, cut from the base.
      expect(await testGit(outcome.worktree, 'branch', '--show-current')).toBe(outcome.branch);
      expect(await readFile(join(outcome.worktree, 'README.md'), 'utf8')).toBe('hello\n');
      // The registry says completed, with the session that did the work.
      const record = await r.store.attempts.get(outcome.attemptId);
      expect(record).toMatchObject({
        state: 'completed',
        client: 'fake',
        profile: 'one',
        sessionId: outcome.sessionId,
        branch: outcome.branch,
        worktree: outcome.worktree,
      });
      // The stream is in the log, in order, tagged with the attempt.
      const events = await eventsOf(r);
      const types = events.map((event) => event.type);
      expect(types[0]).toBe('session.opened');
      expect(types.at(-2)).toBe('session.prompt_finished');
      expect(types.at(-1)).toBe('session.closed');
      expect(types.filter((type) => type === 'session.update').length).toBeGreaterThan(0);
      expect(events.every((event) => event.attemptId === outcome.attemptId)).toBe(true);
      expect(events.every((event) => event.playId === 'play-1')).toBe(true);
      // Nothing is left behind.
      expect(r.launcher.running).toHaveLength(0);
      expect(r.pool.stats()).toEqual({ processes: 0, sessions: 0, queued: 0 });
      expect(r.runner.active).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'applies the model of the Executor and refuses a second attempt in the same place',
    async () => {
      const r = await rig();
      await r.runner.run(specOf(r, 'hi', { executor: { model: 'fake-model-2' } }));
      expect(r.transport.configApplied).toContainEqual({ id: 'model', value: 'fake-model-2' });
      await expect(r.runner.run(specOf(r, 'again'))).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends a failed turn as failed, with the process gone',
    async () => {
      const r = await rig();
      const outcome = await r.runner.run(specOf(r, '#throw boom'));
      expect(outcome.state).toBe('failed');
      expect(outcome.cause).toBe('boom');
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({ state: 'failed' });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, what the client says while the session is being configured', () => {
  const announcing = (): FakeSessionTransport =>
    new FakeSessionTransport({ updatesOnConfig: true });

  it(
    'records session.opened first and keeps every update, in order, behind it',
    async () => {
      const r = await rig({}, false, announcing());
      const outcome = await r.runner.run(
        specOf(r, 'hello there', { executor: { model: 'fake-model', mode: 'plan' } }),
      );
      expect(outcome.state).toBe('completed');
      // One announcement per config option, sent before `session.opened` could be written.
      expect(r.transport.configApplied).toHaveLength(2);
      const events = await eventsOf(r);
      const types = events.map((event) => event.type);
      expect(types[0]).toBe('session.opened');
      expect(types.at(-2)).toBe('session.prompt_finished');
      expect(types.at(-1)).toBe('session.closed');
      const kinds = events
        .filter((event) => event.type === 'session.update')
        .map((event) => (event.payload as { update: { kind: string } }).update.kind);
      expect(kinds.slice(0, 2)).toEqual(['available_commands', 'available_commands']);
      expect(kinds.filter((kind) => kind === 'available_commands')).toHaveLength(2);
      expect(kinds.slice(2).every((kind) => kind === 'agent_message_chunk')).toBe(true);
      expect(kinds.length).toBeGreaterThan(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'without announcements the log is unchanged (opened, updates, closed)',
    async () => {
      const r = await rig();
      await r.runner.run(specOf(r, 'hello there'));
      const kinds = (await eventsOf(r, 'session.update')).map(
        (event) => (event.payload as { update: { kind: string } }).update.kind,
      );
      expect(kinds).not.toContain('available_commands');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'drops them, with the failure recorded, when the configuration fails before session.opened',
    async () => {
      const r = await rig({}, false, announcing());
      // The model is accepted (and announced); the mode is refused: the session never opens.
      const outcome = await r.runner.run(
        specOf(r, 'hello there', { executor: { model: 'fake-model', mode: 'no-such-mode' } }),
      );
      expect(outcome.state).toBe('failed');
      expect(r.transport.configApplied).toHaveLength(1);
      const types = (await eventsOf(r)).map((event) => event.type);
      expect(types).not.toContain('session.update');
      expect(types).not.toContain('session.opened');
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({ state: 'failed' });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, the timeout', () => {
  it(
    'commits the work in progress, cancels and kills the tree, leaving no process',
    async () => {
      const r = await rig({ checkpointEditBatch: 99 });
      const running = r.runner.run(
        specOf(r, editsPrompt({ 'wip.txt': 'draft\n' }, '#script:hang'), { timeoutMs: 1000 }),
      );
      await untilHanging(r);
      await r.clock.advance(1000);
      const outcome = await running;

      expect(outcome).toMatchObject({ state: 'timed_out', cause: 'timeout', needsDecision: true });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'timed_out',
        cause: 'timeout',
      });
      // The WIP commit is on the attempt branch and holds what the Executor wrote.
      expect(outcome.checkpointSha).toBeDefined();
      expect(await testGit(outcome.worktree, 'rev-parse', 'HEAD')).toBe(outcome.checkpointSha);
      expect(isCheckpointMessage(await testGit(outcome.worktree, 'log', '-1', '--format=%s'))).toBe(
        true,
      );
      expect(await testGit(outcome.worktree, 'show', 'HEAD:wip.txt')).toBe('draft');
      expect(await testGit(r.repo, 'branch', '--list', outcome.branch)).toContain(outcome.branch);
      // The log says so, with the sha of the commit.
      const interrupted = await eventsOf(r, 'session.interrupted');
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]?.payload).toMatchObject({
        cause: 'timeout',
        checkpointSha: outcome.checkpointSha,
      });
      const types = (await eventsOf(r)).map((event) => event.type);
      expect(types.at(-1)).toBe('session.closed');
      // The tree was killed and nothing is running.
      expect(r.launcher.launched).toHaveLength(1);
      expect(r.launcher.launched[0]?.killTreeCalls).toBeGreaterThan(0);
      expect(r.launcher.running).toHaveLength(0);
      expect(r.pool.stats()).toEqual({ processes: 0, sessions: 0, queued: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never gives more than limits.demand_timeout_max',
    async () => {
      const r = await rig({ timeoutMaxMs: 500 });
      const running = r.runner.run(specOf(r, '#script:hang', { timeoutMs: 60_000 }));
      await untilHanging(r);
      await r.clock.advance(500);
      expect((await running).state).toBe('timed_out');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still ends the attempt when a process survives the kill',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang', { timeoutMs: 100 }));
      await until(() => r.launcher.launched.length === 1, 'the process');
      const process = r.launcher.launched[0];
      if (process === undefined) throw new Error('no process');
      process.leaveBehind = [4_999_999];
      await untilHanging(r);
      await r.clock.advance(100);
      expect((await running).state).toBe('timed_out');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, a process that survives the kill (P18b)', () => {
  it(
    'a stuck process on a shared process, with a child left alive, is told in session.processes_left',
    async () => {
      const r = await rig({ stuckNoEventMs: 5000 }, true);
      const running = r.runner.run(specOf(r, '#script:hang'));
      await until(() => r.launcher.launched.length === 1, 'the process');
      const process = r.launcher.launched[0];
      if (process === undefined) throw new Error('no process');
      process.leaveBehind = [4_999_999];
      await untilHanging(r);
      await r.clock.advance(5000);
      expect((await running).cause).toBe('stuck');
      const left = await eventsOf(r, 'session.processes_left');
      expect(left).toHaveLength(1);
      expect(left[0]?.payload).toMatchObject({
        sessionId: 'fake-session-1',
        pids: [4_999_999],
        playId: 'play-1',
        demandId: 'demand-1',
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, checkpoints', () => {
  it(
    'takes one per batch of edits',
    async () => {
      const r = await rig({ checkpointEditBatch: 2 });
      const outcome = await r.runner.run(
        specOf(r, editsPrompt({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, 'done')),
      );
      expect(outcome.state).toBe('completed');
      const checkpoints = await eventsOf(r, 'attempt.checkpoint');
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.payload).toMatchObject({
        reason: 'edit_batch',
        branch: outcome.branch,
      });
      const record = await r.store.attempts.get(outcome.attemptId);
      expect(record?.lastCheckpoint).toBe(outcome.checkpointSha);
      expect(record?.lastCheckpointAt).not.toBeNull();
      expect(await testGit(outcome.worktree, 'log', '--format=%s', 'main..HEAD')).toMatch(
        /^wip\(checkpoint\)/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'takes one every resume.checkpoint_every while the Executor works',
    async () => {
      const r = await rig({ checkpointEveryMs: 60_000 });
      const running = r.runner.run(
        specOf(r, editsPrompt({ 'a.txt': 'a\n' }, '#script:hang'), { timeoutMs: 600_000 }),
      );
      await untilHanging(r);
      await r.clock.advance(60_000);
      await until(async () => (await eventsOf(r, 'attempt.checkpoint')).length === 1, 'interval');
      expect((await eventsOf(r, 'attempt.checkpoint'))[0]?.payload).toMatchObject({
        reason: 'interval',
      });
      // Nothing new, nothing committed.
      await r.clock.advance(60_000);
      await r.clock.advance(60_000);
      expect(await eventsOf(r, 'attempt.checkpoint')).toHaveLength(1);
      await r.clock.advance(600_000);
      expect((await running).state).toBe('timed_out');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'takes none when the turn changes nothing',
    async () => {
      const r = await rig({ checkpointEditBatch: 1, checkpointEveryMs: 1000 });
      await r.runner.run(specOf(r, 'only talk'));
      expect(await eventsOf(r, 'attempt.checkpoint')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, native resume', () => {
  it(
    'reloads the conversation when the client process dies',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, editsPrompt({ 'a.txt': 'a\n' }, '#script:hang')));
      await untilHanging(r);
      r.launcher.launched[0]?.exit(137);
      const outcome = await running;

      expect(outcome).toMatchObject({ state: 'completed', resumes: 1 });
      expect(r.transport.loaded).toHaveLength(1);
      expect(r.transport.loaded[0]?.sessionId).toBe('fake-session-1');
      expect(r.launcher.launched).toHaveLength(2);
      expect(r.launcher.running).toHaveLength(0);
      // What the Executor had written was committed before the reload.
      expect(await testGit(outcome.worktree, 'show', 'HEAD:a.txt')).toBe('a');
      const types = (await eventsOf(r)).map((event) => event.type);
      expect(types).toContain('session.interrupted');
      expect(types).toContain('session.resumed');
      const resumed = (await eventsOf(r, 'session.resumed'))[0]?.payload;
      expect(resumed).toMatchObject({
        form: 'native',
        previousSessionId: 'fake-session-1',
        cause: 'client_crash',
      });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'completed',
        resumes: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'waits the transient backoff, then reloads',
    async () => {
      const r = await rig({ transientBackoffMs: [1000, 2000] });
      const running = r.runner.run(specOf(r, '#throw transient'));
      await until(
        async () => (await r.store.attempts.get('play-1/demand-1/1'))?.state === 'awaiting_resume',
        'the wait',
      );
      expect(r.transport.loaded).toHaveLength(0);
      await r.clock.advance(999);
      expect(r.transport.loaded).toHaveLength(0);
      await r.clock.advance(1);
      const outcome = await running;
      expect(outcome).toMatchObject({ state: 'completed', resumes: 1 });
      expect(r.transport.loaded).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'grows the wait with each resume',
    async () => {
      const r = await rig({
        transientBackoffMs: [1000, 2000],
        continuePrompt: '#throw transient',
        maxResumes: 2,
      });
      const running = r.runner.run(specOf(r, '#throw transient'));
      await until(async () => (await eventsOf(r, 'session.interrupted')).length === 1, 'first');
      await r.clock.advance(1000);
      await until(async () => (await eventsOf(r, 'session.interrupted')).length === 2, 'second');
      await r.clock.advance(1999);
      expect(r.transport.loaded).toHaveLength(1);
      await r.clock.advance(1);
      const outcome = await running;
      // The third failure meets max_resumes.
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'transient', resumes: 2 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops resuming at resume.max_resumes and waits for a decision',
    async () => {
      const r = await rig({ maxResumes: 1, continuePrompt: '#throw transient' });
      const outcome = await r.runner.run(specOf(r, '#throw transient'));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'transient',
        resumes: 1,
        needsDecision: true,
      });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'interrupted',
        cause: 'transient',
      });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'parks the attempt as stuck when the same interruption repeats',
    async () => {
      const r = await rig({
        maxResumes: 10,
        stuckSameErrorTimes: 3,
        continuePrompt: '#throw transient',
      });
      const outcome = await r.runner.run(specOf(r, '#throw transient'));
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'stuck', needsDecision: true });
      expect(outcome.resumes).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'parks the attempt when the client no longer has the conversation',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHanging(r);
      r.transport.failWith = new NotFound('the client has no such conversation');
      r.launcher.launched[0]?.exit(1);
      const outcome = await running;
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'client_crash',
        needsDecision: true,
      });
      expect(r.transport.loaded).toHaveLength(1);
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, causes that need a decision', () => {
  it(
    'parks an exhausted quota without resuming',
    async () => {
      const r = await rig();
      const outcome = await r.runner.run(
        specOf(r, editsPrompt({ 'a.txt': 'a\n' }, '#script:quota-signal')),
      );
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
        needsDecision: true,
        resumes: 0,
      });
      expect(r.transport.loaded).toHaveLength(0);
      expect(await testGit(outcome.worktree, 'show', 'HEAD:a.txt')).toBe('a');
      expect((await eventsOf(r, 'session.interrupted'))[0]?.payload).toMatchObject({
        cause: 'quota_exhausted',
        checkpointSha: outcome.checkpointSha,
      });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'kills an Executor that sends nothing for stuck.no_event_for',
    async () => {
      const r = await rig({ stuckNoEventMs: 5000 });
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHanging(r);
      await r.clock.advance(5000);
      const outcome = await running;
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'stuck', needsDecision: true });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, stop', () => {
  it(
    'leaves a running attempt waiting to be resumed by the next start',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, editsPrompt({ 'a.txt': 'a\n' }, '#script:hang')));
      await untilHanging(r);
      await r.runner.stop();
      const outcome = await running;
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'daemon_restart' });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'awaiting_resume',
        cause: 'daemon_restart',
        sessionId: 'fake-session-1',
      });
      expect(await testGit(outcome.worktree, 'show', 'HEAD:a.txt')).toBe('a');
      expect(r.launcher.running).toHaveLength(0);
      await expect(r.runner.run(specOf(r, 'late', { attempt: 2 }))).rejects.toThrow(/stopped/);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, the cancel of a session on a shared process (pool.shared_cancel)', () => {
  /** Two attempts on one shared process; `maxResumes: 0` so any charged resume would park. */
  async function shared(mode: SharedCancelMode): Promise<TestRig> {
    return rig({ maxResumes: 0, pool: { ...QUIET_SETTINGS.pool, sharedCancel: mode } }, true);
  }

  async function bothRunning(r: TestRig, first: string, second: string) {
    const a = r.runner.run(specOf(r, first, { timeoutMs: 1000 }));
    await until(() => r.pool.stats().sessions === 1, 'the first session');
    const b = r.runner.run(specOf(r, second, { attempt: 2 }));
    await until(() => r.pool.stats().sessions === 2, 'the second session');
    expect(r.launcher.launched).toHaveLength(1);
    return { a, b };
  }

  it(
    'escalate: a timeout the client ignores ends the process, and the sibling resumes without cost',
    async () => {
      const r = await shared('escalate');
      const { a, b } = await bothRunning(r, '#script:deaf', '#script:hang');
      await r.clock.advance(1000);
      const outcomeA = await a;
      expect(outcomeA).toMatchObject({ state: 'timed_out' });

      const escalated = await eventsOf(r, 'session.cancel_escalated');
      expect(escalated).toHaveLength(1);
      expect(escalated[0]?.payload).toMatchObject({
        mode: 'escalate',
        siblings: 1,
        pid: r.launcher.launched[0]?.pid,
        attemptId: outcomeA.attemptId,
      });
      expect(r.launcher.launched[0]?.killTreeCalls).toBeGreaterThan(0);

      // The sibling saw the process fall and went on through session/load, for free.
      const outcomeB = await b;
      expect(outcomeB).toMatchObject({ state: 'completed', resumes: 0 });
      expect(r.transport.loaded).toHaveLength(1);
      expect(r.launcher.launched).toHaveLength(2);
      const interrupted = (await eventsOf(r, 'session.interrupted')).filter(
        (event) => (event.payload as { cause?: string }).cause === 'client_crash',
      );
      expect((interrupted[0]?.payload as { detail?: string }).detail).toContain('another session');
      // Only the process of the resume is left, idle until the clock says otherwise.
      expect(r.launcher.running).toHaveLength(1);
      expect(r.pool.stats()).toEqual({ processes: 1, sessions: 0, queued: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The sibling hangs again after every resume (`continuePrompt`); a deaf attempt's timeout fells
   * it once. Returns the sibling's pending outcome in a box, so `await` does not wait for it.
   */
  async function felledOnce(r: TestRig) {
    const { a, b } = await bothRunning(r, '#script:deaf', '#script:hang');
    await r.clock.advance(1000);
    expect(await a).toMatchObject({ state: 'timed_out' });
    await until(() => r.transport.loaded.length === 1, 'the free resume');
    return { b };
  }

  async function secondDeaf(r: TestRig): Promise<void> {
    const c = r.runner.run(specOf(r, '#script:deaf', { attempt: 3, timeoutMs: 1000 }));
    await until(() => r.pool.stats().sessions === 2, 'the deaf attempt on the resumed process');
    await r.clock.advance(1000);
    expect(await c).toMatchObject({ state: 'timed_out' });
  }

  it(
    'max_free_resumes 0: no resume after another session cancel is free',
    async () => {
      const r = await rig(
        {
          maxResumes: 0,
          maxFreeResumes: 0,
          continuePrompt: '#script:hang',
          pool: { ...QUIET_SETTINGS.pool, sharedCancel: 'escalate' },
        },
        true,
      );
      const { a, b } = await bothRunning(r, '#script:deaf', '#script:hang');
      await r.clock.advance(1000);
      expect(await a).toMatchObject({ state: 'timed_out' });
      // It counts in max_resumes (0), so the attempt parks and nothing is reloaded.
      expect(await b).toMatchObject({
        state: 'interrupted',
        cause: 'client_crash',
        needsDecision: true,
        resumes: 0,
      });
      expect(r.transport.loaded).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'max_free_resumes 1: the second fall counts in max_resumes and parks the attempt at 0',
    async () => {
      const r = await rig(
        {
          maxResumes: 0,
          maxFreeResumes: 1,
          continuePrompt: '#script:hang',
          pool: { ...QUIET_SETTINGS.pool, sharedCancel: 'escalate' },
        },
        true,
      );
      const { b } = await felledOnce(r);
      await secondDeaf(r);
      expect(await b).toMatchObject({ state: 'interrupted', needsDecision: true, resumes: 0 });
      // Only the first resume went through.
      expect(r.transport.loaded).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'max_free_resumes 1: past the cap the resume is charged to max_resumes and goes on',
    async () => {
      const r = await rig(
        {
          maxResumes: 1,
          maxFreeResumes: 1,
          continuePrompt: '#script:hang',
          pool: { ...QUIET_SETTINGS.pool, sharedCancel: 'escalate' },
        },
        true,
      );
      const { b } = await felledOnce(r);
      expect((await r.store.attempts.get('play-1/demand-1/2'))?.resumes).toBe(0);
      await secondDeaf(r);
      await until(() => r.transport.loaded.length === 2, 'the charged resume');
      expect((await r.store.attempts.get('play-1/demand-1/2'))?.resumes).toBe(1);
      await r.runner.stop();
      expect(await b).toMatchObject({ state: 'interrupted', cause: 'daemon_restart' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'records each free resume in the registry (freeResumes), apart from resumes',
    async () => {
      const r = await rig(
        {
          maxResumes: 0,
          maxFreeResumes: 3,
          continuePrompt: '#script:hang',
          pool: { ...QUIET_SETTINGS.pool, sharedCancel: 'escalate' },
        },
        true,
      );
      const { b } = await felledOnce(r);
      expect(await r.store.attempts.get('play-1/demand-1/2')).toMatchObject({
        freeResumes: 1,
        resumes: 0,
      });
      await r.runner.stop();
      await b;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a restarted daemon continues from the free resumes recorded: 2 of 3 leaves one',
    async () => {
      const r = await rig(
        {
          maxResumes: 0,
          maxFreeResumes: 3,
          continuePrompt: '#script:hang',
          pool: { ...QUIET_SETTINGS.pool, sharedCancel: 'escalate' },
        },
        true,
      );
      const { b } = await felledOnce(r);
      // The daemon stops and "restarts": the registry says two free resumes were granted.
      await r.runner.stop();
      expect(await b).toMatchObject({ state: 'interrupted', cause: 'daemon_restart' });
      const stored = await r.store.attempts.get('play-1/demand-1/2');
      if (stored === undefined) throw new Error('no record');
      expect(stored.state).toBe('awaiting_resume');
      await r.store.attempts.put({ ...attemptInputOf(stored), freeResumes: 2 });
      const restarted = await r.store.attempts.get('play-1/demand-1/2');
      if (restarted === undefined) throw new Error('no record');

      const next = new AttemptRunner({
        store: r.store,
        vcs: defaultVcs(),
        pool: r.pool,
        clock: r.clock,
        settings: r.settings,
        worktreeRoot: r.worktreeRoot,
        logger: pino({ level: 'silent' }),
      });
      const resumed = next.resume(restarted, {
        profile: TEST_PROFILE,
        executor: { model: 'fake-model' },
        policy: TEST_POLICY,
      });
      await until(() => r.transport.loaded.length === 2, 'the reload after the restart');
      const deaf = async (attempt: number): Promise<void> => {
        const c = next.run(specOf(r, '#script:deaf', { attempt, timeoutMs: 1000 }));
        await until(() => r.pool.stats().sessions === 2, 'the deaf attempt on the shared process');
        await r.clock.advance(1000);
        expect(await c).toMatchObject({ state: 'timed_out' });
      };

      // The third free resume is the last one granted.
      await deaf(3);
      await until(() => r.transport.loaded.length === 3, 'the last free resume');
      expect(await r.store.attempts.get('play-1/demand-1/2')).toMatchObject({
        freeResumes: 3,
        resumes: 0,
      });
      // The next fall counts in max_resumes (0): the attempt parks.
      await deaf(4);
      expect(await resumed).toMatchObject({
        state: 'interrupted',
        cause: 'client_crash',
        needsDecision: true,
        resumes: 0,
      });
      expect(r.transport.loaded).toHaveLength(3);
      expect(await r.store.attempts.get('play-1/demand-1/2')).toMatchObject({ freeResumes: 3 });
    },
    TEST_TIMEOUT_MS,
  );

  it('the default allows three free resumes per attempt', () => {
    expect(QUIET_SETTINGS.maxFreeResumes).toBe(3);
  });

  it(
    'escalate: a timeout the client honours leaves the process and the sibling alone',
    async () => {
      const r = await shared('escalate');
      const { a, b } = await bothRunning(r, '#script:hang', '#script:hang');
      await r.clock.advance(1000);
      expect(await a).toMatchObject({ state: 'timed_out' });
      expect(await eventsOf(r, 'session.cancel_escalated')).toHaveLength(0);
      expect(r.launcher.running).toHaveLength(1);
      expect(r.pool.stats().sessions).toBe(1);
      await r.runner.stop();
      expect(await b).toMatchObject({ state: 'interrupted', cause: 'daemon_restart' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'always_kill: a timeout the client honours still ends the process',
    async () => {
      const r = await shared('always_kill');
      const { a, b } = await bothRunning(r, '#script:hang', '#script:hang');
      await r.clock.advance(1000);
      expect(await a).toMatchObject({ state: 'timed_out' });
      const escalated = await eventsOf(r, 'session.cancel_escalated');
      expect(escalated).toHaveLength(1);
      expect(escalated[0]?.payload).toMatchObject({ mode: 'always_kill', siblings: 1 });
      await until(() => r.launcher.launched.length === 2, 'the sibling to resume');
      await r.runner.stop();
      await b;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'release: not even a timeout the client ignores ends the shared process',
    async () => {
      const r = await shared('release');
      const { a, b } = await bothRunning(r, '#script:deaf', '#script:hang');
      await r.clock.advance(1000);
      expect(await a).toMatchObject({ state: 'timed_out' });
      expect(await eventsOf(r, 'session.cancel_escalated')).toHaveLength(0);
      expect(r.launcher.running).toHaveLength(1);
      expect(r.launcher.launched).toHaveLength(1);
      await r.runner.stop();
      expect(await b).toMatchObject({ state: 'interrupted', cause: 'daemon_restart' });
    },
    TEST_TIMEOUT_MS,
  );
});
