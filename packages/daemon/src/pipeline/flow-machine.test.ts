// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { PlayFlowRef } from './context.js';
import { limitsOf, Model } from './model-fixture.js';
import { PLAY_FLOW_VERSION } from './definitions.js';
import { playMachine } from './machine.js';

const HASH = 'a'.repeat(64);

function flowOf(...skip: PlayFlowRef['skip'][number][]): PlayFlowRef {
  return { id: 'quick', version: 1, hash: HASH, skip };
}

/** A play of this flow, from NEED to the end, with the answers that approve everything. */
function runToDone(model: Model, options: { questions?: boolean } = {}): string[] {
  const path: string[] = [];
  const note = (): void => void path.push(model.state);
  model.start();
  note();
  model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: options.questions === true });
  note();
  if (model.state === 'CLARIFYING') {
    model.send({ type: 'QUESTIONS_ANSWERED' });
    note();
  }
  if (model.state === 'REVIEWING_PLAN') {
    model.send({ type: 'PLAN_REVIEWED', approved: true });
    note();
  }
  model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1'] });
  note();
  model.send({ type: 'SCRIPT_REVIEWED', approved: true });
  note();
  model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' });
  note();
  model.send({ type: 'INTEGRATED', ok: true });
  note();
  if (model.state === 'CRITIQUING') {
    model.send({ type: 'CRITIQUED', approved: true });
    note();
  }
  model.send({ type: 'DELIVERED' });
  note();
  return path;
}

describe('a flow of the configuration in the play machine (P12)', () => {
  it('without the review of the plan, goes from the plan to the script and reaches DONE', () => {
    const model = new Model(limitsOf('moderate'), 'a need', flowOf('plan_review'));
    const path = runToDone(model);
    expect(path).not.toContain('REVIEWING_PLAN');
    expect(path).toEqual([
      'PLANNING',
      'SCRIPTING',
      'REVIEWING_SCRIPT',
      'EXECUTING',
      'INTEGRATING',
      'CRITIQUING',
      'DELIVERING',
      'DONE',
    ]);
  });

  it('without the review of the plan, the answers to the questions also go to the script', () => {
    const model = new Model(limitsOf('moderate'), 'a need', flowOf('plan_review'));
    const path = runToDone(model, { questions: true });
    expect(path.slice(0, 3)).toEqual(['PLANNING', 'CLARIFYING', 'SCRIPTING']);
    expect(path).not.toContain('REVIEWING_PLAN');
    expect(model.state).toBe('DONE');
  });

  it('asks the Scriptwriter for the script with the role of the stage, as in the official play', () => {
    const model = new Model(limitsOf('moderate'), 'a need', flowOf('plan_review')).start();
    model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    expect(model.effect('run_stage')).toMatchObject({ stage: 'SCRIPTING', role: 'scriptwriter' });
  });

  it('without the critique, delivers right after the integration and the PR says so', () => {
    const model = new Model(limitsOf('moderate'), 'a need', flowOf('critique'));
    const path = runToDone(model);
    expect(path).not.toContain('CRITIQUING');
    expect(path).not.toContain('DECIDING');
    expect(path.slice(-3)).toEqual(['INTEGRATING', 'DELIVERING', 'DONE']);
    // the flow is the cause, not a waiver of the Producer
    expect(model.context.criticWaived).toBe(false);
  });

  it('marks the delivery of a flow without the critique, and only that one', () => {
    const without = new Model(limitsOf('moderate'), 'a need', flowOf('critique')).toExecuting();
    without.approveAll().send({ type: 'INTEGRATED', ok: true });
    expect(without.effect('deliver')).toMatchObject({
      criticWaived: false,
      criticSkippedBy: 'quick',
    });

    const withCritique = new Model(limitsOf('moderate'), 'a need', flowOf('plan_review'));
    withCritique.toCritiquing();
    expect(withCritique.state).toBe('CRITIQUING');
    withCritique.send({ type: 'CRITIQUED', approved: true });
    expect('criticSkippedBy' in withCritique.effect('deliver')).toBe(false);
  });

  it('keeps the counters in force: the mandatory loops still end in the Producer', () => {
    const model = new Model(limitsOf('economical'), 'a need', flowOf('plan_review', 'critique'));
    model.toExecuting(['d1']);
    // the first veto is allowed, the second is over the limit of `economical`
    expect(model.state).toBe('EXECUTING');
    model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' }).send({ type: 'INTEGRATED', ok: false });
    expect(model.counter('script_returns')).toBe(1);
    expect(model.state).toBe('SCRIPTING');
  });

  it('writes the flow in the snapshot, and only a flow of the configuration does', () => {
    const model = new Model(limitsOf('moderate'), 'a need', flowOf('plan_review')).start();
    const persisted = playMachine.getPersistedSnapshot(model.snapshot) as unknown as {
      context: { flow?: unknown; flowId: string; flowVersion: number };
    };
    expect(persisted.context.flow).toEqual({
      id: 'quick',
      version: 1,
      hash: HASH,
      skip: ['plan_review'],
    });
    // the machine itself stays the official play, so a saved play restores as before
    expect(persisted.context).toMatchObject({ flowId: 'play', flowVersion: PLAY_FLOW_VERSION });

    const official = new Model().start();
    const plain = playMachine.getPersistedSnapshot(official.snapshot) as unknown as {
      context: Record<string, unknown>;
    };
    expect('flow' in plain.context).toBe(false);
  });

  it('runs the official play as it was when there is no flow', () => {
    const model = new Model();
    const path = runToDone(model);
    expect(path).toContain('REVIEWING_PLAN');
    expect(path).toContain('CRITIQUING');
    expect(
      'criticSkippedBy' in
        new Model().toCritiquing().send({ type: 'CRITIQUED', approved: true }).effect('deliver'),
    ).toBe(false);
  });
});
