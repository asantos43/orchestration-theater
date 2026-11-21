// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '@otheater/core';
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

/**
 * N176: pause, resume and cancel of an attempt in flight. A pause interrupts the turn with the
 * cause `paused` and saves the checkpoint; the resume follows the policy of the cause; a cancel
 * ends the attempt as `cancelled`.
 */

const TEST_TIMEOUT_MS = 30_000;
const ATTEMPT = 'play-1/demand-1/1';

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
  // the turn that follows a resume hangs too, so the test decides when it ends
  const made = await makeRig(fakes(), { continuePrompt: '#script:hang', ...overrides });
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});

afterAll(disposeTestGitIsolation);

/** Waits until `n` turns of the Executor are hanging, counting across resumes. */
async function untilHangs(r: TestRig, n: number): Promise<void> {
  await until(
    async () =>
      (await eventsOf(r, 'session.update')).filter((event) =>
        JSON.stringify(event.payload).includes('hanging until session/cancel'),
      ).length >= n,
    `${String(n)} hanging turn(s)`,
  );
}

async function typesOf(r: TestRig): Promise<string[]> {
  return (await eventsOf(r)).map((event) => event.type);
}

describe('AttemptRunner, pause and resume of an Actor (N176)', () => {
  it(
    'pauses with the cause paused and the checkpoint, and resumes the same conversation',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, editsPrompt({ 'a.txt': 'a\n' }, '#script:hang')));
      await untilHangs(r, 1);

      expect(await r.runner.pauseAttempt(ATTEMPT, 'actor')).toBe(true);
      expect(await r.store.attempts.get(ATTEMPT)).toMatchObject({
        state: 'awaiting_resume',
        cause: 'paused',
        sessionId: 'fake-session-1',
      });
      // nothing runs while it is paused, and what the Executor wrote is committed
      expect(r.launcher.running).toHaveLength(0);
      expect(
        await testGit((await r.store.attempts.get(ATTEMPT))?.worktree ?? '', 'show', 'HEAD:a.txt'),
      ).toBe('a');
      const interrupted = await eventsOf(r, 'session.interrupted');
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]?.payload).toMatchObject({
        cause: 'paused',
        form: 'native',
        checkpointSha: expect.any(String) as string,
      });
      const paused = await eventsOf(r, 'attempt.paused');
      expect(paused[0]?.payload).toMatchObject({
        origin: 'actor',
        checkpointed: true,
        attemptId: ATTEMPT,
      });
      expect(await r.store.interruptions.list()).toMatchObject([
        { cause: 'paused', resumeForm: 'native', countedAsAttempt: false },
      ]);

      expect(r.runner.resumeAttempt(ATTEMPT, 'actor')).toBe(true);
      await untilHangs(r, 2);
      // the same conversation was loaded again, with the continue prompt
      expect(r.transport.loaded).toHaveLength(1);
      expect(r.transport.loaded[0]).toMatchObject({ sessionId: 'fake-session-1' });
      expect((await eventsOf(r, 'attempt.resumed'))[0]?.payload).toMatchObject({
        strategy: 'native',
      });
      expect((await eventsOf(r, 'session.resumed'))[0]?.payload).toMatchObject({
        form: 'native',
        cause: 'paused',
      });
      // a pause is not a failure: no resume and no attempt of the demand were spent
      expect((await r.store.attempts.get(ATTEMPT))?.resumes).toBe(0);
      expect(await typesOf(r)).toContain('attempt.paused');

      const outcome = await r.runner.cancelAttempt(ATTEMPT);
      expect(outcome.state).toBe('cancelled');
      await running;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the time paused does not run against the deadline of the attempt',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang', { timeoutMs: 1000 }));
      await untilHangs(r, 1);
      await r.runner.pauseAttempt(ATTEMPT, 'actor');
      await r.clock.advance(60_000);
      r.runner.resumeAttempt(ATTEMPT, 'actor');
      await untilHangs(r, 2);
      // paused for a minute and still alive: the deadline moved forward by the pause
      await r.clock.advance(500);
      expect((await r.store.attempts.get(ATTEMPT))?.state).toBe('executing');
      await r.clock.advance(500);
      expect(await running).toMatchObject({ state: 'timed_out', cause: 'timeout' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses what does not make sense: a second pause, a resume of what runs, an unknown attempt',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      expect(() => r.runner.resumeAttempt(ATTEMPT, 'actor')).toThrow(Conflict);
      await r.runner.pauseAttempt(ATTEMPT, 'actor');
      await expect(r.runner.pauseAttempt(ATTEMPT, 'actor')).rejects.toBeInstanceOf(Conflict);
      await expect(r.runner.pauseAttempt('play-1/ghost/1', 'actor')).rejects.toBeInstanceOf(
        Conflict,
      );
      expect(() => r.runner.resumeAttempt('play-1/ghost/1', 'actor')).toThrow(Conflict);
      await r.runner.cancelAttempt(ATTEMPT);
      await running;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a pause of the play and a pause of the Actor do not wake each other',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      await r.runner.pauseAttempt(ATTEMPT, 'play');
      expect(r.runner.attemptsOfPlay('play-1')).toEqual([{ attemptId: ATTEMPT, paused: 'play' }]);
      // the play pausing what is paused already changes nothing
      expect(await r.runner.pauseAttempt(ATTEMPT, 'play')).toBe(true);
      // a person is told to resume the play instead
      expect(() => r.runner.resumeAttempt(ATTEMPT, 'actor')).toThrow(Conflict);
      expect(r.runner.resumeAttempt(ATTEMPT, 'play')).toBe(true);
      await untilHangs(r, 2);
      expect((await eventsOf(r, 'attempt.paused'))[0]?.payload).toMatchObject({ origin: 'play' });

      await r.runner.pauseAttempt(ATTEMPT, 'actor');
      // the resume of the play leaves what a person paused as it is
      expect(r.runner.resumeAttempt(ATTEMPT, 'play')).toBe(false);
      expect(r.runner.attemptsOfPlay('play-1')[0]?.paused).toBe('actor');
      await r.runner.cancelAttempt(ATTEMPT);
      await running;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a resume that comes before the pause took hold withdraws it',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      const pausing = r.runner.pauseAttempt(ATTEMPT, 'play');
      expect(r.runner.resumeAttempt(ATTEMPT, 'play')).toBe(true);
      expect(await pausing).toBe(false);
      await untilHangs(r, 2);
      expect(await eventsOf(r, 'attempt.resumed')).toHaveLength(1);
      expect(r.runner.attemptsOfPlay('play-1')[0]?.paused).toBeUndefined();
      await r.runner.cancelAttempt(ATTEMPT);
      await running;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a stop of the daemon while it is paused leaves it awaiting_resume with the cause paused',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      await r.runner.pauseAttempt(ATTEMPT, 'actor');
      await r.runner.stop();
      expect(await running).toMatchObject({ state: 'interrupted', cause: 'paused' });
      expect(await r.store.attempts.get(ATTEMPT)).toMatchObject({
        state: 'awaiting_resume',
        cause: 'paused',
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner, cancel of an Actor (N176)', () => {
  it(
    'ends the attempt as cancelled with the work kept, and asks for a decision',
    async () => {
      const r = await rig();
      const running = r.runner.run(
        specOf(r, editsPrompt({ 'wip.txt': 'draft\n' }, '#script:hang')),
      );
      await untilHangs(r, 1);
      const outcome = await r.runner.cancelAttempt(ATTEMPT);
      expect(outcome).toMatchObject({
        state: 'cancelled',
        cause: 'cancelled',
        needsDecision: true,
        countsAsAttempt: false,
      });
      expect(await running).toMatchObject({ state: 'cancelled' });
      expect(await r.store.attempts.get(ATTEMPT)).toMatchObject({ state: 'cancelled' });
      expect(await testGit(outcome.worktree, 'show', 'HEAD:wip.txt')).toBe('draft');
      expect(r.launcher.running).toHaveLength(0);
      expect(await eventsOf(r, 'attempt.cancelled')).toHaveLength(1);
      expect((await eventsOf(r, 'session.closed')).at(-1)?.payload).toMatchObject({
        reason: 'cancelled',
      });
      expect(r.runner.active).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels an attempt that is paused',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      await r.runner.pauseAttempt(ATTEMPT, 'actor');
      const outcome = await r.runner.cancelAttempt(ATTEMPT);
      expect(outcome.state).toBe('cancelled');
      expect((await running).state).toBe('cancelled');
      expect(await r.store.attempts.get(ATTEMPT)).toMatchObject({ state: 'cancelled' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to cancel what is not running',
    async () => {
      const r = await rig();
      await expect(r.runner.cancelAttempt('play-1/ghost/1')).rejects.toBeInstanceOf(Conflict);
    },
    TEST_TIMEOUT_MS,
  );
});
