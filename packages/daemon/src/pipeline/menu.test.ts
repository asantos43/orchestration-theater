// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { MENU_OPTIONS } from './definitions.js';
import { limitsOf, Model } from './model-fixture.js';

/** A moderate play that ran out of plan reviews, waiting for the Producer. */
function spentPlanReviews(model = new Model()): Model {
  model.start();
  const { plan_reviews } = model.context.limits;
  for (let i = 0; i <= plan_reviews; i += 1) {
    model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    model.send({ type: 'PLAN_REVIEWED', approved: false, reason: `r${String(i)}` });
  }
  expect(model.state).toBe('AWAITING_PRODUCER');
  return model;
}

describe('the fixed menu of AWAITING_PRODUCER', () => {
  it('is a closed list of 7 options, in a fixed order', () => {
    expect(MENU_OPTIONS).toEqual([
      'redefine_need',
      'raise_limit',
      'deliver_ready',
      'accept_as_is',
      'redo_on_new_base',
      'deliver_with_conflict',
      'cancel',
    ]);
  });

  it('shows every option when demands were approved and the Critic rejected', () => {
    const model = new Model(limitsOf('economical')).toDeciding();
    model.classify([{ kind: 'structural' }]);
    // the two options of a drifted base (N83) hold only for that reason
    expect(model.effect('ask_menu').options).toEqual(
      MENU_OPTIONS.filter(
        (option) => option !== 'redo_on_new_base' && option !== 'deliver_with_conflict',
      ),
    );
  });

  it('refuses an option that does not hold, and an option outside the list', () => {
    const model = spentPlanReviews();
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'deliver_ready' })).toBe(false);
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'accept_as_is', reason: 'ok' })).toBe(false);
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'raise_limit' })).toBe(true);
    expect(() =>
      model.send({ type: 'PRODUCER_CHOSE', option: 'retry_everything' as never }),
    ).toThrow();
  });

  it('raise the limit: goes back where the counter ran out, with one more round', () => {
    const model = spentPlanReviews();
    const limit = model.context.limits.plan_reviews;
    model.send({ type: 'PRODUCER_CHOSE', option: 'raise_limit' });
    expect(model.state).toBe('PLANNING');
    expect(model.context.limitBonus).toEqual({ plan_reviews: 1 });
    expect(model.context.producerReason).toBeNull();
    expect(model.effect('run_stage')).toMatchObject({ stage: 'PLANNING' });
    expect(model.decisions.at(-1)).toMatchObject({
      kind: 'menu_choice',
      answer: { option: 'raise_limit' },
      decidedBy: 'producer',
    });
    // the extra round is used, and the next rejection ends in the Producer again
    model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    model.send({ type: 'PLAN_REVIEWED', approved: false });
    expect(model.state).toBe('AWAITING_PRODUCER');
    expect(model.counter('plan_reviews')).toBe(limit + 2);
  });

  it('raise the limit of the attempts of a demand: one more attempt, and its failure ends it', () => {
    const model = new Model().toExecuting(['d1', 'd2']);
    for (let i = 0; i < model.context.limits.attempts_per_demand; i += 1) {
      model.send({ type: 'ATTEMPT_FAILED', demandId: 'd1' });
    }
    expect(model.state).toBe('AWAITING_PRODUCER');
    model.send({ type: 'PRODUCER_CHOSE', option: 'raise_limit' });
    expect(model.state).toBe('EXECUTING');
    expect(model.context.limitBonus).toEqual({ attempts_per_demand: 1 });
    expect(model.effect('run_demands')).toMatchObject({ demandIds: ['d1', 'd2'] });
    model.send({ type: 'ATTEMPT_FAILED', demandId: 'd1' });
    expect(model.state).toBe('AWAITING_PRODUCER');
  });

  it('raise the limit with no demand left to run goes on to the integration', () => {
    const model = new Model().toExecuting(['d1', 'd2']);
    for (let i = 0; i < model.context.limits.attempts_per_demand; i += 1) {
      model.send({ type: 'ATTEMPT_FAILED', demandId: 'd1' });
    }
    // the other demands were still running when the counter ran out, and finish meanwhile
    model.send({ type: 'DEMAND_APPROVED', demandId: 'd2' });
    model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' });
    expect(model.state).toBe('AWAITING_PRODUCER');
    model.send({ type: 'PRODUCER_CHOSE', option: 'raise_limit' });
    expect(model.state).toBe('INTEGRATING');
  });

  it('raise the limit of the submit retries gives the session one more', () => {
    const model = new Model().start().send({ type: 'SUBMIT_FAILED' });
    const retries = model.context.limits.submit_retries;
    model.send({ type: 'PRODUCER_CHOSE', option: 'raise_limit' });
    expect(model.state).toBe('PLANNING');
    expect(model.effect('run_stage').submitRetries).toBe(retries + 1);
  });

  it('redefine the need: starts the plan over with the new need and clean counters', () => {
    const model = spentPlanReviews();
    model.send({ type: 'PRODUCER_CHOSE', option: 'redefine_need', need: 'a smaller need' });
    expect(model.state).toBe('PLANNING');
    expect(model.context).toMatchObject({
      need: 'a smaller need',
      counters: {},
      limitBonus: {},
      restart: true,
      producerReason: null,
    });
    expect(model.effect('run_stage')).toMatchObject({ restart: true });
    expect(model.decisions.at(-1)).toMatchObject({
      answer: { option: 'redefine_need', need: 'a smaller need' },
    });
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'redefine_need' })).toBe(false);
  });

  it('deliver what is ready: delivers only the approved demands', () => {
    const model = new Model().toExecuting(['d1', 'd2']);
    model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' });
    for (let i = 0; i < model.context.limits.attempts_per_demand; i += 1) {
      model.send({ type: 'ATTEMPT_FAILED', demandId: 'd2' });
    }
    expect(model.effect('ask_menu').options).toContain('deliver_ready');
    model.send({ type: 'PRODUCER_CHOSE', option: 'deliver_ready' });
    expect(model.state).toBe('DELIVERING');
    expect(model.effect('deliver')).toMatchObject({ demandIds: ['d1'], partial: true });
    expect(model.effectTypes()).toContain('abort_work');
    model.send({ type: 'DELIVERED' });
    expect(model.state).toBe('DONE');
  });

  it('cancel: ends the play and stops the work', () => {
    const model = spentPlanReviews();
    model.send({ type: 'PRODUCER_CHOSE', option: 'cancel' });
    expect(model.state).toBe('CANCELLED');
    expect(model.snapshot.status).toBe('done');
    expect(model.effectTypes()).toEqual(['abort_work']);
    expect(model.decisions.at(-1)).toMatchObject({ answer: { option: 'cancel' } });
  });

  it('every menu choice is a decision of the Producer, with the ids in sequence', () => {
    const model = spentPlanReviews();
    model.send({ type: 'PRODUCER_CHOSE', option: 'raise_limit' });
    expect(model.decisions.map((d) => [d.id, d.kind, d.decidedBy])).toEqual([
      ['p1:d1', 'menu_choice', 'producer'],
    ]);
  });
});

