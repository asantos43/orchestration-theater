// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { PlayEventSchema } from './events.js';
import { limitsOf, Model } from './model-fixture.js';

/** N89: `delivery.mode: ask` with someone watching, as a menu of AWAITING_PRODUCER. */
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

function asking(): Model {
  const model = delivering();
  model.now = 2_000_000;
  model.send({ type: 'DELIVERY_ASK' });
  return model;
}

describe('N89: the delivery asks the Producer', () => {
  it('goes to AWAITING_PRODUCER with only the PR, the merge and cancel, and no counter spent', () => {
    const model = asking();
    expect(model.state).toBe('AWAITING_PRODUCER');
    expect(model.counter('script_returns')).toBe(0);
    expect(model.effect('ask_menu')).toMatchObject({
      options: ['deliver_pr', 'deliver_merge', 'cancel'],
      reason: { kind: 'delivery_ask', askedAt: 2_000_000 },
    });
  });

  it('deliver_pr and deliver_merge deliver again carrying the answer', () => {
    for (const [option, choice] of [
      ['deliver_pr', 'pr'],
      ['deliver_merge', 'direct_merge'],
    ] as const) {
      const model = delivering();
      expect(model.effect('deliver')).toMatchObject({ deliveryChoice: null });
      model.send({ type: 'DELIVERY_ASK' });
      model.send({ type: 'PRODUCER_CHOSE', option });
      expect(model.state).toBe('DELIVERING');
      expect(model.effectTypes()).toEqual(['abort_work', 'deliver']);
      expect(model.effect('deliver')).toMatchObject({ deliveryChoice: choice });
      expect(model.context.producerReason).toBeNull();
      expect(model.decisions.at(-1)).toMatchObject({
        kind: 'menu_choice',
        answer: { option },
        decidedBy: 'producer',
      });
      model.send({ type: 'DELIVERED' });
      expect(model.state).toBe('DONE');
    }
  });

  it('cancel ends the play', () => {
    const model = asking();
    model.send({ type: 'PRODUCER_CHOSE', option: 'cancel' });
    expect(model.state).toBe('CANCELLED');
  });

  it('nobody answering delivers the PR, recorded as a decision of the daemon', () => {
    for (const cause of ['timeout', 'left'] as const) {
      const model = asking();
      model.send({ type: 'DELIVERY_ASK_UNANSWERED', cause });
      expect(model.state).toBe('DELIVERING');
      expect(model.effect('deliver')).toMatchObject({ deliveryChoice: 'pr' });
      expect(model.decisions.at(-1)).toMatchObject({
        kind: 'menu_choice',
        answer: { option: 'deliver_pr', cause },
        decidedBy: 'daemon',
      });
    }
  });

  it('the answer of the Producer after the daemon went on is refused', () => {
    const model = asking();
    model.send({ type: 'DELIVERY_ASK_UNANSWERED', cause: 'timeout' });
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'deliver_merge' })).toBe(false);
  });

  it('the options of the question are refused for any other reason, and the others for it', () => {
    const spent = new Model(limitsOf('economical')).toDeciding();
    spent.classify([{ kind: 'structural' }]);
    expect(spent.can({ type: 'PRODUCER_CHOSE', option: 'deliver_pr' })).toBe(false);
    expect(spent.can({ type: 'PRODUCER_CHOSE', option: 'deliver_merge' })).toBe(false);
    expect(spent.can({ type: 'DELIVERY_ASK_UNANSWERED', cause: 'left' })).toBe(false);
    const model = asking();
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'deliver_ready' })).toBe(false);
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'redefine_need', need: 'n' })).toBe(false);
    expect(model.can({ type: 'PRODUCER_CHOSE', option: 'deliver_with_conflict' })).toBe(false);
  });

  it('DELIVERY_ASK is only taken in DELIVERING', () => {
    const model = new Model(limitsOf('moderate')).start();
    expect(model.can({ type: 'DELIVERY_ASK' })).toBe(false);
  });

  it('a new script forgets the answer (the work to deliver changed)', () => {
    const model = delivering();
    model.send({ type: 'DELIVERY_ASK' });
    model.send({ type: 'PRODUCER_CHOSE', option: 'deliver_merge' });
    model.send({ type: 'BASE_DRIFT', mode: 'update', files: ['a.txt'], reason: 'x' });
    expect(model.state).toBe('SCRIPTING');
    model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['alpha'] });
    expect(model.context.deliveryChoice).toBeNull();
  });

  it('validates the cause of an unanswered question', () => {
    expect(
      PlayEventSchema.safeParse({ type: 'DELIVERY_ASK_UNANSWERED', cause: 'bored' }).success,
    ).toBe(false);
    expect(PlayEventSchema.safeParse({ type: 'DELIVERY_ASK' }).success).toBe(true);
  });
});
