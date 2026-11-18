// SPDX-License-Identifier: MPL-2.0
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { type Profile } from '@otheater/core';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import {
  eventsOf,
  makeRig,
  QUIET_SETTINGS,
  specOf,
  until,
  type Rig,
  type RigParts,
} from './attempt-fixture.js';
import type { HandoffPort } from './handoff.js';
import type { ExecutionSettings } from './settings.js';

/**
 * P21: a profile that is being removed lets go of its running attempts. With `handoff` the attempt
 * takes the baton to another Executor (P18) without costing an attempt; with `force` it is parked
 * (`awaiting_resume`) for reconciliation. The demand is never lost.
 */

const TEST_TIMEOUT_MS = 30_000;
const PLAY = 'play-1';
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

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];

async function rig(
  handoff?: HandoffPort,
  pool?: Partial<ExecutionSettings['pool']>,
  onProfileRemoved?: ExecutionSettings['onProfileRemoved'],
): Promise<TestRig> {
  const made = await makeRig(
    fakes(),
    {
      ...(pool === undefined ? {} : { pool: { ...QUIET_SETTINGS.pool, ...pool } }),
      ...(onProfileRemoved === undefined ? {} : { onProfileRemoved }),
    },
    undefined,
    undefined,
    handoff,
  );
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});

afterAll(disposeTestGitIsolation);

/** A port that hands the work to `fake/two`, once. */
function toTwo(): HandoffPort {
  return {
    prefixOf: () => 'ROLE PREFIX',
    choose(request) {
      if (request.used.includes(ID_TWO)) {
        return Promise.resolve({ kind: 'none', reason: 'no_other_executor' });
      }
      return Promise.resolve({
        kind: 'selected',
        target: {
          executorId: ID_TWO,
          profile: TWO,
          executor: { model: 'fake-model' },
          policy: TEST_POLICY,
        },
      });
    },
    announce: () => undefined,
    secretPaths: [],
  };
}

async function seed(r: TestRig): Promise<void> {
  await r.store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play.default',
    name: 'leaving',
    folder: '/work/leaving',
    baseBranch: 'main',
  });
  await r.store.plays.create({
    id: PLAY,
    scenarioId: 's1',
    need: 'add the endpoint',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
  });
  await r.store.demands.create({
    playId: PLAY,
    id: 'demand-1',
    title: 'Add the health endpoint',
    description: 'GET /health answers 200.',
    dependsOn: [],
    contract: { inputs: [], outputs: [{ name: 'health', kind: 'file' }] },
    expectedFiles: ['a.txt'],
    complexity: 'low',
    timeoutMin: 10,
    acceptanceCriteria: ['the endpoint answers 200'],
    verify: [],
    verifyWaiver: 'none',
    state: 'running',
  });
}

async function untilHanging(r: TestRig): Promise<void> {
  await until(
    async () =>
      (await eventsOf(r, 'session.update')).some((event) =>
        JSON.stringify(event.payload).includes('hanging until session/cancel'),
      ),
    'a hanging turn',
  );
}

