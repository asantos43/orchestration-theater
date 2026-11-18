// SPDX-License-Identifier: MPL-2.0
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { QuotaStatus } from '../quota/state.js';
import type { LimitHit } from '../quota/service.js';
import { eventsOf, makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';
import type { AttemptRunnerOptions } from './attempt-runner.js';
import type { ExecutionSettings } from './settings.js';

/**
 * P17: what the runner does with the policy of 5.16: the `interruptions` row of each cause, the
 * cause and the reset time on `session.interrupted`, and the action the outcome carries. The
 * table of the policy itself is in `interruption-policy.test.ts`.
 */

const TEST_TIMEOUT_MS = 30_000;
const MINUTE = 60_000;
const PROFILE = 'fake/one';
const EXECUTOR = 'fake-model@fake/one';

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

async function rig(
  overrides: Partial<ExecutionSettings> = {},
  quota?: AttemptRunnerOptions['quota'],
): Promise<TestRig> {
  const made = await makeRig(fakes(), overrides, undefined, quota);
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});

afterAll(disposeTestGitIsolation);

/** A `QuotaService` that answers every limit hit with `status()` and remembers what it was told. */
function quotaSaying(status: () => Partial<QuotaStatus>): {
  service: NonNullable<AttemptRunnerOptions['quota']>;
  hits: { target: unknown; hit: LimitHit }[];
} {
  const hits: { target: unknown; hit: LimitHit }[] = [];
  return {
    hits,
    service: {
      ingestLimitHit: (target, hit) => {
        hits.push({ target, hit });
        return Promise.resolve({
          profile: PROFILE,
          state: 'exhausted',
          cause: 'quota',
          untilReset: null,
          windows: [],
          observedAt: null,
          nearLimitWindow: null,
          reason: 'a limit was hit',
          ...status(),
        } satisfies QuotaStatus);
      },
    },
  };
}

async function rowsOf(r: TestRig) {
  return r.store.interruptions.list();
}

/** Waits until `n` turns of the Executor are hanging (`#script:hang`), counting across resumes. */
async function untilHangs(r: TestRig, n: number): Promise<void> {
  await until(
    async () =>
      (await eventsOf(r, 'session.update')).filter((event) =>
        JSON.stringify(event.payload).includes('hanging until session/cancel'),
      ).length >= n,
    `${String(n)} hanging turn(s)`,
  );
}

