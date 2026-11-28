// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope, JsonObject } from '@otheater/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ticketV20,
  ticketV21,
  ticketV22NoMapping,
  ticketV23Partial,
  ticketV24NewInput,
  ticketV25RenamedLimit,
} from './fixtures/migration-fixture.js';
import { makeRuntime, makeWorld, publish, SCENARIO, type World } from './runtime.test-support.js';
import type { WorkflowRuntime } from './runtime.js';

/**
 * The birth version and the migration at a safe point (N295; Phase 11b, P4), on the generic engine:
 * a run born in `ticket` 2.0.0 stays there (`pin`), or moves to 2.1.0 only between two steps, when
 * nothing of it is open in the journal, and only if 2.1.0 says where the node it is in goes.
 */

const stoppers: WorkflowRuntime[] = [];
function runtimeOf(world: World, extra: Parameters<typeof makeRuntime>[1] = {}): WorkflowRuntime {
  const runtime = makeRuntime(world, extra);
  stoppers.push(runtime);
  return runtime;
}
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((runtime) => runtime.stop()));
});

const MIGRATE = { runningOnChange: () => 'migrate_at_safe_point' as const };

/** The world has every version of the fixture; the run is born in 2.0.0 and waits at the approval. */
async function startAtReview(world: World, runtime: WorkflowRuntime): Promise<void> {
  for (const version of [
    ticketV20(),
    ticketV21(),
    ticketV22NoMapping(),
    ticketV23Partial(),
    ticketV24NewInput(),
    ticketV25RenamedLimit(),
  ]) {
    put(world, version);
  }
  const started = await runtime.start({
    runId: 'run-1',
    scenarioId: SCENARIO,
    definition: ticketV20(),
  });
  expect(started.ok).toBe(true);
  await vi.waitFor(() => {
    expect(world.asks.opened.length).toBeGreaterThan(0);
  });
}

function put(world: World, definition: Record<string, unknown>): void {
  publish(world, definition as unknown as { id: string; version: string });
}

/** The state a kill between two steps leaves: the node is entered, its start is not written yet. */
async function betweenSteps(world: World): Promise<void> {
  const { play } = await playOf(world);
  const snapshot = JSON.parse(JSON.stringify(play.snapshot)) as JsonObject;
  (snapshot.runtime as JsonObject).inFlight = null;
  await world.store.plays.update('run-1', { snapshot });
}

async function waitSleeping(world: World): Promise<void> {
  await vi.waitFor(() => {
    expect(world.clock.pendingSleeps).toBeGreaterThan(0);
  });
}

/** Answers the question number `index` and lets the run reach its end (the event comes, the wait ends). */
async function finishFromApproval(
  world: World,
  runtime: WorkflowRuntime,
  index = 0,
): Promise<void> {
  world.asks.opened[index]?.answer('Allow');
  await waitSleeping(world);
  await world.store.events.append({
    type: 'demo.ready',
    schemaVersion: 1,
    payload: {},
    scenarioId: SCENARIO,
  });
  await world.clock.advance(2_001);
  await runtime.idle();
}

async function eventsOf(world: World, type: string, run = 'run-1'): Promise<EventEnvelope[]> {
  const all = await world.store.events.readFrom(0, 10_000);
  return all.filter((event) => event.type === type && event.playId === run);
}

async function nodesRun(world: World): Promise<string[]> {
  return (await eventsOf(world, 'workflow.step.started')).map(
    (event) => (event.payload as { node: string }).node,
  );
}

interface Saved {
  readonly workflow: { readonly version: string };
  readonly born: { readonly version: string };
  readonly runtime: { readonly migration: unknown; readonly inFlight: unknown };
}

async function playOf(world: World) {
  const play = await world.store.plays.get('run-1');
  if (play === undefined) throw new Error('no such run');
  return { play, saved: play.snapshot as unknown as Saved };
}

