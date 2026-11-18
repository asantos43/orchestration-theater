// SPDX-License-Identifier: MPL-2.0
import { NotFound, type Profile } from '@otheater/core';
import {
  FAKE_CLOCK_START,
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import type { QuotaCause } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { defaultVcs } from '../compose.js';
import type { QuotaStatus } from '../quota/state.js';
import { TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { AttemptRunner, type AttemptRunnerOptions } from './attempt-runner.js';
import { eventsOf, makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';
import type { ExhaustionPort, ExhaustionRules } from './exhaustion.js';
import type { HandoffPort } from './handoff.js';
import { reconcileAttempts } from './reconcile.js';
import type { ExecutionSettings } from './settings.js';

/**
 * P19: the wait for the reset of a quota or of a spending cap (architecture 5.16, "Retomada quando
 * a cota ou o teto voltam"): `AWAITING_RESUME` with the wakeup of P9, the native resume on the
 * restore hook, the baton when the wait does not pay, and the restart of the daemon in the middle.
 * The clock is the fake one and the client is the fake agent; the quota is a stub the test flips.
 */

const TEST_TIMEOUT_MS = 30_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PROFILE = TEST_PROFILE.id;
const ID_ONE = 'fake-model@fake/one';
const ID_TWO = 'fake-model@fake/two';
const TWO: Profile = { client: 'fake', profile: 'two', id: 'fake/two', dir: '/profiles/fake/two' };

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

type Parts = ReturnType<typeof fakes>;
type TestRig = Rig<Parts>;

const rigs: TestRig[] = [];

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});

afterAll(disposeTestGitIsolation);

/** A `QuotaService` whose profile is exhausted until the test says it is back. */
function quotaOf(
  resetAfterMs: number | null,
  cause: QuotaCause = 'quota',
): {
  service: NonNullable<AttemptRunnerOptions['quota']>;
  back(): void;
  asked: () => number;
} {
  let exhausted = true;
  let asked = 0;
  const status = (): QuotaStatus => ({
    profile: PROFILE,
    state: exhausted ? 'exhausted' : 'ok',
    cause: exhausted ? cause : null,
    untilReset: exhausted && resetAfterMs !== null ? FAKE_CLOCK_START + resetAfterMs : null,
    windows: [],
    observedAt: null,
    nearLimitWindow: null,
    reason: 'a limit was hit',
  });
  return {
    service: {
      ingestLimitHit: () => Promise.resolve(status()),
      statusOf: () => {
        asked += 1;
        return Promise.resolve(status());
      },
    },
    back: () => {
      exhausted = false;
    },
    asked: () => asked,
  };
}

async function rig(
  options: {
    settings?: Partial<ExecutionSettings>;
    quota?: AttemptRunnerOptions['quota'];
    handoff?: (parts: Parts) => HandoffPort;
    exhaustion?: ExhaustionPort;
  } = {},
): Promise<TestRig> {
  const parts = fakes();
  const made = await makeRig(
    parts,
    options.settings,
    undefined,
    options.quota,
    options.handoff?.(parts),
    options.exhaustion,
  );
  rigs.push(made);
  return made;
}

/** A port that hands the work to `fake/two`, and remembers who asked. */
function twoPort(onChoose?: () => void): { port: HandoffPort; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    port: {
      prefixOf: () => 'ROLE PREFIX',
      choose: (request) => {
        asked.push(request.cause);
        onChoose?.();
        return Promise.resolve({
          kind: 'selected' as const,
          target: {
            executorId: ID_TWO,
            profile: TWO,
            executor: { model: 'fake-model' },
            policy: TEST_POLICY,
          },
        });
      },
      secretPaths: [],
    },
  };
}

async function seedPlay(store: Store): Promise<void> {
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play.default',
    name: 'wait',
    folder: '/work/wait',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: 'play-1',
    scenarioId: 's1',
    need: 'wait for the reset',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
  });
}

