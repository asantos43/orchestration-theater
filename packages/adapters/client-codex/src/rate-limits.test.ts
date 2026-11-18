// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, Transient } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  LIMIT_REACHED_WINDOW,
  mergeUpdate,
  readingOf,
  viewOfReadResult,
  viewOfUpdate,
  windowNameOf,
  type RateLimitView,
} from './rate-limits.js';

const view = (over: Partial<RateLimitView> = {}): RateLimitView => ({
  primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_900_000_000 },
  secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1_900_400_000 },
  planType: 'pro',
  reachedType: null,
  ...over,
});

describe('windowNameOf', () => {
  it('names the two windows Phase 0 saw and any other length by its unit', () => {
    expect(windowNameOf(300, 'primary')).toBe('5h');
    expect(windowNameOf(10080, 'secondary')).toBe('7d');
    expect(windowNameOf(2880, 'primary')).toBe('2d');
    expect(windowNameOf(90, 'primary')).toBe('90m');
  });

  it('falls back to the slot when the length is missing or not a whole number of minutes', () => {
    expect(windowNameOf(null, 'secondary')).toBe('secondary');
    expect(windowNameOf(0, 'primary')).toBe('primary');
    expect(windowNameOf(12.5, 'primary')).toBe('primary');
  });
});

describe('viewOfReadResult', () => {
  it('reads rateLimits, and the bucket codex when it is the only one given', () => {
    const snapshot = { primary: { usedPercent: 3 }, planType: 'plus' };

    expect(viewOfReadResult({ rateLimits: snapshot }).primary?.usedPercent).toBe(3);
    expect(
      viewOfReadResult({ rateLimits: null, rateLimitsByLimitId: { codex: snapshot } }).planType,
    ).toBe('plus');
  });

  it('drops a window that has no number and rejects an answer of another shape', () => {
    const result = viewOfReadResult({ rateLimits: { primary: { usedPercent: 'many' } } });

    expect(result.primary).toBeNull();
    expect(() => viewOfReadResult(null)).toThrow(Transient);
    expect(() => viewOfReadResult({ rateLimits: 'x' })).toThrow(Transient);
  });
});

describe('mergeUpdate', () => {
  it('replaces the windows the update carries and keeps the others and the plan', () => {
    const update = viewOfUpdate({
      rateLimits: { primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 5 } },
    });
    if (update === undefined) throw new Error('the update has a snapshot');

    const merged = mergeUpdate(view(), update);

    expect(merged.primary?.usedPercent).toBe(70);
    expect(merged.secondary?.usedPercent).toBe(20);
    expect(merged.planType).toBe('pro');
  });

  it('takes the reached limit from the update', () => {
    const reached = mergeUpdate(view({ reachedType: 'rate_limit_reached' }), view());

    expect(reached.reachedType).toBeNull();
  });

  it('has no view for a notification without a snapshot', () => {
    expect(viewOfUpdate({})).toBeUndefined();
    expect(viewOfUpdate(null)).toBeUndefined();
  });
});

describe('readingOf', () => {
  it('converts the reset from seconds to milliseconds and omits it when missing', () => {
    const reading = readingOf(
      view({ secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null } }),
      7,
    );

    expect(reading.windows).toEqual([
      { window: '5h', usedPercent: 10, resetsAt: 1_900_000_000_000 },
      { window: '7d', usedPercent: 20 },
    ]);
  });

  it('keeps two windows of the same length apart by their slot', () => {
    const same = { usedPercent: 1, windowDurationMins: 300, resetsAt: null };
    const reading = readingOf(view({ primary: same, secondary: same }), 7);

    expect(reading.windows.map((one) => one.window)).toEqual(['5h', 'secondary']);
  });

  it('does not add limit_reached while a window already says 100%', () => {
    const full = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 };
    const reading = readingOf(view({ primary: full, reachedType: 'rate_limit_reached' }), 7);

    expect(reading.windows.map((one) => one.window)).toEqual(['5h', '7d']);
  });

  it('adds limit_reached when the limit is reached and no window is full', () => {
    const reading = readingOf(view({ reachedType: 'workspace_owner_credits_depleted' }), 7);

    expect(reading.windows.at(-1)).toEqual({ window: LIMIT_REACHED_WINDOW, usedPercent: 100 });
  });

  it('is not a reading when there is no window and no reached limit', () => {
    expect(() => readingOf(view({ primary: null, secondary: null }), 7)).toThrow(
      AdapterUnavailable,
    );
  });
});
