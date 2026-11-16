// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCheckpointMessage, NotFound } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { editsPrompt } from '../test-helpers.js';
import { eventsOf, makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';
import type { ExecutionSettings } from './settings.js';

const TEST_TIMEOUT_MS = 30_000;

function fakes() {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport: new FakeSessionTransport(),
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    }),
  } satisfies RigParts;
}

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];

async function rig(overrides: Partial<ExecutionSettings> = {}): Promise<TestRig> {
  const made = await makeRig(fakes(), overrides);
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