describe('AttemptRunner and the policy of 5.16, quota_exhausted', () => {
  it(
    'is a handoff whenever the quota runs out, and the row says so (N126)',
    async () => {
      const r = await rig();
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal'));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
        needsDecision: true,
        countsAsAttempt: false,
        decision: { action: 'handoff', form: 'handoff', cause: 'quota_exhausted' },
      });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
      });
      const rows = await rowsOf(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'X1',
        sessionId: 'fake-session-1',
        playId: 'play-1',
        cause: 'quota_exhausted',
        resumeForm: 'handoff',
        fromExecutor: EXECUTOR,
        toExecutor: null,
        countedAsAttempt: false,
      });
      expect(rows[0]?.signals).toContain('action:handoff');
      expect(r.transport.loaded).toHaveLength(0);
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hands the limit error to the QuotaService under the profile of the attempt',
    async () => {
      const quota = quotaSaying(() => ({}));
      const r = await rig({}, quota.service);
      await r.runner.run(specOf(r, '#script:quota-signal'));
      expect(quota.hits).toHaveLength(1);
      expect(quota.hits[0]?.target).toBe(PROFILE);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with when_exhausted wait and a near reset, the action is to wait and the event carries the time',
    async () => {
      let now = 0;
      const quota = quotaSaying(() => ({ untilReset: now + 10 * MINUTE }));
      const r = await rig({}, quota.service);
      now = r.clock.now();
      const outcome = await r.runner.run(
        specOf(r, '#script:quota-signal', { whenExhausted: 'wait' }),
      );
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
        needsDecision: true,
        decision: { action: 'wait_for_reset', form: 'native', resetsAt: now + 10 * MINUTE },
      });
      expect((await eventsOf(r, 'session.interrupted'))[0]?.payload).toMatchObject({
        cause: 'quota_exhausted',
        resetsAt: now + 10 * MINUTE,
      });
      const rows = await rowsOf(r);
      expect(rows[0]).toMatchObject({ resumeForm: 'native', countedAsAttempt: false });
      expect(rows[0]?.signals).toEqual(
        expect.arrayContaining(['quota_state:exhausted', 'action:wait_for_reset']),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with when_exhausted wait and a far reset, the action is a handoff',
    async () => {
      let now = 0;
      const quota = quotaSaying(() => ({ untilReset: now + 5 * 60 * MINUTE }));
      const r = await rig({}, quota.service);
      now = r.clock.now();
      const outcome = await r.runner.run(
        specOf(r, '#script:quota-signal', { whenExhausted: 'wait' }),
      );
      expect(outcome.decision).toMatchObject({ action: 'handoff', form: 'handoff' });
      expect((await rowsOf(r))[0]).toMatchObject({ resumeForm: 'handoff' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with when_exhausted wait and no known reset, the action is a handoff',
    async () => {
      const quota = quotaSaying(() => ({ untilReset: null }));
      const r = await rig({}, quota.service);
      const outcome = await r.runner.run(
        specOf(r, '#script:quota-signal', { whenExhausted: 'wait' }),
      );
      expect(outcome.decision).toMatchObject({ action: 'handoff', resetsAt: null });
      expect((await eventsOf(r, 'session.interrupted'))[0]?.payload).not.toHaveProperty('resetsAt');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a limit of the spending cap is its own cause, and in_flight picks the action',
    async () => {
      const cases = [
        { inFlight: 'handoff', action: 'handoff' },
        { inFlight: 'finish', action: 'finish_session' },
        { inFlight: 'stop', action: 'ask_producer' },
      ] as const;
      for (const { inFlight, action } of cases) {
        const cap = quotaSaying(() => ({ cause: 'budget' }));
        const r = await rig({}, cap.service);
        const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { inFlight }));
        expect(outcome).toMatchObject({
          state: 'interrupted',
          cause: 'spend_cap',
          needsDecision: true,
          countsAsAttempt: false,
          decision: { cause: 'spend_cap', action },
        });
        expect((await eventsOf(r, 'session.interrupted'))[0]?.payload).toMatchObject({
          cause: 'spend_cap',
        });
        expect((await rowsOf(r))[0]).toMatchObject({ cause: 'spend_cap' });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'when the QuotaService fails the attempt is still classified, with no reset time',
    async () => {
      const r = await rig(
        {},
        { ingestLimitHit: () => Promise.reject(new Error('the store is gone')) },
      );
      const outcome = await r.runner.run(
        specOf(r, '#script:quota-signal', { whenExhausted: 'wait' }),
      );
      expect(outcome.decision).toMatchObject({ action: 'handoff', cause: 'quota_exhausted' });
      expect(await rowsOf(r)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner and the policy of 5.16, transient', () => {
  it(
    'resumes in place, with a native row that costs no attempt',
    async () => {
      const r = await rig();
      const outcome = await r.runner.run(specOf(r, '#throw transient'));
      expect(outcome).toMatchObject({ state: 'completed', resumes: 1 });
      const rows = await rowsOf(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        cause: 'transient',
        resumeForm: 'native',
        countedAsAttempt: false,
      });
      expect(rows[0]?.signals).toContain('action:resume_native');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'past resume.max_resumes the case goes to the Director, and the row has no form',
    async () => {
      const r = await rig({ maxResumes: 1, continuePrompt: '#throw transient' });
      const outcome = await r.runner.run(specOf(r, '#throw transient'));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'transient',
        resumes: 1,
        needsDecision: true,
        decision: { action: 'director_judgment', cause: 'transient' },
      });
      const rows = await rowsOf(r);
      expect(rows.map((row) => row.resumeForm)).toEqual(['native', null]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with transient_exhausted handoff, the step after the list is a handoff',
    async () => {
      const r = await rig({
        transientBackoffMs: [0],
        transientExhausted: 'handoff',
        maxResumes: 10,
        continuePrompt: '#throw transient',
      });
      const outcome = await r.runner.run(specOf(r, '#throw transient'));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'transient',
        resumes: 1,
        needsDecision: true,
        decision: { action: 'handoff', form: 'handoff' },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the same error again and again is a stuck agent: a handoff to another Executor that counts',
    async () => {
      const r = await rig({
        maxResumes: 10,
        stuckSameErrorTimes: 3,
        continuePrompt: '#throw transient',
      });
      const outcome = await r.runner.run(specOf(r, '#throw transient'));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'stuck',
        resumes: 2,
        countsAsAttempt: true,
        decision: { action: 'handoff', differentExecutor: true },
      });
      const rows = await rowsOf(r);
      expect(rows.map((row) => row.cause)).toEqual(['transient', 'transient', 'stuck']);
      expect(rows[2]).toMatchObject({ resumeForm: 'handoff', countedAsAttempt: true });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner and the policy of 5.16, client_crash', () => {
  it(
    'the first drop costs no attempt, the next ones do, and past max_resumes the Director decides',
    async () => {
      const r = await rig({ maxResumes: 2, continuePrompt: '#script:hang' });
      const running = r.runner.run(specOf(r, '#script:hang'));
      for (const index of [0, 1, 2]) {
        await untilHangs(r, index + 1);
        r.launcher.launched[index]?.exit(137);
      }
      const outcome = await running;
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'client_crash',
        resumes: 2,
        needsDecision: true,
        countsAsAttempt: true,
        decision: { action: 'director_judgment' },
      });
      const rows = await rowsOf(r);
      expect(rows.map((row) => [row.cause, row.resumeForm, row.countedAsAttempt])).toEqual([
        ['client_crash', 'native', false],
        ['client_crash', 'native', true],
        ['client_crash', null, true],
      ]);
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with client_crash_counts never, no drop counts',
    async () => {
      const r = await rig({
        maxResumes: 2,
        clientCrashCounts: 'never',
        continuePrompt: '#script:hang',
      });
      const running = r.runner.run(specOf(r, '#script:hang'));
      for (const index of [0, 1, 2]) {
        await untilHangs(r, index + 1);
        r.launcher.launched[index]?.exit(137);
      }
      const outcome = await running;
      expect(outcome).toMatchObject({ cause: 'client_crash', countsAsAttempt: false });
      expect((await rowsOf(r)).map((row) => row.countedAsAttempt)).toEqual([false, false, false]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with client_crash_counts always, even the first drop counts',
    async () => {
      const r = await rig({ clientCrashCounts: 'always', continuePrompt: '#script:hang' });
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      r.launcher.launched[0]?.exit(137);
      await untilHangs(r, 2);
      expect((await rowsOf(r))[0]).toMatchObject({ countedAsAttempt: true, resumeForm: 'native' });
      await r.runner.stop();
      await running;
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AttemptRunner and the policy of 5.16, the other causes', () => {
  it(
    'timeout: the Director judges, the row has the handoff form and it costs an attempt',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang', { timeoutMs: 1000 }));
      await untilHangs(r, 1);
      await r.clock.advance(1000);
      const outcome = await running;
      expect(outcome).toMatchObject({
        state: 'timed_out',
        cause: 'timeout',
        needsDecision: true,
        countsAsAttempt: true,
        decision: { action: 'director_judgment', form: 'handoff' },
      });
      expect(await rowsOf(r)).toMatchObject([
        { cause: 'timeout', resumeForm: 'handoff', countedAsAttempt: true },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stuck (nothing for stuck.no_event_for): a handoff to another Executor that costs an attempt',
    async () => {
      const r = await rig({ stuckNoEventMs: 5000 });
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      await r.clock.advance(5000);
      const outcome = await running;
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'stuck',
        needsDecision: true,
        countsAsAttempt: true,
        decision: { action: 'handoff', differentExecutor: true },
      });
      const rows = await rowsOf(r);
      expect(rows[0]).toMatchObject({
        cause: 'stuck',
        resumeForm: 'handoff',
        countedAsAttempt: true,
      });
      expect(rows[0]?.signals).toContain('no_event_for:5000ms');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'daemon_restart (the daemon stops): a row that costs no attempt',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await untilHangs(r, 1);
      await r.runner.stop();
      const outcome = await running;
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'daemon_restart',
        countsAsAttempt: false,
      });
      const rows = await rowsOf(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ cause: 'daemon_restart', countedAsAttempt: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a completed attempt leaves no row and counts for nothing',
    async () => {
      const r = await rig();
      const outcome = await r.runner.run(specOf(r, 'hello'));
      expect(outcome).toMatchObject({ state: 'completed', countsAsAttempt: false });
      expect(outcome.decision).toBeUndefined();
      expect(await rowsOf(r)).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
