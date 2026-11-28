// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope } from '@otheater/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRASH_POINTS, armFaults, disarmFaults } from '../chaos/crash-points.js';
import { resolveRunInputs, type WorkflowRuntime } from './runtime.js';
import {
  makeRuntime,
  makeWorld,
  pipeline,
  publish,
  SCENARIO,
  type World,
} from './runtime.test-support.js';
import { validateWorkflow } from '@otheater/workflows';

afterEach(disarmFaults);

const stoppers: WorkflowRuntime[] = [];
function runtimeOf(world: World, extra: Parameters<typeof makeRuntime>[1] = {}): WorkflowRuntime {
  const runtime = makeRuntime(world, extra);
  stoppers.push(runtime);
  return runtime;
}
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((runtime) => runtime.stop()));
});

async function workflowEvents(world: World, run = 'run-1'): Promise<EventEnvelope[]> {
  const all = await world.store.events.readFrom(0, 10_000);
  return all.filter((event) => event.type.startsWith('workflow.') && event.playId === run);
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value);

async function summary(world: World, run = 'run-1'): Promise<string[]> {
  return (await workflowEvents(world, run)).map((event) => {
    const p = event.payload;
    if (event.type === 'workflow.step.started') return `started ${text(p.node)}#${text(p.ordinal)}`;
    if (event.type === 'workflow.step.finished') {
      return `finished ${text(p.node)}#${text(p.ordinal)} ${text(p.outcome)} -> ${text(p.to)}`;
    }
    if (event.type === 'workflow.run.finished') return `run ${text(p.outcome)}`;
    return event.type;
  });
}

async function playOf(world: World, run = 'run-1') {
  const play = await world.store.plays.get(run);
  if (play === undefined) throw new Error('no such run');
  return play;
}

/** Runs the pipeline up to the question to the Producer. */
async function startToApproval(world: World, runtime: WorkflowRuntime) {
  publish(world, pipeline());
  const started = await runtime.start({
    runId: 'run-1',
    scenarioId: SCENARIO,
    definition: pipeline(),
  });
  expect(started.ok).toBe(true);
  await vi.waitFor(() => {
    expect(world.asks.opened.length).toBeGreaterThan(0);
  });
}