describe('a run is born in a version and stays there (running_on_change: pin)', () => {
  it('goes on in 2.0.0 after 2.1.0 is activated, and ends there', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);

    expect(await runtime.onActivated('ticket', '2.1.0')).toEqual([]);
    await finishFromApproval(world, runtime);

    const { play, saved } = await playOf(world);
    expect(play.state).toBe('done');
    expect(play.flowVersion).toBe(2);
    expect(saved.workflow.version).toBe('2.0.0');
    expect(saved.born.version).toBe('2.0.0');
    expect(await nodesRun(world)).toEqual(['announce', 'review', 'publish', 'wait']);
    expect(await eventsOf(world, 'workflow.migrated')).toEqual([]);
    expect(await eventsOf(world, 'workflow.migration_refused')).toEqual([]);
  });

  it('a restart resumes the run in 2.0.0 too', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    await startAtReview(world, first);
    await first.stop();

    const second = runtimeOf(world);
    expect(await second.resume('run-1')).toBe(true);
    await vi.waitFor(() => {
      expect(world.asks.opened).toHaveLength(2);
    });
    await finishFromApproval(world, second, 1);
    expect((await playOf(world)).saved.workflow.version).toBe('2.0.0');
    expect(await nodesRun(world)).toContain('publish');
  });
});

describe('a requested migration waits for a safe point', () => {
  it('is saved with the run while the step is going, and is made when the step ends', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);

    expect(await runtime.requestMigration('run-1', '2.1.0')).toEqual({ status: 'pending' });
    const waiting = await playOf(world);
    expect(waiting.saved.workflow.version).toBe('2.0.0');
    expect(waiting.saved.runtime.migration).toEqual({ toVersion: '2.1.0', trigger: 'request' });
    expect(await eventsOf(world, 'workflow.migrated')).toEqual([]);

    await finishFromApproval(world, runtime);

    const migrated = await eventsOf(world, 'workflow.migrated');
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.payload).toEqual({
      runId: 'run-1',
      from: { id: 'ticket', version: '2.0.0' },
      to: { id: 'ticket', version: '2.1.0' },
      fromState: 'publish',
      toState: 'ship',
      trigger: 'request',
      droppedLimits: [],
    });
    const { play, saved } = await playOf(world);
    expect(play.state).toBe('done');
    expect(saved.workflow.version).toBe('2.1.0');
    expect(saved.born.version).toBe('2.0.0');
    expect(saved.runtime.migration).toBeNull();
    expect(play.flowVersion).toBe(2);
    // The old nodes ran in 2.0.0, the rest in 2.1.0, and the tool was called once.
    expect(await nodesRun(world)).toEqual(['announce', 'review', 'ship', 'notice', 'wait']);
    expect(world.tools.world).toEqual(['doc-1']);
  });

  it('is kept by a restart and made when the run goes on', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    await startAtReview(world, first);
    expect(await first.requestMigration('run-1', '2.1.0')).toEqual({ status: 'pending' });
    await first.stop();

    const second = runtimeOf(world);
    expect(await second.resume('run-1')).toBe(true);
    await vi.waitFor(() => {
      expect(world.asks.opened).toHaveLength(2);
    });
    await finishFromApproval(world, second, 1);
    expect(await eventsOf(world, 'workflow.migrated')).toHaveLength(1);
    expect((await playOf(world)).saved.workflow.version).toBe('2.1.0');
  });

  it('is made at once for a run that is not going and is between two steps', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    await startAtReview(world, first);
    await first.stop();
    await betweenSteps(world);

    const second = runtimeOf(world);
    const outcome = await second.requestMigration('run-1', '2.1.0');
    expect(outcome).toMatchObject({ status: 'applied', toState: 'review' });
    expect((await playOf(world)).saved.workflow.version).toBe('2.1.0');
    expect((await playOf(world)).play.state).toBe('review');

    expect(await second.resume('run-1')).toBe(true);
    await vi.waitFor(() => {
      expect(world.asks.opened).toHaveLength(2);
    });
    await finishFromApproval(world, second, 1);
    expect(await nodesRun(world)).toEqual([
      'announce',
      'review',
      'review',
      'ship',
      'notice',
      'wait',
    ]);
  });

  it('waits while an effect of the run is open in the journal', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    await startAtReview(world, first);
    await first.stop();
    await betweenSteps(world);
    await world.store.sideEffects.intend({
      idempotencyKey: 'run-1:publish:1',
      type: 'demo.write',
      target: 'doc-1',
    });
    // An effect of another run does not hold this one.
    await world.store.sideEffects.intend({
      idempotencyKey: 'run-10:publish:1',
      type: 'demo.write',
      target: 'doc-2',
    });

    const second = runtimeOf(world);
    expect(await second.requestMigration('run-1', '2.1.0')).toEqual({ status: 'pending' });
    expect((await playOf(world)).saved.workflow.version).toBe('2.0.0');

    await world.store.sideEffects.resolve('run-1:publish:1', { state: 'not_done' });
    expect(await second.resume('run-1')).toBe(true);
    await vi.waitFor(async () => {
      expect(await eventsOf(world, 'workflow.migrated')).toHaveLength(1);
    });
  });
});

