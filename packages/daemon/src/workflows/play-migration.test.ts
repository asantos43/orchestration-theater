// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@otheater/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayState } from '../pipeline/definitions.js';
import { Model } from '../pipeline/model-fixture.js';
import { loadPlayDefinition } from './definitions/play-definition.js';
import { makeRuntime, makeWorld, publish, SCENARIO, type World } from './runtime.test-support.js';
import type { WorkflowRuntime } from './runtime.js';
import { GENERIC_STEP_RUNNERS } from './steps/index.js';
import { createPlayStepRunners, type PlayStageHost } from './steps/play/index.js';
import type { StepResult } from './steps/types.js';

/**
 * N295 on the play (Phase 11b, P10c): a run born in `play` 2.0.0 stays there after 2.1.0 is
 * activated, or moves to it between two stages, on the generic engine over the REAL `play.yaml`.
 *
 * What this does NOT cover [N]: the real play does not run on the engine yet (the machine of
 * `pipeline/machine.ts` still drives it, see docs/26 P10c). The stages here are a fake
 * `PlayStageHost` that answers each one with the output the edges read, so this proves the
 * definition, the mapping of 2.1.0 and the runtime, not the stage code.
 */

const PLAY_21 = fileURLToPath(new URL('./fixtures/play-2.1.yaml', import.meta.url));

function load(text?: string) {
  const loaded = loadPlayDefinition(text);
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  return loaded.workflow.definition as unknown as { id: string; version: string };
}

const OUTPUTS: Partial<Record<PlayState, Record<string, unknown>>> = {
  PLANNING: { has_open_questions: false },
  REVIEWING_PLAN: { approved: true },
  SCRIPTING: { valid: true },
  REVIEWING_SCRIPT: { approved: true },
  EXECUTING: { outcome: 'completed' },
  INTEGRATING: { ok: true },
  CRITIQUING: { approved: true },
  DELIVERING: { outcome: 'delivered' },
};

/** A host that holds the stage `gate` until `release()`, and answers the others at once. */
function makeHost(gate: PlayState) {
  const stages: PlayState[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host: PlayStageHost = {
    contextOf: () => {
      const model = new Model();
      model.send({ type: 'START' });
      return Promise.resolve(model.context);
    },
    runStage: async (call): Promise<StepResult> => {
      stages.push(call.state);
      if (call.state === gate) {
        // A stage of the real host ends when the run is stopped; this one does the same.
        const aborted = new Promise<'aborted'>((resolve) => {
          call.signal.addEventListener('abort', () => {
            resolve('aborted');
          });
        });
        if ((await Promise.race([held.then(() => 'released' as const), aborted])) === 'aborted') {
          return { kind: 'cancelled', reason: 'aborted' };
        }
      }
      return { kind: 'done', output: OUTPUTS[call.state] ?? {} } as StepResult;
    },
  };
  return {
    host,
    stages,
    release: () => {
      release();
    },
  };
}

const stoppers: WorkflowRuntime[] = [];
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((runtime) => runtime.stop()));
});

function runtimeOf(world: World, host: PlayStageHost, migrate: boolean): WorkflowRuntime {
  const runtime = makeRuntime(world, {
    steps: [...GENERIC_STEP_RUNNERS, ...createPlayStepRunners(host)],
    ...(migrate ? { runningOnChange: () => 'migrate_at_safe_point' as const } : {}),
  });
  stoppers.push(runtime);
  return runtime;
}

async function eventsOf(world: World, type: string): Promise<EventEnvelope[]> {
  const all = await world.store.events.readFrom(0, 10_000);
  return all.filter((event) => event.type === type && event.playId === 'play-1');
}

async function nodesRun(world: World): Promise<string[]> {
  return (await eventsOf(world, 'workflow.step.started')).map(
    (event) => (event.payload as { node: string }).node,
  );
}

async function savedOf(world: World) {
  const play = await world.store.plays.get('play-1');
  if (play === undefined) throw new Error('no such run');
  return {
    play,
    saved: play.snapshot as unknown as {
      workflow: { version: string };
      born: { version: string };
    },
  };
}