describe('WorkflowRuntime: the generic steps', () => {
  it('runs a workflow with the five step types to its end, one transaction per transition', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startToApproval(world, runtime);
    expect(world.asks.opened[0]?.question).toBe('Publish?');
    world.asks.opened[0]?.answer('Allow');
    await vi.waitFor(() => {
      expect(world.clock.pendingSleeps).toBeGreaterThan(0);
    });
    await world.store.events.append({
      type: 'demo.ready',
      schemaVersion: 1,
      payload: { ok: true },
      scenarioId: SCENARIO,
    });
    await world.clock.advance(2_001);
    await runtime.idle();

    expect(await summary(world)).toEqual([
      'workflow.run.started',
      'started announce#1',
      'workflow.notified',
      'finished announce#1 done -> save',
      'started save#1',
      'finished save#1 done -> route',
      'started route#1',
      'finished route#1 done -> ask',
      'started ask#1',
      'workflow.approval.requested',
      'workflow.approval.resolved',
      'finished ask#1 done -> wait',
      'started wait#1',
      'finished wait#1 done -> done',
      'run done',
    ]);
    const play = await playOf(world);
    expect(play.state).toBe('done');
    expect(play.finishedAt).not.toBeNull();
    expect(play.flowId).toBe('pipeline');
    expect(world.tools.world).toEqual(['doc-1']);
    expect(world.tools.calls).toEqual(['write:doc-1']);
    expect(world.asks.opened).toHaveLength(1);
    const snapshot = play.snapshot as { workflow: { id: string; version: string; hash: string } };
    expect(snapshot.workflow).toMatchObject({ id: 'pipeline', version: '1.0.0' });
    expect(snapshot.workflow.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('puts the visit key and the effect origin in the events of the steps', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startToApproval(world, runtime);
    const events = await workflowEvents(world);
    const save = events.find(
      (event) => event.type === 'workflow.step.started' && event.payload.node === 'save',
    );
    expect(save?.payload).toMatchObject({ key: 'run-1:save:1', ordinal: 1, resumed: false });
    const finished = events.find(
      (event) => event.type === 'workflow.step.finished' && event.payload.node === 'save',
    );
    expect(finished?.payload).toMatchObject({ outcome: 'done', effect: 'executed' });
  });

  it('a tool that answers an error is not a failed step: the edges decide', async () => {
    const world = makeWorld();
    world.definitions.clear();
    const definition = {
      id: 'probe',
      version: '1.0.0',
      engine: '>=1 <2',
      nodes: { status: { step: 'call_tool', params: { tool: 'demo__status' } } },
      edges: ['status -> done when output.ok', 'status -> failed'],
    };
    world.tools.statusOk = false;
    const runtime = runtimeOf(world);
    await runtime.start({ runId: 'run-1', scenarioId: SCENARIO, definition });
    await runtime.idle();
    expect((await playOf(world)).state).toBe('failed');
    expect(await summary(world)).toEqual([
      'workflow.run.started',
      'started status#1',
      'finished status#1 done -> failed',
      'run failed',
    ]);
    world.tools.statusOk = true;
    await runtime.start({ runId: 'run-2', scenarioId: SCENARIO, definition });
    await runtime.idle();
    expect((await playOf(world, 'run-2')).state).toBe('done');
  });

  it('fails a call_tool whose tool is not there, with the reason', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await runtime.start({
      runId: 'run-1',
      scenarioId: SCENARIO,
      definition: {
        id: 'ghost',
        version: '1.0.0',
        engine: '>=1 <2',
        nodes: { go: { step: 'call_tool', params: { tool: 'nobody__nothing' } } },
        edges: ['go -> done'],
      },
    });
    await runtime.idle();
    const finished = (await workflowEvents(world)).find(
      (event) => event.type === 'workflow.step.finished',
    );
    expect(finished?.payload).toMatchObject({ outcome: 'failed', reason: 'tool_unavailable' });
    expect((await playOf(world)).state).toBe('failed');
  });

  it('stops a loop at its limit and fails the run with the limit as the reason', async () => {
    const world = makeWorld();
    world.tools.statusOk = false;
    const runtime = runtimeOf(world);
    await runtime.start({
      runId: 'run-1',
      scenarioId: SCENARIO,
      definition: {
        id: 'retry',
        version: '1.0.0',
        engine: '>=1 <2',
        nodes: { poll: { step: 'call_tool', params: { tool: 'demo__status' } } },
        edges: ['poll -> done when output.ok', { from: 'poll', to: 'poll', limit: 'again' }],
        limits: { again: 2 },
      },
    });
    await runtime.idle();
    const play = await playOf(world);
    expect(play.state).toBe('failed');
    expect(play.counters).toEqual({ again: 2 });
    const finished = (await workflowEvents(world)).find((e) => e.type === 'workflow.run.finished');
    expect(finished?.payload).toMatchObject({
      outcome: 'failed',
      reason: 'limit_reached:again',
      steps: 3,
    });
    expect(world.tools.calls).toHaveLength(3);
    const keys = (await workflowEvents(world))
      .filter((e) => e.type === 'workflow.step.started')
      .map((e) => e.payload.key);
    expect(keys).toEqual(['run-1:poll:1', 'run-1:poll:2', 'run-1:poll:3']);
  });

  it('wait_event ends with timed_out when its deadline passes on the clock', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startToApproval(world, runtime);
    world.asks.opened[0]?.answer('Allow');
    await vi.waitFor(() => {
      expect(world.clock.pendingSleeps).toBeGreaterThan(0);
    });
    await world.clock.advance(61_000);
    await runtime.idle();
    expect((await playOf(world)).state).toBe('failed');
    const wait = (await workflowEvents(world)).find(
      (e) => e.type === 'workflow.step.finished' && e.payload.node === 'wait',
    );
    expect(wait?.payload).toMatchObject({ outcome: 'done', next: null, to: 'failed' });
  });

  it('wait_event ignores an event of another scenario', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startToApproval(world, runtime);
    world.asks.opened[0]?.answer('Allow');
    await vi.waitFor(() => {
      expect(world.clock.pendingSleeps).toBeGreaterThan(0);
    });
    await world.store.events.append({
      type: 'demo.ready',
      schemaVersion: 1,
      payload: {},
      scenarioId: 'another-scenario',
    });
    await world.clock.advance(2_001);
    expect((await playOf(world)).state).toBe('wait');
    await world.store.events.append({
      type: 'demo.ready',
      schemaVersion: 1,
      payload: {},
    });
    await world.clock.advance(2_001);
    await runtime.idle();
    expect((await playOf(world)).state).toBe('done');
  });

  it('a No to the approval takes the other edge', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startToApproval(world, runtime);
    world.asks.opened[0]?.answer('Deny');
    await runtime.idle();
    expect((await playOf(world)).state).toBe('cancelled');
    expect((await summary(world)).at(-1)).toBe('run cancelled');
  });

  it('with no timeout answer, an approval that times out stops the run; reject lets the edges decide', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world, {
      settings: {
        waitEventPollMs: 2_000,
        approvalTimeoutMs: 30_000,
        approvalOnTimeout: 'stop',
        callToolTimeoutMs: null,
      },
    });
    await startToApproval(world, runtime);
    await vi.waitFor(() => {
      expect(world.clock.pendingSleeps).toBeGreaterThan(0);
    });
    await world.clock.advance(31_000);
    await runtime.idle();
    const finished = (await workflowEvents(world)).find((e) => e.type === 'workflow.run.finished');
    expect(finished?.payload).toMatchObject({ outcome: 'cancelled', reason: 'approval_timeout' });

    const rejecting = makeWorld();
    const second = runtimeOf(rejecting, {
      settings: {
        waitEventPollMs: 2_000,
        approvalTimeoutMs: 30_000,
        approvalOnTimeout: 'reject',
        callToolTimeoutMs: null,
      },
    });
    await startToApproval(rejecting, second);
    await vi.waitFor(() => {
      expect(rejecting.clock.pendingSleeps).toBeGreaterThan(0);
    });
    await rejecting.clock.advance(31_000);
    await second.idle();
    expect((await playOf(rejecting)).state).toBe('cancelled');
    const ask = (await workflowEvents(rejecting)).find(
      (e) => e.type === 'workflow.step.finished' && e.payload.node === 'ask',
    );
    expect(ask?.payload).toMatchObject({ outcome: 'done', to: 'cancelled' });
  });

  it('an approval with nobody to ask fails the step, never a yes', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world, { ask: () => Promise.resolve(undefined) });
    publish(world, pipeline());
    await runtime.start({ runId: 'run-1', scenarioId: SCENARIO, definition: pipeline() });
    await runtime.idle();
    const ask = (await workflowEvents(world)).find(
      (e) => e.type === 'workflow.step.finished' && e.payload.node === 'ask',
    );
    expect(ask?.payload).toMatchObject({ outcome: 'failed', reason: 'approval_unavailable' });
    expect((await playOf(world)).state).toBe('failed');
  });
});

