// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  FIVE_HOUR_RESET_S,
  RATE_LIMIT_REJECTED_UPDATE,
  SEVEN_DAY_RESET_S,
} from './fixtures/quota.js';
import { RATE_LIMIT_UPDATE } from './fixtures/updates.js';
import {
  QUOTA_SIGNAL_METHOD,
  quotaSignalParams,
  quotaSignalsOf,
  RATE_LIMIT_EVENT_SOURCE,
} from './quota-signal.js';

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

const event = (windows: Record<string, unknown>, status = 'allowed'): unknown => ({
  sessionUpdate: 'usage_update',
  _meta: { '_claude/rateLimit': { status, unifiedWindows: windows } },
});

describe('quotaSignalsOf', () => {
  it('turns the fake rate_limit_event into window signals and a limit_hit', () => {
    const result = quotaSignalsOf(RATE_LIMIT_REJECTED_UPDATE, { utilizationUnit: 'auto' });
    expect(result.refused).toEqual([]);
    expect(result.signals).toEqual([
      { kind: 'window', window: '5h', usedPercent: 100, resetsAt: iso(FIVE_HOUR_RESET_S) },
      { kind: 'window', window: '7d', usedPercent: 12, resetsAt: iso(SEVEN_DAY_RESET_S) },
      { kind: 'limit_hit', source: RATE_LIMIT_EVENT_SOURCE, resetsAt: iso(FIVE_HOUR_RESET_S) },
    ]);
    expect(result.units).toEqual(['fraction']);
  });

  it('by default (ignore) gives only the limit_hit, since no unit is confirmed', () => {
    expect(quotaSignalsOf(RATE_LIMIT_REJECTED_UPDATE).signals).toEqual([
      { kind: 'limit_hit', source: RATE_LIMIT_EVENT_SOURCE, resetsAt: iso(FIVE_HOUR_RESET_S) },
    ]);
  });

  it('gives no signal for an allowed event with the default unit', () => {
    expect(quotaSignalsOf(RATE_LIMIT_UPDATE)).toEqual({ signals: [], units: [], refused: [] });
  });

  it('reads the same value as a fraction or as a percent when told so', () => {
    const raw = event({ five_hour: { utilization: 0.5, resetsAt: FIVE_HOUR_RESET_S } });
    expect(quotaSignalsOf(raw, { utilizationUnit: 'fraction' }).signals).toMatchObject([
      { window: '5h', usedPercent: 50 },
    ]);
    expect(quotaSignalsOf(raw, { utilizationUnit: 'percent' }).signals).toMatchObject([
      { window: '5h', usedPercent: 0.5 },
    ]);
  });

  it('records the unit it saw when it reads on its own (auto)', () => {
    const raw = event({
      five_hour: { utilization: 0.4, resetsAt: FIVE_HOUR_RESET_S },
      seven_day: { utilization: 63, resetsAt: SEVEN_DAY_RESET_S },
    });
    const result = quotaSignalsOf(raw, { utilizationUnit: 'auto' });
    expect(result.signals).toMatchObject([
      { window: '5h', usedPercent: 40 },
      { window: '7d', usedPercent: 63 },
    ]);
    expect([...result.units].sort()).toEqual(['fraction', 'percent']);
  });

  it('refuses a value outside 0..100 with the reason and sends no signal for it', () => {
    const raw = event({
      five_hour: { utilization: 250, resetsAt: FIVE_HOUR_RESET_S },
      seven_day: { utilization: 0.2, resetsAt: SEVEN_DAY_RESET_S },
    });
    const result = quotaSignalsOf(raw, { utilizationUnit: 'auto' });
    expect(result.signals).toMatchObject([{ window: '7d', usedPercent: 20 }]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toContain('five_hour');
    expect(result.refused[0]).toContain('above 100');
    expect(
      quotaSignalsOf(event({ five_hour: { utilization: -1 } }), { utilizationUnit: 'auto' }),
    ).toMatchObject({ signals: [], refused: [expect.stringContaining('below 0')] });
  });

  it('sends a limit_hit for a rejected event even when the number was refused', () => {
    const raw = {
      sessionUpdate: 'usage_update',
      _meta: {
        '_claude/rateLimit': {
          status: 'rejected',
          rateLimitType: 'five_hour',
          unifiedWindows: { five_hour: { utilization: 140, resetsAt: FIVE_HOUR_RESET_S } },
        },
      },
    };
    const result = quotaSignalsOf(raw, { utilizationUnit: 'percent' });
    expect(result.signals).toEqual([
      { kind: 'limit_hit', source: RATE_LIMIT_EVENT_SOURCE, resetsAt: iso(FIVE_HOUR_RESET_S) },
    ]);
    expect(result.refused).toHaveLength(1);
  });

  it('gives no signal for an update with no event or a malformed one', () => {
    for (const raw of [
      null,
      'x',
      {},
      { _meta: {} },
      { _meta: { '_claude/rateLimit': { resetsAt: 1 } } },
    ]) {
      expect(quotaSignalsOf(raw, { utilizationUnit: 'auto' })).toEqual({
        signals: [],
        units: [],
        refused: [],
      });
    }
  });

  it('wraps a signal in the params of the notification', () => {
    expect(QUOTA_SIGNAL_METHOD).toBe('_otheater/quota/signal');
    const signal = { kind: 'limit_hit', source: RATE_LIMIT_EVENT_SOURCE } as const;
    expect(quotaSignalParams('s1', signal)).toEqual({ sessionId: 's1', signal });
  });
});