describe('running_on_change: migrate_at_safe_point', () => {
  it('asks the migration of the open runs in an older version when a version is activated', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world, MIGRATE);
    await startAtReview(world, runtime);

    expect(await runtime.onActivated('other', '2.1.0')).toEqual([]);
    expect(await runtime.onActivated('ticket', '2.0.0')).toEqual([]);
    expect(await runtime.onActivated('ticket', '1.9.0')).toEqual([]);
    expect(await runtime.onActivated('ticket', '2.1.0')).toEqual(['run-1']);
    expect((await playOf(world)).saved.runtime.migration).toEqual({
      toVersion: '2.1.0',
      trigger: 'activation',
    });

    await finishFromApproval(world, runtime);
    const migrated = await eventsOf(world, 'workflow.migrated');
    expect(migrated.map((event) => event.payload.trigger)).toEqual(['activation']);
    expect((await playOf(world)).saved.workflow.version).toBe('2.1.0');
  });

  it('does not ask a run that is finished', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world, MIGRATE);
    await startAtReview(world, runtime);
    await finishFromApproval(world, runtime);
    expect(await runtime.onActivated('ticket', '2.1.0')).toEqual([]);
  });
});

describe('a migration that cannot be made is refused, with an event, and the run goes on', () => {
  async function refusals(world: World): Promise<Record<string, unknown>[]> {
    return (await eventsOf(world, 'workflow.migration_refused')).map((event) => event.payload);
  }

  it('without a mapping from the version the run is in', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);

    expect(await runtime.requestMigration('run-1', '2.2.0')).toMatchObject({
      status: 'refused',
      reason: 'no_mapping',
    });
    expect(await refusals(world)).toEqual([
      {
        runId: 'run-1',
        from: { id: 'ticket', version: '2.0.0' },
        toVersion: '2.2.0',
        trigger: 'request',
        reason: 'no_mapping',
        detail: 'ticket@2.2.0 has no mapping from 2.0.0',
      },
    ]);
    await finishFromApproval(world, runtime);
    const { play, saved } = await playOf(world);
    expect(play.state).toBe('done');
    expect(saved.workflow.version).toBe('2.0.0');
    expect(await nodesRun(world)).toEqual(['announce', 'review', 'publish', 'wait']);
  });

  it('when the mapping does not name the node the run is in at the safe point', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);

    expect(await runtime.requestMigration('run-1', '2.3.0')).toEqual({ status: 'pending' });
    await finishFromApproval(world, runtime);

    const refused = await refusals(world);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: 'state_unmapped', toVersion: '2.3.0' });
    expect(String(refused[0]?.detail)).toContain('publish');
    const { play, saved } = await playOf(world);
    expect(play.state).toBe('done');
    expect(saved.workflow.version).toBe('2.0.0');
    expect(saved.runtime.migration).toBeNull();
    expect(await eventsOf(world, 'workflow.migrated')).toEqual([]);
  });

  it('for the other reasons', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);
    put(world, { ...ticketV21(), version: '2.6.0', nodes: {} });
    put(world, {
      ...ticketV21(),
      version: '2.7.0',
      migrate_from: { '2.0.0': { ghost: 'review' } },
    });

    const reason = async (version: string): Promise<unknown> => {
      const outcome = await runtime.requestMigration('run-1', version);
      return outcome.status === 'refused' ? outcome.reason : outcome.status;
    };
    expect(await reason('2.0.0')).toBe('not_newer');
    expect(await reason('1.9.0')).toBe('not_newer');
    expect(await reason('2.9.0')).toBe('definition_missing');
    expect(await reason('2.6.0')).toBe('target_invalid');
    expect(await reason('2.7.0')).toBe('mapping_invalid');
    expect(await reason('2.4.0')).toBe('inputs_incompatible');
    expect((await refusals(world)).map((payload) => payload.reason)).toEqual([
      'not_newer',
      'not_newer',
      'definition_missing',
      'target_invalid',
      'mapping_invalid',
      'inputs_incompatible',
    ]);
    // None of them touched the run.
    expect((await playOf(world)).saved.runtime.migration).toBeNull();
    await finishFromApproval(world, runtime);
    expect((await playOf(world)).saved.workflow.version).toBe('2.0.0');
  });

  it('for a run that is finished, one that does not exist and one that is not of the engine', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);
    await finishFromApproval(world, runtime);

    expect(await runtime.requestMigration('run-1', '2.1.0')).toMatchObject({
      status: 'refused',
      reason: 'run_finished',
    });
    expect((await refusals(world)).map((payload) => payload.reason)).toEqual(['run_finished']);
    expect(await runtime.requestMigration('nope', '2.1.0')).toMatchObject({
      status: 'refused',
      reason: 'run_finished',
    });
    await world.store.plays.create({
      id: 'play-1',
      scenarioId: SCENARIO,
      need: 'x',
      flowId: 'play',
      flowVersion: 2,
      state: 'plan',
      snapshot: { value: 'plan' },
      counters: {},
      parentPlayId: null,
    });
    expect(await runtime.requestMigration('play-1', '2.1.0')).toMatchObject({
      status: 'refused',
      reason: 'run_finished',
    });
    expect(await runtime.onActivated('play', '2.1.0')).toEqual([]);
  });

  it('a stopped runtime does not take a request', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);
    await runtime.stop();
    await expect(runtime.requestMigration('run-1', '2.1.0')).rejects.toThrow('stopped');
  });
});