describe('WorkflowRuntime: start and refusals', () => {
  it('refuses an invalid definition, an unknown step type and bad inputs, and writes no run', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    const bad = await runtime.start({
      runId: 'bad-1',
      scenarioId: SCENARIO,
      definition: { ...pipeline(), edges: ['announce -> nowhere'] },
    });
    expect(bad).toMatchObject({ ok: false, refusal: 'invalid_definition' });

    const unknown = await runtime.start({
      runId: 'bad-2',
      scenarioId: SCENARIO,
      definition: {
        id: 'x',
        version: '1.0.0',
        engine: '>=1 <2',
        nodes: { go: { step: 'plan' } },
        edges: ['go -> done'],
      },
    });
    expect(unknown).toMatchObject({ ok: false, refusal: 'unknown_step_type' });

    const inputs = await runtime.start({
      runId: 'bad-3',
      scenarioId: SCENARIO,
      definition: pipeline(),
      inputs: { who: 3, extra: 'x' },
    });
    expect(inputs).toMatchObject({ ok: false, refusal: 'invalid_inputs' });
    expect(inputs.ok ? '' : inputs.detail).toContain('extra');

    for (const id of ['bad-1', 'bad-2', 'bad-3'])
      expect(await world.store.plays.get(id)).toBeUndefined();
    const refused = (await world.store.events.readFrom(0, 100)).filter(
      (e) => e.type === 'workflow.run.refused',
    );
    expect(refused.map((e) => e.payload.reason)).toEqual([
      'invalid_definition',
      'unknown_step_type',
      'invalid_inputs',
    ]);
  });

  it('a run id already in use is a conflict, not a second run', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startToApproval(world, runtime);
    await expect(
      runtime.start({ runId: 'run-1', scenarioId: SCENARIO, definition: pipeline() }),
    ).rejects.toThrow();
  });

  it('fills the defaults of the inputs and checks the types', () => {
    const result = validateWorkflow({
      id: 'inputs',
      version: '1.0.0',
      engine: '>=1 <2',
      inputs: {
        who: { type: 'string', default: 'world' },
        count: { type: 'number', required: true },
        mode: { type: { enum: ['a', 'b'] }, default: 'a' },
        wait: { type: 'duration', required: false },
      },
      nodes: { go: { step: 'branch' } },
      edges: ['go -> done'],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(resolveRunInputs(result.workflow, { count: 2 })).toEqual({
      ok: true,
      inputs: { who: 'world', count: 2, mode: 'a' },
    });
    expect(resolveRunInputs(result.workflow, {})).toMatchObject({ ok: false });
    expect(resolveRunInputs(result.workflow, { count: 'two' })).toMatchObject({ ok: false });
    expect(resolveRunInputs(result.workflow, { count: 1, mode: 'c' })).toMatchObject({ ok: false });
    expect(resolveRunInputs(result.workflow, { count: 1, wait: '5m' })).toMatchObject({ ok: true });
    expect(resolveRunInputs(result.workflow, { count: 1, wait: 'soon' })).toMatchObject({
      ok: false,
    });
  });
});