describe('the judgment points of the Director in EXECUTING', () => {
  const executing = () => new Model().toExecuting(['d1', 'd2']);
  const judged = (model: Model, point: string, action: string, demandId = 'd1') =>
    model.send({ type: 'JUDGED', point: point as never, demandId, answer: { action } });

  describe('2. the Actor ran out of time', () => {
    it('opens the judgment, takes the deadline off the demand and does not start it again', () => {
      const model = executing();
      model.send({ type: 'DEMAND_STARTED', demandId: 'd1' });
      expect(Object.keys(model.context.deadlines)).toEqual(['d1']);
      model.send({ type: 'ACTOR_TIMED_OUT', demandId: 'd1' });
      expect(model.context.deadlines).toEqual({});
      expect(model.effect('judge')).toMatchObject({ point: 'actor_timeout', demandId: 'd1' });
      expect(model.can({ type: 'ACTOR_TIMED_OUT', demandId: 'd1' })).toBe(false);
    });

    it('accept the partial work: it goes through verify', () => {
      const model = executing().send({ type: 'ACTOR_TIMED_OUT', demandId: 'd1' });
      judged(model, 'actor_timeout', 'accept_partial');
      expect(model.effect('verify_demand')).toEqual({
        type: 'verify_demand',
        demandId: 'd1',
        partial: true,
      });
      expect(model.context.openJudgments).toEqual([]);
      expect(model.decisions.at(-1)).toMatchObject({
        kind: 'actor_timeout',
        decidedBy: 'director',
      });
    });

    it('reassign: another Actor takes the demand, and it counts as an attempt', () => {
      const model = executing().send({ type: 'ACTOR_TIMED_OUT', demandId: 'd1' });
      judged(model, 'actor_timeout', 'reassign');
      expect(model.effect('run_demands')).toMatchObject({ demandIds: ['d1'], strategy: 'handoff' });
      expect(model.counter('attempts_per_demand:d1')).toBe(1);
    });
  });

  describe('6. refusal or permission error', () => {
    it.each([
      ['reformulate', 'reformulate'],
      ['switch_executor', 'switch_executor'],
    ])('%s runs the demand again with that strategy', (action, strategy) => {
      const model = executing().send({ type: 'ACTOR_REFUSED', demandId: 'd1' });
      expect(model.effect('judge')).toMatchObject({ point: 'refusal_or_permission' });
      judged(model, 'refusal_or_permission', action);
      expect(model.effect('run_demands')).toMatchObject({ demandIds: ['d1'], strategy });
      expect(model.counter('attempts_per_demand:d1')).toBe(1);
    });

    it('ask the Producer: consults, without a counter to raise', () => {
      const model = executing().send({ type: 'ACTOR_REFUSED', demandId: 'd1' });
      judged(model, 'refusal_or_permission', 'ask_producer');
      expect(model.state).toBe('AWAITING_PRODUCER');
      expect(model.context.producerReason).toMatchObject({
        kind: 'consulted',
        point: 'refusal_or_permission',
      });
      expect(model.effect('ask_menu').options).not.toContain('raise_limit');
    });
  });

  describe('7. resumes of an attempt above the limit', () => {
    it('handoff: another Actor takes the demand', () => {
      const model = executing().send({ type: 'RESUMES_EXCEEDED', demandId: 'd1' });
      judged(model, 'resumes_exceeded', 'handoff');
      expect(model.effect('run_demands')).toMatchObject({ strategy: 'handoff' });
    });

    it('fail the attempt: counts in attempts_per_demand, and the last one goes to the Producer', () => {
      const model = executing();
      const attempts = model.context.limits.attempts_per_demand;
      for (let i = 1; i < attempts; i += 1) {
        model.send({ type: 'RESUMES_EXCEEDED', demandId: 'd1' });
        judged(model, 'resumes_exceeded', 'fail_attempt');
        expect(model.state).toBe('EXECUTING');
        expect(model.counter('attempts_per_demand:d1')).toBe(i);
      }
      model.send({ type: 'RESUMES_EXCEEDED', demandId: 'd1' });
      judged(model, 'resumes_exceeded', 'fail_attempt');
      expect(model.state).toBe('AWAITING_PRODUCER');
      expect(model.context.producerReason).toMatchObject({
        kind: 'limit',
        counter: 'attempts_per_demand',
        demandId: 'd1',
      });
    });

    it('ask the Producer: consults', () => {
      const model = executing().send({ type: 'RESUMES_EXCEEDED', demandId: 'd2' });
      judged(model, 'resumes_exceeded', 'ask_producer', 'd2');
      expect(model.context.producerReason).toMatchObject({
        kind: 'consulted',
        point: 'resumes_exceeded',
        demandId: 'd2',
      });
    });
  });

  describe('8. a dependency was redone', () => {
    const redone = () => {
      const model = executing();
      model.send({ type: 'DEMAND_APPROVED', demandId: 'd2' });
      return model.send({ type: 'DEPENDENCY_REDONE', demandId: 'd1', dependentIds: ['d2'] });
    };

    it('opens the judgment with the dependents', () => {
      const model = redone();
      expect(model.effect('judge')).toMatchObject({
        point: 'dependency_redone',
        demandId: 'd1',
        dependentIds: ['d2'],
      });
    });

    it('rebase: the dependents are rebased on the new base and stay approved', () => {
      const model = redone();
      judged(model, 'dependency_redone', 'rebase');
      expect(model.effect('rebase_dependents')).toEqual({
        type: 'rebase_dependents',
        demandId: 'd1',
        dependentIds: ['d2'],
      });
      expect(model.context.approvedDemands).toEqual(['d2']);
    });

    it('redo: the dependents lose their approval and run again', () => {
      const model = redone();
      judged(model, 'dependency_redone', 'redo');
      expect(model.context.approvedDemands).toEqual([]);
      expect(model.effect('run_demands')).toMatchObject({ demandIds: ['d2'], strategy: 'redo' });
    });
  });

  describe('8. a redone demand that passed verify (what the daemon sends, P15a)', () => {
    // d1 passed `verify` again while d2, which depends on it, is still approved
    const verified = () => {
      const model = executing();
      model.send({ type: 'DEMAND_APPROVED', demandId: 'd2' });
      return model.send({
        type: 'DEPENDENCY_REDONE',
        demandId: 'd1',
        dependentIds: ['d2'],
        verified: true,
      });
    };

    it('waits for the answer: the play does not integrate with d1 still pending', () => {
      const model = verified();
      expect(model.state).toBe('EXECUTING');
      expect(model.context.approvedDemands).toEqual(['d2']);
      expect(model.context.openJudgments).toMatchObject([
        { point: 'dependency_redone', verified: true },
      ]);
    });

    it('rebase: d1 stays pending until the daemon approves it after the rebase', () => {
      const model = verified();
      judged(model, 'dependency_redone', 'rebase');
      expect(model.state).toBe('EXECUTING');
      expect(model.context.approvedDemands).toEqual(['d2']);
      expect(model.context.openJudgments).toEqual([]);
      model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' });
      expect(model.state).toBe('INTEGRATING');
    });

    it('redo: d1 is approved with the answer and the dependents run again', () => {
      const model = verified();
      judged(model, 'dependency_redone', 'redo');
      expect(model.state).toBe('EXECUTING');
      expect(model.context.approvedDemands).toEqual(['d1']);
      expect(model.effect('run_demands')).toMatchObject({ demandIds: ['d2'], strategy: 'redo' });
      model.send({ type: 'DEMAND_STARTED', demandId: 'd2' });
      model.send({ type: 'DEMAND_APPROVED', demandId: 'd2' });
      expect(model.state).toBe('INTEGRATING');
    });
  });

  it('refuses an answer that does not fit the point, or that no one asked for', () => {
    const model = executing().send({ type: 'ACTOR_TIMED_OUT', demandId: 'd1' });
    const answer = (point: string, action: string, demandId = 'd1') =>
      model.can({ type: 'JUDGED', point: point as never, demandId, answer: { action } });
    expect(answer('actor_timeout', 'reformulate')).toBe(false); // not an option of this point
    expect(answer('refusal_or_permission', 'reformulate')).toBe(false); // that point is not open
    expect(answer('actor_timeout', 'reassign', 'd2')).toBe(false); // another demand
    expect(answer('actor_timeout', 'reassign')).toBe(true);
  });

  it('the points of other flows are not opened by the play machine', () => {
    const model = executing();
    for (const point of ['consult_producer', 'chat_consult', 'task_step_failed']) {
      expect(model.can({ type: 'JUDGED', point: point as never, demandId: 'd1', answer: {} })).toBe(
        false,
      );
    }
  });
});