/** Both versions are published, and a run is born in 2.0.0 and held in the review of the plan. */
async function startHeld(world: World, runtime: WorkflowRuntime, stages: PlayState[]) {
  publish(world, load());
  publish(world, load(readFileSync(PLAY_21, 'utf8')));
  const started = await runtime.start({
    runId: 'play-1',
    scenarioId: SCENARIO,
    definition: load(),
  });
  expect(started.ok).toBe(true);
  await vi.waitFor(() => {
    expect(stages).toContain('REVIEWING_PLAN');
  });
}

describe('the fixture play 2.1.0', () => {
  it('validates, is the play, and says where every node of 2.0.0 goes', () => {
    const next = load(readFileSync(PLAY_21, 'utf8')) as unknown as {
      id: string;
      version: string;
      nodes: Record<string, unknown>;
      migrate_from: Record<string, Record<string, string>>;
    };
    const current = load() as unknown as { nodes: Record<string, unknown> };
    expect(next.id).toBe('play');
    expect(next.version).toBe('2.1.0');
    expect(Object.keys(next.migrate_from['2.0.0'] ?? {}).sort()).toEqual(
      Object.keys(current.nodes).sort(),
    );
  });
});

describe('a run of the play is born in a version and stays there (running_on_change: pin)', () => {
  it('goes on in 2.0.0 after 2.1.0 is activated, and ends there', async () => {
    const world = makeWorld();
    const { host, stages, release } = makeHost('REVIEWING_PLAN');
    const runtime = runtimeOf(world, host, false);
    await startHeld(world, runtime, stages);

    expect(await runtime.onActivated('play', '2.1.0')).toEqual([]);
    release();
    await runtime.idle();

    const { play, saved } = await savedOf(world);
    expect(play.state).toBe('done');
    expect(saved.workflow.version).toBe('2.0.0');
    expect(saved.born.version).toBe('2.0.0');
    expect(await eventsOf(world, 'workflow.migrated')).toEqual([]);
    expect(await nodesRun(world)).toEqual([
      'planning',
      'reviewing_plan',
      'scripting',
      'reviewing_script',
      'executing',
      'integrating',
      'critiquing',
      'delivering',
    ]);
  });
});

describe('a run of the play moves to 2.1.0 at a safe point (migrate_at_safe_point)', () => {
  it('waits for the stage in flight, migrates between two stages, and ends in 2.1.0 born in 2.0.0', async () => {
    const world = makeWorld();
    const { host, stages, release } = makeHost('REVIEWING_PLAN');
    const runtime = runtimeOf(world, host, true);
    await startHeld(world, runtime, stages);

    expect(await runtime.requestMigration('play-1', '2.1.0')).toEqual({ status: 'pending' });
    expect((await savedOf(world)).saved.workflow.version).toBe('2.0.0');
    release();
    await runtime.idle();

    const { play, saved } = await savedOf(world);
    expect(play.state).toBe('done');
    expect(saved.workflow.version).toBe('2.1.0');
    expect(saved.born.version).toBe('2.0.0');
    const migrated = await eventsOf(world, 'workflow.migrated');
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.payload).toMatchObject({
      from: { id: 'play', version: '2.0.0' },
      to: { id: 'play', version: '2.1.0' },
      // The safe point is between two stages: the run is at the entry of the next one.
      fromState: 'scripting',
      toState: 'scripting',
    });
    // Each stage ran once: the migration did not repeat the review it was asked during.
    expect(stages).toEqual([
      'PLANNING',
      'REVIEWING_PLAN',
      'SCRIPTING',
      'REVIEWING_SCRIPT',
      'EXECUTING',
      'INTEGRATING',
      'CRITIQUING',
      'DELIVERING',
    ]);
  });

  it('migrates a run by activation, and survives a restart that comes before the safe point', async () => {
    const world = makeWorld();
    const first = makeHost('REVIEWING_PLAN');
    const one = runtimeOf(world, first.host, true);
    await startHeld(world, one, first.stages);
    expect(await one.requestMigration('play-1', '2.1.0')).toEqual({ status: 'pending' });
    await one.stop();

    // The new process: the stage is not held any more, the request is in the saved state.
    const second = makeHost('NONE' as PlayState);
    const two = runtimeOf(world, second.host, true);
    expect(await two.resumeAll()).toMatchObject({ resumed: ['play-1'] });
    await two.idle();

    const { play, saved } = await savedOf(world);
    expect(play.state).toBe('done');
    expect(saved.workflow.version).toBe('2.1.0');
    expect(await eventsOf(world, 'workflow.migrated')).toHaveLength(1);
  });
});