describe('the counters of the limited edges', () => {
  it('are carried to the new version by key', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);
    world.asks.opened[0]?.answer('Allow');
    await waitSleeping(world);
    expect(await runtime.requestMigration('run-1', '2.1.0')).toEqual({ status: 'pending' });
    await world.clock.advance(61_000);
    await vi.waitFor(async () => {
      expect(await eventsOf(world, 'workflow.migrated')).toHaveLength(1);
    });
    const migrated = (await eventsOf(world, 'workflow.migrated'))[0];
    expect(migrated?.payload).toMatchObject({
      fromState: 'publish',
      toState: 'ship',
      droppedLimits: [],
    });
    await vi.waitFor(async () => {
      expect((await playOf(world)).play.counters).toEqual({ redo: 1 });
    });
  });

  it('are dropped, and named in the event, when the new version does not have the key', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startAtReview(world, runtime);
    world.asks.opened[0]?.answer('Allow');
    await waitSleeping(world);
    expect(await runtime.requestMigration('run-1', '2.5.0')).toEqual({ status: 'pending' });
    await world.clock.advance(61_000);
    await vi.waitFor(async () => {
      expect(await eventsOf(world, 'workflow.migrated')).toHaveLength(1);
    });
    const migrated = (await eventsOf(world, 'workflow.migrated'))[0];
    expect(migrated?.payload).toMatchObject({ toState: 'ship', droppedLimits: ['redo'] });
    await vi.waitFor(async () => {
      expect((await playOf(world)).play.counters).toEqual({});
    });
  });
});