describe('WorkflowRuntime: cancel, stop and resume', () => {
  it('cancels a run that is waiting: the step is aborted and the run ends cancelled', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await startToApproval(world, runtime);
    expect(await runtime.cancel('run-1', 'the Producer gave up')).toBe(true);
    const finished = (await workflowEvents(world)).find((e) => e.type === 'workflow.run.finished');
    expect(finished?.payload).toMatchObject({
      outcome: 'cancelled',
      reason: 'the Producer gave up',
    });
    expect((await playOf(world)).state).toBe('cancelled');
    expect(runtime.isActive('run-1')).toBe(false);
    expect(await runtime.cancel('run-1')).toBe(false);
    expect(await runtime.cancel('no-such-run')).toBe(false);
  });

  it('a stopped runtime writes nothing more, and a new one resumes the run in the same node', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    await startToApproval(world, first);
    await first.stop();
    const before = (await summary(world)).length;
    expect((await playOf(world)).finishedAt).toBeNull();

    const second = runtimeOf(world);
    expect(await second.resumeAll()).toEqual({ resumed: ['run-1'], refused: [] });
    await vi.waitFor(() => {
      expect(world.asks.opened).toHaveLength(2);
    });
    // The first question can no longer be answered: it was withdrawn and a new one asked.
    expect((await summary(world)).length).toBeGreaterThan(before);
    world.asks.opened[1]?.answer('Allow');
    await vi.waitFor(() => {
      expect(world.clock.pendingSleeps).toBeGreaterThan(0);
    });
    await world.store.events.append({
      type: 'demo.ready',
      schemaVersion: 1,
      payload: {},
      scenarioId: SCENARIO,
    });
    await world.clock.advance(2_001);
    await second.idle();
    expect((await playOf(world)).state).toBe('done');
    expect(world.tools.world).toEqual(['doc-1']);
    const resumedAsk = (await workflowEvents(world)).filter(
      (e) => e.type === 'workflow.step.started' && e.payload.node === 'ask',
    );
    expect(resumedAsk.map((e) => e.payload.resumed)).toEqual([false, true]);
    expect(resumedAsk.map((e) => e.payload.key)).toEqual(['run-1:ask:1', 'run-1:ask:1']);
  });

  it('refuses to resume a run whose definition changed, and leaves it as it was', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    await startToApproval(world, first);
    await first.stop();
    const saved = await playOf(world);

    const changed = pipeline();
    changed.nodes.announce = { step: 'notify', params: { message: 'another text' } };
    world.definitions.set('pipeline@1.0.0', changed);
    const second = runtimeOf(world);
    expect(await second.resume('run-1')).toBe(false);
    const refusal = (await world.store.events.readFrom(0, 1000)).find(
      (e) => e.type === 'workflow.run.refused',
    );
    expect(refusal?.payload).toMatchObject({
      reason: 'hash_mismatch',
      workflow: { id: 'pipeline', version: '1.0.0' },
    });
    expect(await playOf(world)).toEqual(saved);
  });

  it('refuses to resume a run whose definition is gone', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    await startToApproval(world, first);
    await first.stop();
    world.definitions.clear();
    const second = runtimeOf(world);
    expect(await second.resumeAll()).toEqual({ resumed: [], refused: ['run-1'] });
    const refusal = (await world.store.events.readFrom(0, 1000)).find(
      (e) => e.type === 'workflow.run.refused',
    );
    expect(refusal?.payload).toMatchObject({ reason: 'definition_missing' });

    const bare = runtimeOf(world, { source: undefined });
    expect(await bare.resume('run-1')).toBe(false);
  });

  it('leaves alone a run that is finished, that is not a workflow run, or that does not exist', async () => {
    const world = makeWorld();
    const runtime = runtimeOf(world);
    await world.store.plays.create({
      id: 'play-1',
      scenarioId: SCENARIO,
      need: 'a play',
      flowId: 'play',
      flowVersion: 1,
      state: 'PLANNING',
    });
    expect(await runtime.resumeAll()).toEqual({ resumed: [], refused: [] });
    expect(await runtime.resume('play-1')).toBe(false);
    expect(await runtime.resume('nope')).toBe(false);
  });
});

