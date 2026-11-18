// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { validateEventPayload } from './events.js';

const window = { window: '5h', usedPercent: 85, resetsAt: 1_000, observedAt: 900 };

describe('quota.* events [proposta]', () => {
  it('accept a valid payload of each type', () => {
    const updated = {
      profile: 'claude-code/work',
      state: 'near_limit',
      source: 'probe',
      windows: [window],
      planType: 'max',
    };
    expect(validateEventPayload('quota.updated', 1, updated)).toEqual(updated);
    const near = {
      profile: 'claude-code/work',
      window: '5h',
      usedPercent: 85,
      resetsAt: null,
      thresholdPercent: 80,
    };
    expect(validateEventPayload('quota.near_limit', 1, near)).toEqual(near);
    const exhausted = {
      profile: 'claude-code/work',
      cause: 'quota',
      untilReset: null,
      source: 'limit_hit:client',
    };
    expect(validateEventPayload('quota.exhausted', 1, exhausted)).toEqual(exhausted);
    const restored = {
      profile: 'claude-code/work',
      cause: 'budget',
      state: 'unknown',
      reason: 'reset',
    };
    expect(validateEventPayload('quota.restored', 1, restored)).toEqual(restored);
    const rechecked = { ...restored, cause: 'quota', reason: 'recheck' };
    expect(validateEventPayload('quota.restored', 1, rechecked)).toEqual(rechecked);
    const budget = { profile: 'claude-code/work', state: 'ok', reason: 'reset' };
    expect(validateEventPayload('budget.restored', 1, budget)).toEqual(budget);
    const changed = { ...budget, reason: 'config' };
    expect(validateEventPayload('budget.restored', 1, changed)).toEqual(changed);
    // `config` is a reason of the cap only: a quota is never released by a configuration change.
    expect(() =>
      validateEventPayload('quota.restored', 1, { ...restored, reason: 'config' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('budget.restored', 1, { ...budget, cause: 'budget' }),
    ).toThrow();
  });

  it('accepts the payload of budget.warning and refuses a fraction out of range or extra fields', () => {
    const warning = {
      profile: 'claude-code/api',
      executor: null,
      period: 'day',
      thresholdFraction: 0.8,
      spentUsd: 4.1,
      limitUsd: 5,
      periodEndsAt: 1_763_521_200_000,
    };
    expect(validateEventPayload('budget.warning', 1, warning)).toEqual(warning);
    const own = { ...warning, executor: 'claude-opus-high@claude-code/api', period: 'month' };
    expect(validateEventPayload('budget.warning', 1, own)).toEqual(own);
    expect(() =>
      validateEventPayload('budget.warning', 1, { ...warning, thresholdFraction: 1.2 }),
    ).toThrow();
    expect(() =>
      validateEventPayload('budget.warning', 1, { ...warning, period: 'week' }),
    ).toThrow();
    expect(() => validateEventPayload('budget.warning', 1, { ...warning, extra: 1 })).toThrow();
  });

  it('accepts the payload of budget.exceeded for a profile cap and an Executor cap, and refuses the rest', () => {
    const exceeded = {
      profile: 'claude-code/api',
      executor: null,
      period: 'day',
      spentUsd: 10.5,
      limitUsd: 10,
      endsAt: 1_763_521_200_000,
    };
    expect(validateEventPayload('budget.exceeded', 1, exceeded)).toEqual(exceeded);
    const own = { ...exceeded, executor: 'claude-opus-high@claude-code/api', period: 'month' };
    expect(validateEventPayload('budget.exceeded', 1, own)).toEqual(own);
    expect(() =>
      validateEventPayload('budget.exceeded', 1, { ...exceeded, limitUsd: 0 }),
    ).toThrow();
    expect(() =>
      validateEventPayload('budget.exceeded', 1, { ...exceeded, period: 'week' }),
    ).toThrow();
    expect(() => validateEventPayload('budget.exceeded', 1, { ...exceeded, extra: 1 })).toThrow();
    expect(() =>
      validateEventPayload('budget.exceeded', 1, { ...exceeded, endsAt: undefined }),
    ).toThrow();
  });

  it('accepts the payload of budget.unknown_cost and refuses the rest', () => {
    const unknown = {
      model: 'no-such-model',
      profile: 'claude-code/api',
      executor: 'claude-opus-high@claude-code/api',
      mode: 'ignore',
    };
    expect(validateEventPayload('budget.unknown_cost', 1, unknown)).toEqual(unknown);
    expect(() =>
      validateEventPayload('budget.unknown_cost', 1, { ...unknown, mode: 'block' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('budget.unknown_cost', 1, { ...unknown, model: '' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('budget.unknown_cost', 1, { ...unknown, extra: 1 }),
    ).toThrow();
  });

  it('refuse an unknown state, an unknown cause and extra fields', () => {
    expect(() =>
      validateEventPayload('quota.updated', 1, {
        profile: 'a/b',
        state: 'fine',
        source: 'probe',
        windows: [],
      }),
    ).toThrow();
    expect(() =>
      validateEventPayload('quota.exhausted', 1, {
        profile: 'a/b',
        cause: 'mood',
        untilReset: null,
        source: 'x',
      }),
    ).toThrow();
    expect(() =>
      validateEventPayload('quota.restored', 1, {
        profile: 'a/b',
        cause: 'quota',
        state: 'exhausted',
        reason: 'reset',
      }),
    ).toThrow();
    expect(() =>
      validateEventPayload('quota.near_limit', 1, {
        profile: 'a/b',
        window,
        usedPercent: 1,
        resetsAt: null,
        thresholdPercent: 80,
        extra: true,
      }),
    ).toThrow();
  });
});
