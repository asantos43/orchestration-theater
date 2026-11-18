// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { availableMenu } from './menu.js';
import { CRITICAL_EXCEPTIONS, MENU_OPTIONS, type MenuOption } from './definitions.js';
import { limitsOf, Model, PRESETS } from './model-fixture.js';

/** Every option except the ones of a drifted base (N83) and of the delivery question (N89). */
const LIMIT_MENU = MENU_OPTIONS.filter(
  (option) =>
    option !== 'redo_on_new_base' &&
    option !== 'deliver_with_conflict' &&
    option !== 'deliver_pr' &&
    option !== 'deliver_merge',
);

function menuOf(model: Model): readonly MenuOption[] {
  return model.effect('ask_menu').options;
}

/** The play is waiting for the Producer, with the options of the fixed menu that hold. */
function expectAwaiting(model: Model, menu: readonly MenuOption[]): void {
  expect(model.state).toBe('AWAITING_PRODUCER');
  expect(menuOf(model)).toEqual(menu);
  expect(availableMenu(model.context)).toEqual(menu);
  // the menu is a closed list, in the fixed order
  expect(menu.every((option) => MENU_OPTIONS.includes(option))).toBe(true);
}

describe('the states of the play', () => {
  it('walks the whole flow from NEED to DONE, asking for the work of each state', () => {
    const model = new Model();
    expect(model.state).toBe('NEED');
    expect(model.effects).toEqual([]);

    model.start();
    expect(model.state).toBe('PLANNING');
    expect(model.effect('run_stage')).toMatchObject({ stage: 'PLANNING', role: 'author' });

    model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: true });
    expect(model.state).toBe('CLARIFYING');
    expect(model.effect('run_stage')).toMatchObject({ role: 'director' });

    model.send({ type: 'QUESTIONS_ANSWERED' });
    expect(model.state).toBe('REVIEWING_PLAN');
    expect(model.effect('run_stage')).toMatchObject({ role: 'reviewer' });

    model.send({ type: 'PLAN_REVIEWED', approved: true });
    expect(model.state).toBe('SCRIPTING');
    expect(model.effect('run_stage')).toMatchObject({ role: 'scriptwriter' });

    model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1', 'd2'] });
    expect(model.state).toBe('REVIEWING_SCRIPT');
    expect(model.context.demandIds).toEqual(['d1', 'd2']);

    model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    expect(model.state).toBe('EXECUTING');
    expect(model.effect('run_demands')).toMatchObject({
      demandIds: ['d1', 'd2'],
      strategy: 'same',
      retry: false,
    });

    model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' });
    expect(model.state).toBe('EXECUTING');
    model.send({ type: 'DEMAND_APPROVED', demandId: 'd2' });
    expect(model.state).toBe('INTEGRATING');
    expect(model.effect('integrate')).toMatchObject({ demandIds: ['d1', 'd2'] });

    model.send({ type: 'INTEGRATED', ok: true });
    expect(model.state).toBe('CRITIQUING');
    expect(model.effect('run_stage')).toMatchObject({ role: 'critic' });

    model.send({ type: 'CRITIQUED', approved: true });
    expect(model.state).toBe('DELIVERING');
    expect(model.effect('deliver')).toMatchObject({
      demandIds: ['d1', 'd2'],
      partial: false,
      criticWaived: false,
    });

    model.send({ type: 'DELIVERED' });
    expect(model.state).toBe('DONE');
    expect(model.snapshot.status).toBe('done');
    expect(model.can({ type: 'CANCEL' })).toBe(false);
  });

  it('skips CLARIFYING when the plan has no open question', () => {
    const model = new Model().start().send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    expect(model.state).toBe('REVIEWING_PLAN');
  });

  it('refuses an event the state does not take', () => {
    const model = new Model();
    expect(model.can({ type: 'DELIVERED' })).toBe(false);
    expect(model.can({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false })).toBe(false);
    model.start();
    expect(model.can({ type: 'START' })).toBe(false);
    expect(model.can({ type: 'DEMAND_APPROVED', demandId: 'd1' })).toBe(false);
  });

  it('lets the Producer cancel from any state that is not final', () => {
    const model = new Model().toExecuting();
    model.send({ type: 'CANCEL' });
    expect(model.state).toBe('CANCELLED');
    expect(model.snapshot.status).toBe('done');
    expect(model.effect('abort_work')).toMatchObject({ reason: 'cancelled' });
  });

  it('asks for the stage again with the reason of the return', () => {
    const model = new Model().start().send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    model.send({ type: 'PLAN_REVIEWED', approved: false, reason: 'the plan lacks tests' });
    expect(model.state).toBe('PLANNING');
    expect(model.effect('run_stage')).toMatchObject({
      stage: 'PLANNING',
      feedback: 'the plan lacks tests',
    });
  });
});