describe('a profile that is being removed lets go of its attempts (P21)', () => {
  it(
    'handoff: the running attempt takes the baton to another profile and no attempt is spent',
    async () => {
      const r = await rig(toTwo());
      await seed(r);
      // The first turn hangs; after the baton the second session answers a plain prompt.
      const running = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await untilHanging(r);
      expect(r.runner.attemptsOf('fake/one')).toBe(1);
      expect(r.runner.attemptsOf('fake/two')).toBe(0);

      const touched = await r.runner.releaseProfile('fake/one', 'handoff');
      expect(touched).toBe(1);
      // By the time the call returns, the attempt no longer counts against the profile.
      expect(r.runner.attemptsOf('fake/one')).toBe(0);

      const outcome = await running;
      expect(outcome.state).toBe('completed');
      expect(outcome).toMatchObject({
        handoffs: [
          {
            cause: 'profile_removed',
            from: 'fake-model@fake/one',
            to: ID_TWO,
            countedAsAttempt: false,
          },
        ],
      });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        client: 'fake',
        profile: 'two',
        state: 'completed',
        attempt: 1,
      });
      const [interrupted] = await eventsOf(r, 'session.interrupted');
      expect(interrupted?.payload).toMatchObject({ form: 'handoff' });
      const rows = await r.store.interruptions.list();
      expect(rows[0]).toMatchObject({ resumeForm: 'handoff', countedAsAttempt: false });
      expect(rows[0]?.signals).toContain('profile:leaving');
      // Nothing is left running on the removed profile.
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'handoff with nobody to take the work: the attempt is parked and the demand is kept',
    async () => {
      const r = await rig({
        ...toTwo(),
        choose: () => Promise.resolve({ kind: 'none', reason: 'no_other_executor' }),
      });
      await seed(r);
      const running = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await untilHanging(r);

      await r.runner.releaseProfile('fake/one', 'handoff');
      const outcome = await running;
      expect(outcome.state).toBe('interrupted');
      expect(outcome).toMatchObject({ handoffWait: { reason: 'no_other_executor' } });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'interrupted',
      });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'force: the attempt is parked awaiting resume and the process ends',
    async () => {
      const r = await rig(toTwo());
      await seed(r);
      const running = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await untilHanging(r);

      await r.runner.releaseProfile('fake/one', 'force');
      const outcome = await running;
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'profile_removed' });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'awaiting_resume',
        cause: 'profile_removed',
      });
      const [row] = await r.store.interruptions.list();
      expect(row).toMatchObject({ cause: 'profile_removed' });
      expect(row?.signals).toContain('profile:leaving');
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'park (resume.on_profile_removed): the attempt stays interrupted and the Director decides',
    async () => {
      const r = await rig(toTwo(), undefined, 'park');
      await seed(r);
      const running = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await untilHanging(r);

      await r.runner.releaseProfile('fake/one', 'handoff');
      const outcome = await running;
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'profile_removed',
        needsDecision: true,
        handoffs: [],
        decision: { action: 'director_judgment', countsAsAttempt: false },
      });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'interrupted',
        cause: 'profile_removed',
      });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'force, then resume(): straight to the baton, with no session/load on the profile that left',
    async () => {
      const r = await rig(toTwo());
      await seed(r);
      const running = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await untilHanging(r);
      await r.runner.releaseProfile('fake/one', 'force');
      const parked = await running;
      const record = await r.store.attempts.get(parked.attemptId);
      expect(record).toMatchObject({ state: 'awaiting_resume', cause: 'profile_removed' });
      if (record === undefined) throw new Error('no record');

      const resumed = await r.runner.resume(record, {
        profile: TEST_PROFILE,
        executor: { model: 'fake-model' },
        policy: TEST_POLICY,
      });
      expect(resumed.state).toBe('completed');
      expect(resumed.handoffs).toMatchObject([
        {
          cause: 'profile_removed',
          from: 'fake-model@fake/one',
          to: ID_TWO,
          countedAsAttempt: false,
        },
      ]);
      expect(resumed.resumes).toBe(0);
      expect(r.transport.loaded).toHaveLength(0);
      expect(await r.store.attempts.get(parked.attemptId)).toMatchObject({
        profile: 'two',
        state: 'completed',
      });
      const rows = await r.store.interruptions.list();
      expect(rows.every((row) => !row.countedAsAttempt)).toBe(true);
      expect(rows.map((row) => row.cause)).toContain('profile_removed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'force, then resume() with park: the attempt stays interrupted for the Director',
    async () => {
      const r = await rig(toTwo(), undefined, 'park');
      await seed(r);
      const running = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await untilHanging(r);
      await r.runner.releaseProfile('fake/one', 'force');
      const parked = await running;
      const record = await r.store.attempts.get(parked.attemptId);
      if (record === undefined) throw new Error('no record');
      const resumed = await r.runner.resume(record, {
        profile: TEST_PROFILE,
        executor: { model: 'fake-model' },
        policy: TEST_POLICY,
      });
      expect(resumed).toMatchObject({
        state: 'interrupted',
        cause: 'profile_removed',
        needsDecision: true,
      });
      expect(r.transport.loaded).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a go that starts on a profile already leaving is turned away at once',
    async () => {
      const r = await rig(toTwo());
      await seed(r);
      // Mark the profile as leaving with nothing running on it.
      expect(await r.runner.releaseProfile('fake/one', 'handoff')).toBe(0);
      const outcome = await r.runner.run(specOf(r, '#script:echo', { role: 'actor' }));
      // It is handed to the other profile and completes there.
      expect(outcome.state).toBe('completed');
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({ profile: 'two' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'an attempt still waiting in the admission queue leaves too, and nothing is counted on the profile',
    async () => {
      const r = await rig(undefined, { maxSessions: 1 });
      await seed(r);
      const first = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await untilHanging(r);
      const second = r.runner.run(
        specOf(r, '#script:hang', { role: 'actor', demandId: 'demand-2' }),
      );
      await until(() => r.runner.attemptsOf('fake/one') === 2, 'both attempts on the profile');

      expect(await r.runner.releaseProfile('fake/one', 'handoff')).toBe(2);
      expect(r.runner.attemptsOf('fake/one')).toBe(0);
      const outcomes = await Promise.all([first, second]);
      for (const outcome of outcomes) expect(outcome.state).toBe('interrupted');
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
