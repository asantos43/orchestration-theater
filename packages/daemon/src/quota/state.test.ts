// SPDX-License-Identifier: MPL-2.0
import type { QuotaSnapshotRecord } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  authorizes,
  BUDGET_HIT_WINDOW,
  evaluateQuota,
  LIMIT_HIT_WINDOW,
  signatureOf,
  type QuotaRules,
} from './state.js';

const MIN = 60_000;
const NOW = 1_000_000_000_000;
const PROFILE = 'claude-code/work';
const RULES: QuotaRules = {
  nearLimitAt: 0.8,
  staleAfterMs: 10 * MIN,
  expectedWindows: ['5h', '7d'],
};

function row(
  window: string,
  usedPercent: number,
  over: Partial<QuotaSnapshotRecord> = {},
): QuotaSnapshotRecord {
  return {
    profileId: PROFILE,
    window,
    usedPercent,
    resetsAt: NOW + 60 * MIN,
    source: 'probe',
    observedAt: NOW - MIN,
    updatedAt: NOW - MIN,
    ...over,
  };
}

const statusOf = (rows: QuotaSnapshotRecord[], rules: QuotaRules = RULES, now = NOW) =>
  evaluateQuota(PROFILE, rows, now, rules);

describe('evaluateQuota', () => {
  it('is ok with room in every expected window', () => {
    const status = statusOf([row('5h', 30), row('7d', 10)]);
    expect(status.state).toBe('ok');
    expect(authorizes(status)).toBe(true);
  });

  it('is near_limit from 80%, with the fullest window as the reason', () => {
    const status = statusOf([row('5h', 85), row('7d', 90)]);
    expect(status.state).toBe('near_limit');
    expect(status.nearLimitWindow?.window).toBe('7d');
    expect(authorizes(status)).toBe(true);
  });

  it('is unknown with no reading, and refuses', () => {
    const status = statusOf([]);
    expect(status.state).toBe('unknown');
    expect(authorizes(status)).toBe(false);
  });

  it('is unknown when an expected window has no reading, even if another is fine', () => {
    const status = statusOf([row('5h', 10)]);
    expect(status.state).toBe('unknown');
    expect(status.reason).toContain('7d');
  });

  it('asks nothing of the windows when the probe names none', () => {
    expect(statusOf([row('whatever', 10)], { ...RULES, expectedWindows: [] }).state).toBe('ok');
  });

  it('is unknown when the readings are stale: a stale reading never authorizes', () => {
    const old = { observedAt: NOW - 11 * MIN };
    const status = statusOf([row('5h', 10, old), row('7d', 10, old)]);
    expect(status.state).toBe('unknown');
    expect(authorizes(status)).toBe(false);
    expect(status.windows.every((w) => !w.fresh)).toBe(true);
  });

  it('counts a window whose reset passed as not fresh', () => {
    const status = statusOf([row('5h', 10, { resetsAt: NOW - 1 }), row('7d', 10)]);
    expect(status.state).toBe('unknown');
  });

  it('is exhausted from a full window until its reset', () => {
    const status = statusOf([row('5h', 100, { resetsAt: NOW + 30 * MIN }), row('7d', 10)]);
    expect(status).toMatchObject({
      state: 'exhausted',
      cause: 'quota',
      untilReset: NOW + 30 * MIN,
    });
    expect(authorizes(status)).toBe(false);
  });

  it('keeps a full window with a future reset exhausted even when the reading is stale', () => {
    const status = statusOf([
      row('5h', 100, { observedAt: NOW - 3 * 60 * MIN, resetsAt: NOW + MIN }),
    ]);
    expect(status.state).toBe('exhausted');
  });

  it('lets a full window with no reset count only while it is fresh', () => {
    expect(statusOf([row('5h', 100, { resetsAt: null })]).state).toBe('exhausted');
    const stale = statusOf([row('5h', 100, { resetsAt: null, observedAt: NOW - 11 * MIN })]);
    expect(stale.state).toBe('unknown');
  });

  it('is exhausted from a limit hit, until its reset; with none it stays exhausted', () => {
    const withTime = statusOf([row(LIMIT_HIT_WINDOW, 100, { resetsAt: NOW + 5 * MIN })]);
    expect(withTime).toMatchObject({
      state: 'exhausted',
      cause: 'quota',
      untilReset: NOW + 5 * MIN,
    });
    const without = statusOf([row(LIMIT_HIT_WINDOW, 100, { resetsAt: null })]);
    expect(without).toMatchObject({ state: 'exhausted', cause: 'quota', untilReset: null });
  });

  it('ends a limit hit at its reset', () => {
    const rows = [row(LIMIT_HIT_WINDOW, 100, { resetsAt: NOW + 5 * MIN })];
    expect(statusOf(rows, RULES, NOW + 5 * MIN + 1).state).toBe('unknown');
  });

  it('ends a limit hit that has no time when a newer fresh reading has room', () => {
    const rows = [
      row(LIMIT_HIT_WINDOW, 100, { resetsAt: null, observedAt: NOW - 5 * MIN }),
      row('5h', 20),
      row('7d', 20),
    ];
    expect(statusOf(rows).state).toBe('ok');
  });

  it('does not end a limit hit with an older reading, nor when a window is still full', () => {
    const older = [
      row(LIMIT_HIT_WINDOW, 100, { resetsAt: null, observedAt: NOW - MIN / 2 }),
      row('5h', 20),
      row('7d', 20),
    ];
    expect(statusOf(older).state).toBe('exhausted');
    const full = [
      row(LIMIT_HIT_WINDOW, 100, { resetsAt: null, observedAt: NOW - 5 * MIN }),
      row('5h', 100),
      row('7d', 20),
    ];
    expect(statusOf(full).state).toBe('exhausted');
  });

  it('is exhausted by budget, and a newer reading does not end it', () => {
    const rows = [
      row(BUDGET_HIT_WINDOW, 100, { resetsAt: null, observedAt: NOW - 5 * MIN }),
      row('5h', 20),
      row('7d', 20),
    ];
    expect(statusOf(rows)).toMatchObject({ state: 'exhausted', cause: 'budget', untilReset: null });
  });

  it('takes the quota as the cause, and the latest end, when both hold; an unknown end wins', () => {
    const both = statusOf([
      row(LIMIT_HIT_WINDOW, 100, { resetsAt: NOW + 5 * MIN }),
      row(BUDGET_HIT_WINDOW, 100, { resetsAt: NOW + 9 * MIN }),
    ]);
    expect(both).toMatchObject({ cause: 'quota', untilReset: NOW + 9 * MIN });
    const open = statusOf([
      row(LIMIT_HIT_WINDOW, 100, { resetsAt: NOW + 5 * MIN }),
      row(BUDGET_HIT_WINDOW, 100, { resetsAt: null }),
    ]);
    expect(open.untilReset).toBeNull();
  });

  it('keeps the reserved windows out of the window list', () => {
    const status = statusOf([row(LIMIT_HIT_WINDOW, 100), row('5h', 10), row('7d', 10)]);
    expect(status.windows.map((w) => w.window).sort()).toEqual(['5h', '7d']);
  });

  it('gives the same answer for the same rows and instant (a restart)', () => {
    const rows = [row('5h', 85), row('7d', 20)];
    expect(statusOf(rows)).toEqual(statusOf(rows));
    expect(signatureOf(statusOf(rows))).toBe(signatureOf(statusOf(rows, RULES, NOW + 1)));
  });
});
