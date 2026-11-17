// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { PlayEventSchema } from './events.js';
import { limitsOf, Model } from './model-fixture.js';

/** A play with beta approved and alpha still running: the rebase of beta conflicts. */
function withApprovedBeta(): Model {
  const model = new Model(limitsOf('moderate')).toExecuting(['alpha', 'beta']);
  model.send({ type: 'DEMAND_APPROVED', demandId: 'beta' });
  expect(model.state).toBe('EXECUTING');
  return model;
}

const conflict = (mode: 'redo' | 'script_failure' | 'resolve_attempt') => ({
  type: 'REBASE_CONFLICT' as const,
  demandId: 'beta',
  mode,
  files: ['a.txt'],
  reason: 'conflict in a.txt',
});

describe('N82: a rebase of a dependent that conflicts', () => {
  it('redo: opens a new attempt of the dependent, counted in attempts_per_demand', () => {
    const model = withApprovedBeta();
    model.send(conflict('redo'));
    expect(model.state).toBe('EXECUTING');
    expect(model.counter('attempts_per_demand:beta')).toBe(1);
    expect(model.counter('script_returns')).toBe(0);
    expect(model.context.approvedDemands).not.toContain('beta');
    expect(model.effect('run_demands')).toMatchObject({
      demandIds: ['beta'],
      strategy: 'redo',
      retry: true,
      feedback: 'conflict in a.txt',
    });
  });

  it('redo: the attempts run out like any other, and the play goes to the Producer', () => {
    const model = withApprovedBeta();
    const { attempts_per_demand } = model.context.limits;
    for (let i = 0; i < attempts_per_demand - 1; i += 1) {
      model.send(conflict('redo'));
      expect(model.state).toBe('EXECUTING');
      model.send({ type: 'DEMAND_APPROVED', demandId: 'beta' });
    }
    model.send(conflict('redo'));
    expect(model.state).toBe('AWAITING_PRODUCER');
    expect(model.context.producerReason).toMatchObject({
      kind: 'limit',
      counter: 'attempts_per_demand',
      demandId: 'beta',
      resumeTo: 'EXECUTING',
    });
  });

  it('resolve_attempt: opens an attempt only to resolve the conflict, counted the same way', () => {
    const model = withApprovedBeta();
    model.send(conflict('resolve_attempt'));
    expect(model.state).toBe('EXECUTING');
    expect(model.counter('attempts_per_demand:beta')).toBe(1);
    expect(model.effect('run_demands')).toMatchObject({
      demandIds: ['beta'],
      strategy: 'resolve',
      retry: true,
    });
    expect(model.context.approvedDemands).not.toContain('beta');
  });

  it('script_failure: goes back to SCRIPTING on script_returns, with the files as feedback', () => {
    const model = withApprovedBeta();
    model.send(conflict('script_failure'));
    expect(model.state).toBe('SCRIPTING');
    expect(model.counter('script_returns')).toBe(1);
    expect(model.counter('attempts_per_demand:beta')).toBe(0);
    expect(model.effectTypes()).toEqual(['abort_work', 'run_stage']);
    expect(model.effect('run_stage')).toMatchObject({ feedback: 'conflict in a.txt' });
  });

  it('ignores a conflict of a demand that is not in the script', () => {
    const model = withApprovedBeta();
    expect(model.can({ ...conflict('redo'), demandId: 'ghost' })).toBe(false);
  });
});

