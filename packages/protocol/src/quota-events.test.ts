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