describe('WorkflowRuntime: a crash in the middle of call_tool never repeats the effect', () => {
  const POINTS = CRASH_POINTS.effects;

  /** Which point leaves the effect done in the world before the crash. */
  const EXECUTED = new Set<string>([
    'effects.after_execute',
    'effects.after_resolve',
    'effects.after_verify',
  ]);

  for (const point of POINTS) {
    it(`killed at ${point}: the restart finishes the run and the world has the write once`, async () => {
      const world = makeWorld();
      const first = runtimeOf(world);
      const hit = { crashed: false };
      armFaults(
        { crash: [{ point, detail: 'demo.write', nth: 1 }], fail: [] },
        {
          onCrash: () => {
            hit.crashed = true;
            void first.stop();
            throw new Error(`killed at ${point}`);
          },
        },
      );
      publish(world, pipeline());
      await first
        .start({
          runId: 'run-1',
          scenarioId: SCENARIO,
          definition: {
            id: 'save-only',
            version: '1.0.0',
            engine: '>=1 <2',
            nodes: {
              save: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-9' } } },
            },
            edges: ['save -> done'],
          },
        })
        .catch(() => undefined);
      await first.idle();
      // `after_verify` is only reached on a second pass: the point does not fire on the first.
      if (!hit.crashed) {
        expect(point).toBe('effects.after_verify');
        return;
      }
      expect(world.tools.world).toEqual(EXECUTED.has(point) ? ['doc-9'] : []);
      expect((await playOf(world)).finishedAt).toBeNull();
      disarmFaults();

      world.definitions.set('save-only@1.0.0', {
        id: 'save-only',
        version: '1.0.0',
        engine: '>=1 <2',
        nodes: {
          save: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-9' } } },
        },
        edges: ['save -> done'],
      });
      const second = runtimeOf(world);
      expect(await second.resumeAll()).toEqual({ resumed: ['run-1'], refused: [] });
      await second.idle();

      expect((await playOf(world)).state).toBe('done');
      expect(world.tools.world).toEqual(['doc-9']);
      const records = await world.store.sideEffects.list({ types: ['demo.write'] });
      // One record ends `done`; a record the crash left open was judged and closed, never `pending`.
      expect(records.filter((r) => r.state === 'done')).toHaveLength(1);
      expect(records.filter((r) => r.state === 'pending')).toEqual([]);
      const steps = (await workflowEvents(world)).filter(
        (e) => e.type === 'workflow.step.finished',
      );
      expect(steps).toHaveLength(1);
    });
  }

  it('after the effect was executed, the restart verifies it instead of calling the tool again', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    armFaults(
      { crash: [{ point: 'effects.after_execute', detail: 'demo.write', nth: 1 }], fail: [] },
      {
        onCrash: () => {
          void first.stop();
          throw new Error('killed');
        },
      },
    );
    const definition = {
      id: 'save-only',
      version: '1.0.0',
      engine: '>=1 <2',
      nodes: {
        save: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-7' } } },
      },
      edges: ['save -> done'],
    };
    world.definitions.set('save-only@1.0.0', definition);
    await first.start({ runId: 'run-1', scenarioId: SCENARIO, definition });
    await first.idle();
    disarmFaults();
    const second = runtimeOf(world);
    await second.resume('run-1');
    await second.idle();
    expect(world.tools.calls).toEqual(['write:doc-7']);
    const finished = (await workflowEvents(world)).find((e) => e.type === 'workflow.step.finished');
    expect(finished?.payload).toMatchObject({ outcome: 'done', effect: 'verified' });
  });

  it('a notify killed after it wrote its event does not tell the Producer twice', async () => {
    const world = makeWorld();
    const first = runtimeOf(world);
    armFaults(
      { crash: [{ point: 'effects.after_execute', detail: 'workflow.notify', nth: 1 }], fail: [] },
      {
        onCrash: () => {
          void first.stop();
          throw new Error('killed');
        },
      },
    );
    const definition = {
      id: 'tell',
      version: '1.0.0',
      engine: '>=1 <2',
      nodes: { tell: { step: 'notify', params: { message: 'hello' } } },
      edges: ['tell -> done'],
    };
    world.definitions.set('tell@1.0.0', definition);
    await first.start({ runId: 'run-1', scenarioId: SCENARIO, definition });
    await first.idle();
    disarmFaults();
    const second = runtimeOf(world);
    await second.resume('run-1');
    await second.idle();
    const notices = (await workflowEvents(world)).filter((e) => e.type === 'workflow.notified');
    expect(notices).toHaveLength(1);
    expect((await playOf(world)).state).toBe('done');
  });

  it('a tool with no verifier is ambiguous after a crash: the step fails and the tool is not called again', async () => {
    const world = makeWorld();
    const first = runtimeOf(world, { pluginEffects: undefined });
    armFaults(
      { crash: [{ point: 'effects.after_execute', detail: 'demo.write', nth: 1 }], fail: [] },
      {
        onCrash: () => {
          void first.stop();
          throw new Error('killed');
        },
      },
    );
    const definition = {
      id: 'save-only',
      version: '1.0.0',
      engine: '>=1 <2',
      nodes: {
        save: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-5' } } },
      },
      edges: ['save -> done'],
    };
    world.definitions.set('save-only@1.0.0', definition);
    await first.start({ runId: 'run-1', scenarioId: SCENARIO, definition });
    await first.idle();
    disarmFaults();
    const second = runtimeOf(world, { pluginEffects: undefined });
    await second.resume('run-1');
    await second.idle();
    expect(world.tools.calls).toEqual(['write:doc-5']);
    const finished = (await workflowEvents(world)).find((e) => e.type === 'workflow.step.finished');
    expect(finished?.payload).toMatchObject({ outcome: 'failed', reason: 'effect_ambiguous' });
  });
});