describe('N83: the base moved while the play ran', () => {
  function delivering(): Model {
    const model = new Model(limitsOf('moderate')).start('waived');
    model.toScripting();
    model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['alpha'] });
    model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    model.send({ type: 'DEMAND_APPROVED', demandId: 'alpha' });
    model.send({ type: 'INTEGRATED', ok: true });
    expect(model.state).toBe('DELIVERING');
    return model;
  }

  it('update: a conflict is a script failure that goes back to SCRIPTING and counts', () => {
    const model = delivering();
    model.send({
      type: 'BASE_DRIFT',
      mode: 'update',
      files: ['a.txt'],
      reason: 'main moved: a.txt',
    });
    expect(model.state).toBe('SCRIPTING');
    expect(model.counter('script_returns')).toBe(1);
    expect(model.effect('run_stage')).toMatchObject({
      stage: 'SCRIPTING',
      feedback: 'main moved: a.txt',
    });
  });

  it('update: when script_returns is spent the play goes to the Producer', () => {
    const model = delivering();
    const { script_returns } = model.context.limits;
    model.send({ type: 'BASE_DRIFT', mode: 'update', files: ['a.txt'], reason: 'x' });
    for (let i = 0; i < script_returns; i += 1) {
      model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['alpha'] });
      model.send({ type: 'SCRIPT_REVIEWED', approved: true });
      model.send({ type: 'DEMAND_APPROVED', demandId: 'alpha' });
      model.send({ type: 'INTEGRATED', ok: true });
      model.send({ type: 'BASE_DRIFT', mode: 'update', files: ['a.txt'], reason: 'x' });
    }
    expect(model.state).toBe('AWAITING_PRODUCER');
    expect(model.context.producerReason).toMatchObject({
      kind: 'limit',
      counter: 'script_returns',
    });
  });

  it('ask: goes to the Producer with only redo, deliver with the conflict and cancel', () => {
    const model = delivering();
    model.send({ type: 'BASE_DRIFT', mode: 'ask', files: ['a.txt'], reason: 'main moved: a.txt' });
    expect(model.state).toBe('AWAITING_PRODUCER');
    expect(model.counter('script_returns')).toBe(0);
    expect(model.effect('ask_menu')).toMatchObject({
      options: ['redo_on_new_base', 'deliver_with_conflict', 'cancel'],
      reason: { kind: 'base_drift', files: ['a.txt'], reason: 'main moved: a.txt' },
    });
  });

  it('ask, redo: goes back to SCRIPTING without counting, with the conflicts as feedback', () => {
    const model = delivering();
    model.send({ type: 'BASE_DRIFT', mode: 'ask', files: ['a.txt'], reason: 'main moved: a.txt' });
    model.send({ type: 'PRODUCER_CHOSE', option: 'redo_on_new_base' });
    expect(model.state).toBe('SCRIPTING');
    expect(model.counter('script_returns')).toBe(0);
    expect(model.effect('run_stage')).toMatchObject({ feedback: 'main moved: a.txt' });
    expect(model.context.producerReason).toBeNull();
    expect(model.decisions.at(-1)).toMatchObject({
      kind: 'menu_choice',
      answer: { option: 'redo_on_new_base' },
      decidedBy: 'producer',
    });
  });

  it('ask, deliver with the conflict: delivers again, with the drift accepted', () => {
    const model = delivering();
    expect(model.effect('deliver')).toMatchObject({ driftAccepted: false });
    model.send({ type: 'BASE_DRIFT', mode: 'ask', files: ['a.txt'], reason: 'x' });
    model.send({ type: 'PRODUCER_CHOSE', option: 'deliver_with_conflict' });
    expect(model.state).toBe('DELIVERING');
    expect(model.effect('deliver')).toMatchObject({ driftAccepted: true });
    model.send({ type: 'DELIVERED' });
    expect(model.state).toBe('DONE');
  });

  it('ask, cancel: ends the play', () => {
    const model = delivering();
    model.send({ type: 'BASE_DRIFT', mode: 'ask', files: [], reason: 'x' });
    model.send({ type: 'PRODUCER_CHOSE', option: 'cancel' });
    expect(model.state).toBe('CANCELLED');
  });

  it('the two options of the drift are refused for any other reason, and the others for the drift', () => {
    const model = delivering();
    // in DELIVERING the menu does not exist; go to a spent counter first
    const spent = new Model(limitsOf('economical')).toDeciding();
    spent.classify([{ kind: 'structural' }]);
    expect(spent.can({ type: 'PRODUCER_CHOSE', option: 'redo_on_new_base' })).toBe(false);
    expect(spent.can({ type: 'PRODUCER_CHOSE', option: 'deliver_with_conflict' })).toBe(false);
    model.send({ type: 'BASE_DRIFT', mode: 'ask', files: [], reason: 'x' });
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'redefine_need', need: 'n' })).toBe(false);
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'deliver_ready' })).toBe(false);
  });
});

describe('N84: the new script keeps the demands that did not change', () => {
  /** EXECUTING -> a script failure of beta -> SCRIPTING, with alpha approved. */
  function rescripting(): Model {
    const model = new Model(limitsOf('moderate')).toExecuting(['alpha', 'beta']);
    model.send({ type: 'DEMAND_APPROVED', demandId: 'alpha' });
    model.send({ type: 'DEMAND_BLOCKED', demandId: 'beta', reason: 'beta is not enough' });
    expect(model.state).toBe('SCRIPTING');
    expect(model.context.approvedDemands).toEqual(['alpha']);
    return model;
  }

  it('keeps the approval of a kept demand, and only the changed one is run', () => {
    const model = rescripting();
    model.send({
      type: 'SCRIPT_VALIDATED',
      valid: true,
      demandIds: ['alpha', 'beta'],
      keptDemandIds: ['alpha'],
    });
    expect(model.context.approvedDemands).toEqual(['alpha']);
    model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    expect(model.state).toBe('EXECUTING');
    expect(model.effect('run_demands')).toMatchObject({ demandIds: ['beta'] });
  });

  it('a script that keeps nothing starts over, as before', () => {
    const model = rescripting();
    model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['alpha', 'beta'] });
    expect(model.context.approvedDemands).toEqual([]);
    model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    expect(model.effect('run_demands')).toMatchObject({ demandIds: ['alpha', 'beta'] });
  });

  it('a demand marked as kept that was never approved is run', () => {
    const model = rescripting();
    model.send({
      type: 'SCRIPT_VALIDATED',
      valid: true,
      demandIds: ['alpha', 'beta'],
      keptDemandIds: ['alpha', 'beta'],
    });
    expect(model.context.approvedDemands).toEqual(['alpha']);
  });

  it('goes straight to INTEGRATING when every demand is kept', () => {
    const model = new Model(limitsOf('moderate')).start('waived');
    model.toScripting();
    model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['alpha'] });
    model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    model.send({ type: 'DEMAND_APPROVED', demandId: 'alpha' });
    model.send({ type: 'INTEGRATED', ok: true });
    model.send({ type: 'BASE_DRIFT', mode: 'update', files: ['a.txt'], reason: 'x' });
    expect(model.state).toBe('SCRIPTING');
    model.send({
      type: 'SCRIPT_VALIDATED',
      valid: true,
      demandIds: ['alpha'],
      keptDemandIds: ['alpha'],
    });
    model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    expect(model.state).toBe('INTEGRATING');
    expect(model.effect('integrate')).toMatchObject({ demandIds: ['alpha'] });
  });

  it('refuses a kept demand that is not in the script', () => {
    const base = { type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['alpha'] };
    expect(PlayEventSchema.safeParse({ ...base, keptDemandIds: ['alpha'] }).success).toBe(true);
    expect(PlayEventSchema.safeParse({ ...base, keptDemandIds: ['ghost'] }).success).toBe(false);
  });
});