type Store = InstanceType<typeof InMemoryStore>;

async function untilWaiting(r: TestRig): Promise<void> {
  await until(
    async () => (await eventsOf(r, 'attempt.reset_wait_started')).length > 0,
    'the attempt to wait for the reset',
  );
}

const WAIT = { whenExhausted: 'wait' } as const;

describe('AttemptRunner waiting for the reset (P19)', () => {
  it(
    'waits in awaiting_resume, then resumes natively on the restore hook, with no attempt spent',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const r = await rig({ quota: quota.service });
      await seedPlay(r.store);
      const running = r.runner.run(specOf(r, '#script:quota-signal', { ...WAIT, role: 'actor' }));
      await untilWaiting(r);

      const waiting = await r.store.attempts.get('play-1/demand-1/1');
      expect(waiting).toMatchObject({ state: 'awaiting_resume', cause: 'quota_exhausted' });
      expect((await eventsOf(r, 'attempt.reset_wait_started'))[0]?.payload).toMatchObject({
        cause: 'quota_exhausted',
        resetsAt: FAKE_CLOCK_START + 10 * MINUTE,
        maxWaitMs: 10 * MINUTE + 60_000,
        afterRestart: false,
        role: 'actor',
      });
      // The chat sees the wait.
      const messages = await eventsOf(r, 'scenario.system_message');
      expect(messages[0]?.payload).toMatchObject({
        kind: 'reset_wait',
        cause: 'quota_exhausted',
        role: 'actor',
        resetsAt: FAKE_CLOCK_START + 10 * MINUTE,
      });
      // Nothing was loaded yet, and the hook of the wrong cause wakes nobody.
      expect(r.transport.loaded).toHaveLength(0);
      expect(r.runner.restored(PROFILE, ['budget'])).toBe(0);
      expect(r.runner.restored('fake/other', ['quota'])).toBe(0);

      quota.back();
      await r.clock.advance(10 * MINUTE);
      expect(r.runner.restored(PROFILE, ['quota'])).toBe(1);
      const outcome = await running;

      expect(outcome).toMatchObject({ state: 'completed', attemptId: 'play-1/demand-1/1' });
      expect(r.transport.loaded).toHaveLength(1);
      expect(r.transport.loaded[0]?.sessionId).toBe('fake-session-1');
      expect(r.transport.opened).toHaveLength(1);
      expect((await eventsOf(r, 'session.resumed'))[0]?.payload).toMatchObject({
        form: 'native',
        cause: 'quota_exhausted',
      });
      expect((await eventsOf(r, 'attempt.reset_wait_ended'))[0]?.payload).toMatchObject({
        cause: 'quota_exhausted',
        outcome: 'restored',
        waitedMs: 10 * MINUTE,
      });
      // The wait is a resume of the conversation, not an attempt of the demand.
      const record = await r.store.attempts.get('play-1/demand-1/1');
      expect(record?.resumes).toBe(1);
      const rows = await r.store.interruptions.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        cause: 'quota_exhausted',
        resumeForm: 'native',
        countedAsAttempt: false,
      });
      // A second hook finds nobody: idempotent.
      expect(r.runner.restored(PROFILE, ['quota'])).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resume.quota_wait_counts free keeps the resume counter where it was',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const r = await rig({ quota: quota.service, settings: { quotaWaitCounts: 'free' } });
      const running = r.runner.run(specOf(r, '#script:quota-signal', WAIT));
      await untilWaiting(r);
      quota.back();
      expect(r.runner.restored(PROFILE, ['quota'])).toBe(1);
      expect(await running).toMatchObject({ state: 'completed' });
      expect((await r.store.attempts.get('play-1/demand-1/1'))?.resumes).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a hook that never comes is covered by the clock: past the reset the profile is read',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const r = await rig({ quota: quota.service });
      const running = r.runner.run(specOf(r, '#script:quota-signal', WAIT));
      await untilWaiting(r);
      quota.back();
      await r.clock.advance(10 * MINUTE + 60_000);
      expect(await running).toMatchObject({ state: 'completed' });
      expect(r.transport.loaded).toHaveLength(1);
      expect((await eventsOf(r, 'attempt.reset_wait_ended'))[0]?.payload).toMatchObject({
        outcome: 'restored',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a profile that is already back when the wait starts is resumed at once',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      // Exhausted for the limit hit, back for the first read of the wait.
      const hit = quota.service.ingestLimitHit.bind(quota.service);
      const r = await rig({
        quota: {
          ingestLimitHit: async (target, limit) => {
            const status = await hit(target, limit);
            quota.back();
            return status;
          },
          ...(quota.service.statusOf === undefined ? {} : { statusOf: quota.service.statusOf }),
        },
      });
      expect(await r.runner.run(specOf(r, '#script:quota-signal', WAIT))).toMatchObject({
        state: 'completed',
      });
      expect((await eventsOf(r, 'attempt.reset_wait_ended'))[0]?.payload).toMatchObject({
        outcome: 'restored',
        waitedMs: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a reset farther than resume.quota_wait_max is a baton, not a wait',
    async () => {
      const quota = quotaOf(2 * HOUR);
      const sent = twoPort();
      const r = await rig({ quota: quota.service, handoff: () => sent.port });
      await seedPlay(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', WAIT));
      expect(outcome).toMatchObject({ state: 'completed' });
      expect(outcome.handoffs[0]).toMatchObject({ from: ID_ONE, to: ID_TWO });
      expect(await eventsOf(r, 'attempt.reset_wait_started')).toHaveLength(0);
      expect(r.transport.loaded).toHaveLength(0);
      expect(sent.asked).toEqual(['quota_exhausted']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the rule next is a baton even when the reset is near',
    async () => {
      const quota = quotaOf(5 * MINUTE);
      const sent = twoPort();
      const r = await rig({ quota: quota.service, handoff: () => sent.port });
      await seedPlay(r.store);
      const outcome = await r.runner.run(
        specOf(r, '#script:quota-signal', { whenExhausted: 'next' }),
      );
      expect(outcome.handoffs).toHaveLength(1);
      expect(await eventsOf(r, 'attempt.reset_wait_started')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the rule of the role comes from the exhaustion port when the spec does not say',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const asked: string[] = [];
      const r = await rig({
        quota: quota.service,
        exhaustion: {
          rulesOf: (request) => {
            asked.push(`${request.playId}/${request.role ?? '-'}/${request.profile.id}`);
            return Promise.resolve({ whenExhausted: 'wait' } satisfies ExhaustionRules);
          },
        },
      });
      const running = r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      await untilWaiting(r);
      quota.back();
      r.runner.restored(PROFILE, ['quota']);
      expect(await running).toMatchObject({ state: 'completed' });
      expect(asked).toEqual([`play-1/actor/${PROFILE}`]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'an exhaustion port that fails leaves the defaults and a play.notice',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const r = await rig({
        quota: quota.service,
        exhaustion: { rulesOf: () => Promise.reject(new Error('the budget is gone')) },
      });
      await seedPlay(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal'));
      expect(outcome.decision).toMatchObject({ action: 'handoff' });
      const notices = await eventsOf(r, 'play.notice');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.payload).toMatchObject({
        kind: 'exhaustion_not_read',
        playId: 'play-1',
      });
      expect(JSON.stringify(notices[0]?.payload)).toContain('the budget is gone');
      const rows = await r.store.interruptions.list();
      expect(rows[0]?.signals).toContain('exhaustion_rules:failed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a wait that ends with the profile still out is a baton (resume.quota_wait_missed handoff)',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const sent = twoPort();
      const r = await rig({ quota: quota.service, handoff: () => sent.port });
      await seedPlay(r.store);
      const running = r.runner.run(specOf(r, '#script:quota-signal', WAIT));
      await untilWaiting(r);
      await r.clock.advance(10 * MINUTE + 60_000);
      const outcome = await running;
      expect(outcome).toMatchObject({ state: 'completed' });
      expect(outcome.handoffs[0]).toMatchObject({ from: ID_ONE, to: ID_TWO });
      expect((await eventsOf(r, 'attempt.reset_wait_ended'))[0]?.payload).toMatchObject({
        outcome: 'missed',
      });
      expect(r.transport.loaded).toHaveLength(0);
      const rows = await r.store.interruptions.list();
      expect(rows[0]).toMatchObject({ resumeForm: 'handoff', toExecutor: ID_TWO });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resume.quota_wait_missed park leaves the attempt for a decision',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const sent = twoPort();
      const r = await rig({
        quota: quota.service,
        handoff: () => sent.port,
        settings: { quotaWaitMissed: 'park' },
      });
      const running = r.runner.run(specOf(r, '#script:quota-signal', WAIT));
      await untilWaiting(r);
      await r.clock.advance(10 * MINUTE + 60_000);
      const outcome = await running;
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'quota_exhausted' });
      expect(sent.asked).toHaveLength(0);
      expect(await r.store.attempts.get('play-1/demand-1/1')).toMatchObject({
        state: 'interrupted',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a session/load that fails after the wait becomes a baton',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      let transport: Parts['transport'] | undefined;
      const sent = twoPort(() => {
        if (transport !== undefined) transport.failWith = undefined;
      });
      const r = await rig({
        quota: quota.service,
        handoff: (parts) => {
          transport = parts.transport;
          return sent.port;
        },
      });
      await seedPlay(r.store);
      const running = r.runner.run(specOf(r, '#script:quota-signal', WAIT));
      await untilWaiting(r);
      r.transport.failWith = new NotFound('no such conversation');
      quota.back();
      r.runner.restored(PROFILE, ['quota']);
      const outcome = await running;
      expect(outcome).toMatchObject({ state: 'completed' });
      expect(outcome.handoffs).toHaveLength(1);
      expect(r.transport.loaded).toHaveLength(1);
      expect(sent.asked).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the spending cap with on_exceeded wait and in_flight handoff waits for the reset too',
    async () => {
      const quota = quotaOf(10 * MINUTE, 'budget');
      const r = await rig({
        quota: quota.service,
        exhaustion: {
          rulesOf: () =>
            Promise.resolve({ inFlight: 'handoff', waitForCap: true } satisfies ExhaustionRules),
        },
      });
      await seedPlay(r.store);
      const running = r.runner.run(specOf(r, '#script:quota-signal'));
      await untilWaiting(r);
      expect((await eventsOf(r, 'attempt.reset_wait_started'))[0]?.payload).toMatchObject({
        cause: 'spend_cap',
      });
      expect((await eventsOf(r, 'scenario.system_message'))[0]?.payload).toMatchObject({
        kind: 'reset_wait',
        cause: 'spend_cap',
      });
      // The quota coming back does not end the wait for a cap.
      expect(r.runner.restored(PROFILE, ['quota'])).toBe(0);
      quota.back();
      expect(r.runner.restored(PROFILE, ['budget'])).toBe(1);
      expect(await running).toMatchObject({ state: 'completed' });
      expect((await eventsOf(r, 'session.resumed'))[0]?.payload).toMatchObject({
        form: 'native',
        cause: 'spend_cap',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the spending cap with in_flight finish or stop never waits',
    async () => {
      for (const inFlight of ['finish', 'stop'] as const) {
        const quota = quotaOf(10 * MINUTE, 'budget');
        const r = await rig({
          quota: quota.service,
          exhaustion: {
            rulesOf: () =>
              Promise.resolve({ inFlight, waitForCap: true } satisfies ExhaustionRules),
          },
        });
        const outcome = await r.runner.run(specOf(r, '#script:quota-signal'));
        expect(outcome).toMatchObject({ state: 'interrupted', cause: 'spend_cap' });
        expect(await eventsOf(r, 'attempt.reset_wait_started')).toHaveLength(0);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the wait does not run the deadline (pause) unless resume.quota_wait_deadline says count',
    async () => {
      const paused = quotaOf(10 * MINUTE);
      const a = await rig({ quota: paused.service, settings: { timeoutMs: 5 * MINUTE } });
      const waiting = a.runner.run(specOf(a, '#script:quota-signal', WAIT));
      await untilWaiting(a);
      await a.clock.advance(10 * MINUTE);
      paused.back();
      a.runner.restored(PROFILE, ['quota']);
      expect(await waiting).toMatchObject({ state: 'completed' });

      const counted = quotaOf(10 * MINUTE);
      const b = await rig({
        quota: counted.service,
        settings: { timeoutMs: 5 * MINUTE, quotaWaitDeadline: 'count' },
      });
      const timing = b.runner.run(specOf(b, '#script:quota-signal', WAIT));
      await untilWaiting(b);
      await b.clock.advance(5 * MINUTE);
      expect(await timing).toMatchObject({ state: 'timed_out', cause: 'timeout' });
      expect((await eventsOf(b, 'attempt.reset_wait_ended'))[0]?.payload).toMatchObject({
        outcome: 'timeout',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a daemon that stops during the wait leaves awaiting_resume, and the next start waits again',
    async () => {
      const quota = quotaOf(10 * MINUTE);
      const r = await rig({ quota: quota.service });
      const running = r.runner.run(specOf(r, '#script:quota-signal', WAIT));
      await untilWaiting(r);
      await r.runner.stop();
      const stopped = await running;
      expect(stopped).toMatchObject({ state: 'interrupted', needsDecision: false });
      expect(await r.store.attempts.get('play-1/demand-1/1')).toMatchObject({
        state: 'awaiting_resume',
        cause: 'quota_exhausted',
      });
      expect((await eventsOf(r, 'attempt.reset_wait_ended'))[0]?.payload).toMatchObject({
        outcome: 'stopped',
      });

      // The next daemon: a new runner over the same store, with the profile still out.
      const next = new AttemptRunner({
        store: r.store,
        vcs: defaultVcs(),
        pool: r.pool,
        clock: r.clock,
        settings: r.settings,
        worktreeRoot: r.worktreeRoot,
        logger: pino({ level: 'silent' }),
        quota: quota.service,
      });
      const report = await reconcileAttempts({
        store: r.store,
        runner: next,
        resolver: () => ({
          profile: TEST_PROFILE,
          executor: { model: 'fake-model' },
          policy: TEST_POLICY,
        }),
        logger: pino({ level: 'silent' }),
      });
      expect(report.resuming).toEqual(['play-1/demand-1/1']);
      await until(
        async () => (await eventsOf(r, 'attempt.reset_wait_started')).length === 2,
        'the second wait',
      );
      const started = await eventsOf(r, 'attempt.reset_wait_started');
      expect(started[1]?.payload).toMatchObject({ afterRestart: true, cause: 'quota_exhausted' });
      expect(r.transport.loaded).toHaveLength(0);
      // The chat was told once: the restart does not announce the same wait again.
      expect(await eventsOf(r, 'scenario.system_message')).toHaveLength(0);

      quota.back();
      expect(next.restored(PROFILE, ['quota'])).toBe(1);
      const [done] = await report.done;
      expect(done).toMatchObject({ state: 'completed' });
      expect(r.transport.loaded).toHaveLength(1);
      expect((await eventsOf(r, 'session.resumed')).at(-1)?.payload).toMatchObject({
        form: 'native',
      });
    },
    TEST_TIMEOUT_MS,
  );
});
