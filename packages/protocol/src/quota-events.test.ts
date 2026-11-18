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