describe.each(PRESETS)('the loop counters, preset %s', (preset) => {
  const limits = limitsOf(preset);
  const fresh = () => new Model(limits);

  it('plan_reviews: counts each return and ends in the Producer when it runs out', () => {
    const model = fresh().start();
    for (let i = 1; i <= limits.plan_reviews; i += 1) {
      model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      model.send({ type: 'PLAN_REVIEWED', approved: false, reason: `r${String(i)}` });
      expect(model.state).toBe('PLANNING');
      expect(model.counter('plan_reviews')).toBe(i);
    }
    model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    model.send({ type: 'PLAN_REVIEWED', approved: false });
    expectAwaiting(model, ['redefine_need', 'raise_limit', 'cancel']);
    expect(model.context.producerReason).toEqual({
      kind: 'limit',
      counter: 'plan_reviews',
      demandId: null,
      resumeTo: 'PLANNING',
    });
    expect(model.counter('plan_reviews')).toBe(limits.plan_reviews + 1);
  });

  it('script_validations: counts each invalid script', () => {
    const model = fresh().toScripting();
    for (let i = 1; i <= limits.script_validations; i += 1) {
      model.send({ type: 'SCRIPT_VALIDATED', valid: false, reason: 'cycle in the DAG' });
      expect(model.state).toBe('SCRIPTING');
      expect(model.counter('script_validations')).toBe(i);
      expect(model.effect('run_stage').feedback).toBe('cycle in the DAG');
    }
    model.send({ type: 'SCRIPT_VALIDATED', valid: false });
    expectAwaiting(model, ['redefine_need', 'raise_limit', 'cancel']);
    expect(model.context.producerReason).toMatchObject({
      kind: 'limit',
      counter: 'script_validations',
      resumeTo: 'SCRIPTING',
    });
  });

  it('script_vetoes: counts each veto of the Author', () => {
    const model = fresh().toScripting();
    for (let i = 1; i <= limits.script_vetoes; i += 1) {
      model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1'] });
      model.send({ type: 'SCRIPT_REVIEWED', approved: false, reason: 'veto' });
      expect(model.state).toBe('SCRIPTING');
      expect(model.counter('script_vetoes')).toBe(i);
    }
    model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1'] });
    model.send({ type: 'SCRIPT_REVIEWED', approved: false });
    expectAwaiting(model, ['redefine_need', 'raise_limit', 'cancel']);
    expect(model.context.producerReason).toMatchObject({
      counter: 'script_vetoes',
      resumeTo: 'SCRIPTING',
    });
  });

  it('script_returns: a blocked Actor and a merge conflict both count, without the Critic', () => {
    const model = fresh().toExecuting(['d1']);
    for (let i = 1; i <= limits.script_returns; i += 1) {
      if (model.state === 'EXECUTING') {
        if (i % 2 === 1) {
          model.send({ type: 'DEMAND_BLOCKED', demandId: 'd1', reason: 'not enough' });
        } else {
          model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' });
          model.send({ type: 'INTEGRATED', ok: false, reason: 'conflict' });
        }
      }
      expect(model.state).toBe('SCRIPTING');
      expect(model.counter('script_returns')).toBe(i);
      expect(model.effectTypes()).toContain('abort_work');
      model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1'] });
      model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    }
    model.send({ type: 'DEMAND_BLOCKED', demandId: 'd1' });
    expectAwaiting(model, ['redefine_need', 'raise_limit', 'cancel']);
    expect(model.context.producerReason).toMatchObject({
      counter: 'script_returns',
      resumeTo: 'SCRIPTING',
    });
  });

  it('attempts_per_demand: counts per demand, and the last attempt ends in the Producer', () => {
    const model = fresh().toExecuting(['d1', 'd2']);
    for (let i = 1; i < limits.attempts_per_demand; i += 1) {
      model.send({ type: 'ATTEMPT_FAILED', demandId: 'd1', reason: `try ${String(i)}` });
      expect(model.state).toBe('EXECUTING');
      expect(model.counter('attempts_per_demand:d1')).toBe(i);
      expect(model.effect('run_demands')).toMatchObject({
        demandIds: ['d1'],
        retry: true,
        feedback: `try ${String(i)}`,
      });
    }
    // another demand has its own count
    expect(model.counter('attempts_per_demand:d2')).toBe(0);
    model.send({ type: 'ATTEMPT_FAILED', demandId: 'd1' });
    expectAwaiting(model, ['redefine_need', 'raise_limit', 'cancel']);
    expect(model.context.producerReason).toEqual({
      kind: 'limit',
      counter: 'attempts_per_demand',
      demandId: 'd1',
      resumeTo: 'EXECUTING',
    });
    expect(model.counter('attempts_per_demand:d1')).toBe(limits.attempts_per_demand);
  });

  it('critic_rejections and structural_restarts: the rejections above the limit restart the plan', () => {
    const model = fresh().toCritiquing();
    for (let i = 1; i <= limits.critic_rejections; i += 1) {
      model.send({ type: 'CRITIQUED', approved: false, reason: `critique ${String(i)}` });
      expect(model.state).toBe('DECIDING');
      expect(model.counter('critic_rejections')).toBe(i);
      expect(model.effect('judge')).toMatchObject({ point: 'classify_critique' });
      // an invalid answer is not taken
      expect(() => model.classify([{ type: 'x' }])).toThrow();
      expect(model.state).toBe('DECIDING');
      model.classify([{ kind: 'execution', demandIds: ['d1'] }]);
      expect(model.state).toBe('EXECUTING');
      model.approveAll().send({ type: 'INTEGRATED', ok: true });
      expect(model.state).toBe('CRITIQUING');
    }
    model.send({ type: 'CRITIQUED', approved: false, reason: 'again' });
    if (limits.structural_restarts === 0) {
      // economical: no restart is allowed, so the play goes to the Producer, with every option
      expectAwaiting(model, LIMIT_MENU);
      expect(model.context.producerReason).toMatchObject({
        counter: 'structural_restarts',
        resumeTo: 'PLANNING',
      });
    } else {
      expect(model.state).toBe('PLANNING');
      expect(model.counter('structural_restarts')).toBe(1);
      // the other counters start over
      expect(model.counter('critic_rejections')).toBe(0);
      expect(model.context.demandIds).toEqual([]);
      expect(model.effect('run_stage')).toMatchObject({ restart: true, feedback: 'again' });
    }
  });

  it('structural_restarts: each structural failure restarts the plan, and the last goes to the Producer', () => {
    const model = fresh();
    for (let i = 1; i <= limits.structural_restarts; i += 1) {
      model.toDeciding().classify([{ kind: 'structural', note: 'wrong approach' }]);
      expect(model.state).toBe('PLANNING');
      expect(model.counter('structural_restarts')).toBe(i);
      expect(model.context.restart).toBe(true);
      expect(model.counter('critic_rejections')).toBe(0);
      expect(model.context.approvedDemands).toEqual([]);
    }
    model.toDeciding().classify([{ kind: 'structural' }]);
    expect(model.state).toBe('AWAITING_PRODUCER');
    expect(model.context.producerReason).toMatchObject({
      kind: 'limit',
      counter: 'structural_restarts',
    });
    expect(menuOf(model)).toContain('raise_limit');
  });

  it('submit_retries: carries the preset value to the session and ends in the Producer when spent', () => {
    const model = fresh().start();
    expect(model.effect('run_stage').submitRetries).toBe(limits.submit_retries);
    model.send({ type: 'SUBMIT_FAILED', reason: 'invalid plan' });
    expectAwaiting(model, ['redefine_need', 'raise_limit', 'cancel']);
    expect(model.context.producerReason).toMatchObject({
      counter: 'submit_retries',
      resumeTo: 'PLANNING',
    });
  });

  it('demand deadlines: the script timeout, or the default, never above the ceiling', () => {
    const model = fresh().toExecuting(['d1', 'd2', 'd3']);
    model.send({ type: 'DEMAND_STARTED', demandId: 'd1' });
    model.send({ type: 'DEMAND_STARTED', demandId: 'd2', timeoutMin: 1 });
    model.send({ type: 'DEMAND_STARTED', demandId: 'd3', timeoutMin: 100_000 });
    expect(model.context.deadlines).toEqual({
      d1: model.now + limits.demand_timeout,
      d2: model.now + 60_000,
      d3: model.now + limits.demand_timeout_max,
    });
    expect(model.can({ type: 'DEMAND_STARTED', demandId: 'ghost' })).toBe(false);
  });
});

