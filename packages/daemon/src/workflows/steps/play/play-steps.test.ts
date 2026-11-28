// SPDX-License-Identifier: MPL-2.0
import { PLAY_STEP_TYPES } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import type { PlayContext } from '../../../pipeline/context.js';
import { PLAY_STATES, type PlayState } from '../../../pipeline/definitions.js';
import { entryEffects, type PlayEffect } from '../../../pipeline/effects.js';
import { Model } from '../../../pipeline/model-fixture.js';
import type { StepContext, StepResult } from '../types.js';
import {
  PLAY_STEP_MODULES,
  PLAY_STEP_TYPE_IDS,
  createPlayStepRunners,
  playStepModule,
  stateOfNode,
  type PlayStageHost,
} from './index.js';

/** Phase 11b, P3: the play step types wrap the stage code that already exists. */

function playContext(): PlayContext {
  const model = new Model();
  model.send({ type: 'START' });
  return model.context;
}

function fakeStep(node: string, signal = new AbortController().signal): StepContext {
  return {
    runId: 'run-1',
    workflow: { id: 'play', version: '2.0.0' },
    scenarioId: 's1',
    node,
    step: 'plan',
    ordinal: 1,
    key: `run-1:${node}:1`,
    params: {},
    inputs: {},
    signal,
    resumed: false,
    approvals: 0,
    memo: { get: () => undefined, set: () => Promise.resolve() },
    deps: {} as StepContext['deps'],
  };
}

describe('the play step modules', () => {
  it('cover the nine step types of the plan, plus await_producer', () => {
    expect([...PLAY_STEP_TYPE_IDS].sort()).toEqual(
      [
        'plan',
        'clarify',
        'review',
        'script',
        'execute_dag',
        'integrate',
        'critique',
        'decide',
        'deliver',
        'await_producer',
      ].sort(),
    );
    expect(PLAY_STEP_MODULES.map((module) => module.type)).toEqual([...PLAY_STEP_TYPE_IDS]);
  });

  it('are step types the validator of the engine knows', () => {
    const known = new Set(PLAY_STEP_TYPES.map((spec) => spec.id));
    for (const type of PLAY_STEP_TYPE_IDS) expect(known.has(type)).toBe(true);
  });

  it('stand for every state of the machine that runs a stage, once', () => {
    const states = PLAY_STEP_MODULES.flatMap((module) => [...module.states]).sort();
    const stages = PLAY_STATES.filter(
      (state) => !['NEED', 'DONE', 'CANCELLED'].includes(state),
    ).sort();
    expect(states).toEqual(stages);
  });

  it('ask for the effects the machine asks for on entry, with nothing written again', () => {
    const context = playContext();
    for (const module of PLAY_STEP_MODULES) {
      for (const state of module.states) {
        expect(module.effects(state, context)).toEqual(entryEffects(state, context));
      }
    }
  });

  it('refuse a state that is not theirs', () => {
    const module = playStepModule('plan');
    expect(() => module?.effects('SCRIPTING', playContext())).toThrow(RangeError);
    expect(playStepModule('call_tool')).toBeUndefined();
  });

  it('read the state from the node id', () => {
    expect(stateOfNode('reviewing_plan')).toBe('REVIEWING_PLAN');
  });
});

describe('the play step runners', () => {
  function host(result: StepResult) {
    const calls: { state: PlayState; effects: readonly PlayEffect[]; runId: string }[] = [];
    const port: PlayStageHost = {
      contextOf: () => Promise.resolve(playContext()),
      runStage: (call) => {
        calls.push({ state: call.state, effects: call.effects, runId: call.runId });
        return Promise.resolve(result);
      },
    };
    return { port, calls };
  }

  it('give a runner to each type, and a visit runs the stage of its node', async () => {
    const { port, calls } = host({ kind: 'done', output: { has_open_questions: false } });
    const runners = createPlayStepRunners(port);
    expect(runners.map((runner) => runner.type)).toEqual([...PLAY_STEP_TYPE_IDS]);
    const plan = runners.find((runner) => runner.type === 'plan');
    const result = await plan?.run(fakeStep('planning'));
    expect(result).toEqual({ kind: 'done', output: { has_open_questions: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe('PLANNING');
    expect(calls[0]?.runId).toBe('run-1');
    expect(calls[0]?.effects).toEqual(entryEffects('PLANNING', playContext()));
  });

  it('review runs for both of its nodes', async () => {
    const { port, calls } = host({ kind: 'done', output: { approved: true } });
    const review = createPlayStepRunners(port).find((runner) => runner.type === 'review');
    await review?.run(fakeStep('reviewing_plan'));
    await review?.run(fakeStep('reviewing_script'));
    expect(calls.map((call) => call.state)).toEqual(['REVIEWING_PLAN', 'REVIEWING_SCRIPT']);
  });

  it('fail with a reason, not a throw, on a node that is not of the type', async () => {
    const { port, calls } = host({ kind: 'done', output: {} });
    const plan = createPlayStepRunners(port).find((runner) => runner.type === 'plan');
    const result = await plan?.run(fakeStep('scripting'));
    expect(result).toMatchObject({ kind: 'failed', reason: 'play_state_unknown' });
    expect(calls).toEqual([]);
  });

  it('pass a failure or a cancellation of the stage on as it came', async () => {
    const failed = host({ kind: 'failed', reason: 'stage_failed' });
    const plan = createPlayStepRunners(failed.port).find((runner) => runner.type === 'plan');
    expect(await plan?.run(fakeStep('planning'))).toEqual({
      kind: 'failed',
      reason: 'stage_failed',
    });
    const cancelled = host({ kind: 'cancelled' });
    const script = createPlayStepRunners(cancelled.port).find((runner) => runner.type === 'script');
    expect(await script?.run(fakeStep('scripting'))).toEqual({ kind: 'cancelled' });
  });
});