describe('the limits overrides', () => {
  it('an override of one key changes only its counter', () => {
    const model = new Model(limitsOf('moderate', { plan_reviews: 0 })).start();
    model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    model.send({ type: 'PLAN_REVIEWED', approved: false });
    expect(model.state).toBe('AWAITING_PRODUCER');
    const other = new Model(limitsOf('moderate', { plan_reviews: 0 })).toScripting();
    other.send({ type: 'SCRIPT_VALIDATED', valid: false });
    expect(other.state).toBe('SCRIPTING');
  });
});

describe('the Critic', () => {
  it('goes through CRITIQUING when it counts, and skips it when it was waived at the opening', () => {
    expect(
      new Model().toExecuting().approveAll().send({ type: 'INTEGRATED', ok: true }).state,
    ).toBe('CRITIQUING');
    const waived = new Model().start('the change is a typo');
    expect(waived.decisions).toEqual([
      {
        id: 'p1:d1',
        kind: 'dispense_critic',
        input: { moment: 'open' },
        answer: { moment: 'open', reason: 'the change is a typo' },
        decidedBy: 'producer',
      },
    ]);
    expect(waived.context.criticWaived).toBe(true);
    waived.toExecuting().approveAll().send({ type: 'INTEGRATED', ok: true });
    expect(waived.state).toBe('DELIVERING');
    expect(waived.effect('deliver').criticWaived).toBe(true);
  });

  it('a conflict in the integration is a script failure and does not go to the Critic', () => {
    const model = new Model().toExecuting(['d1']).approveAll();
    model.send({ type: 'INTEGRATED', ok: false, reason: 'conflict in a.ts' });
    expect(model.state).toBe('SCRIPTING');
    expect(model.effect('run_stage').feedback).toBe('conflict in a.ts');
  });

  it('accept as is, after a rejection, waives the Critic and records it as a decision', () => {
    const model = new Model(limitsOf('economical')).toDeciding();
    model.classify([{ kind: 'structural' }]);
    expectAwaiting(model, LIMIT_MENU);
    const before = model.decisions.length;
    model.send({ type: 'PRODUCER_CHOSE', option: 'accept_as_is', reason: 'good enough for now' });
    expect(model.state).toBe('DELIVERING');
    expect(model.context.criticWaived).toBe(true);
    expect(model.effect('deliver')).toMatchObject({ criticWaived: true, partial: false });
    expect(model.decisions).toHaveLength(before + 1);
    expect(model.decisions.at(-1)).toMatchObject({
      kind: 'dispense_critic',
      input: { moment: 'after_rejection' },
      answer: { moment: 'after_rejection', reason: 'good enough for now' },
      decidedBy: 'producer',
    });
  });

  it('accept as is is not offered before a rejection, nor when the Critic was already waived', () => {
    const model = new Model().toExecuting().send({ type: 'SUBMIT_FAILED' });
    expectAwaiting(model, ['redefine_need', 'raise_limit', 'cancel']);
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'accept_as_is', reason: 'why not' })).toBe(
      false,
    );
  });
});

describe('the critical exceptions', () => {
  it.each(CRITICAL_EXCEPTIONS)(
    '%s takes the play to the Producer without a counter',
    (exception) => {
      const model = new Model().toDeciding();
      model.classify([{ kind: 'critical_exception', exception, note: 'stop' }]);
      expect(model.state).toBe('AWAITING_PRODUCER');
      expect(model.context.producerReason).toEqual({ kind: 'exception', exception });
      // no counter ran out, so "raise the limit" does not apply
      expect(menuOf(model)).not.toContain('raise_limit');
      expect(menuOf(model)).toEqual(['redefine_need', 'deliver_ready', 'accept_as_is', 'cancel']);
      expect(model.counter('structural_restarts')).toBe(0);
    },
  );
});

describe('the classification of a critique (judgment point 1)', () => {
  it('records the answer of the Director as a decision', () => {
    const model = new Model().toDeciding();
    model.classify([{ kind: 'script', note: 'the demands overlap' }]);
    expect(model.decisions.at(-1)).toMatchObject({
      kind: 'classify_critique',
      decidedBy: 'director',
      answer: { failures: [{ kind: 'script', note: 'the demands overlap' }] },
    });
  });

  it('a script failure goes back to the Scriptwriter', () => {
    const model = new Model().toDeciding().classify([{ kind: 'script', note: 'overlap' }]);
    expect(model.state).toBe('SCRIPTING');
    expect(model.effect('run_stage')).toMatchObject({ role: 'scriptwriter', feedback: 'overlap' });
  });

  it('an execution failure runs again only the demands it affects', () => {
    const model = new Model().toExecuting(['d1', 'd2']);
    model.send({ type: 'ATTEMPT_FAILED', demandId: 'd1' });
    model.approveAll().send({ type: 'INTEGRATED', ok: true });
    model.send({ type: 'CRITIQUED', approved: false, reason: 'd1 is wrong' });
    expect(model.counter('attempts_per_demand:d1')).toBe(1);
    model.classify([{ kind: 'execution', demandIds: ['d1'], note: 'd1 is wrong' }]);
    expect(model.state).toBe('EXECUTING');
    expect(model.context.approvedDemands).toEqual(['d2']);
    // the attempts of the affected demand start over, and only it runs again
    expect(model.counter('attempts_per_demand:d1')).toBe(0);
    expect(model.effect('run_demands')).toMatchObject({
      demandIds: ['d1'],
      retry: true,
      feedback: 'd1 is wrong',
    });
  });

  it('in a mixed critique the most serious failure wins', () => {
    const critique = (failures: object[]) => new Model().toDeciding().classify(failures);
    const execution = { kind: 'execution', demandIds: ['d1'], note: 'e' };
    const script = { kind: 'script', note: 's' };
    const structural = { kind: 'structural', note: 'x' };
    const exception = { kind: 'critical_exception', exception: 'safety_risk', note: 'c' };

    expect(critique([execution, script]).state).toBe('SCRIPTING');
    expect(critique([script, execution]).state).toBe('SCRIPTING');
    expect(critique([execution, script, structural]).state).toBe('PLANNING');
    expect(critique([structural, script]).state).toBe('PLANNING');
    const worst = critique([execution, structural, exception, script]);
    expect(worst.state).toBe('AWAITING_PRODUCER');
    expect(worst.context.producerReason).toEqual({ kind: 'exception', exception: 'safety_risk' });
    // the lesser failures go on as context of the new cycle
    expect(critique([execution, script]).context.feedback).toBe('e\ns');
  });

  it('refuses an answer that does not fit the schema or names a demand that is not in the script', () => {
    const model = new Model().toDeciding();
    const judged = (answer: object) =>
      model.can({ type: 'JUDGED', point: 'classify_critique', answer: answer as never });
    expect(judged({ failures: [] })).toBe(false);
    expect(judged({ failures: [{ kind: 'execution' }] })).toBe(false);
    expect(judged({ failures: [{ kind: 'execution', demandIds: ['ghost'] }] })).toBe(false);
    expect(judged({ failures: [{ kind: 'critical_exception' }] })).toBe(false);
    expect(judged({ failures: [{ kind: 'script' }], extra: 1 })).toBe(false);
    expect(judged({ failures: [{ kind: 'script' }] })).toBe(true);
  });
});
