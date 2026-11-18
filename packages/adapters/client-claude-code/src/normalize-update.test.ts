// SPDX-License-Identifier: MPL-2.0
import { NormalizedUpdateSchema } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_UPDATE, UPDATE_FIXTURES } from './fixtures/updates.js';
import { normalizeClaudeUpdate, readRateLimitEvent, readUtilization } from './normalize-update.js';

describe('normalizeClaudeUpdate: fixtures', () => {
  it.each(UPDATE_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s',
    (_name, fixture) => {
      const result = normalizeClaudeUpdate(fixture.raw);
      expect(result).toEqual(fixture.expected);
      if (result !== null) expect(NormalizedUpdateSchema.safeParse(result).success).toBe(true);
    },
  );
});

describe('normalizeClaudeUpdate: rate limit', () => {
  it('turns the rate-limit event of a usage update into a rate_limit update', () => {
    const result = normalizeClaudeUpdate(RATE_LIMIT_UPDATE);
    expect(result).toEqual({
      kind: 'rate_limit',
      status: 'warning',
      window: 'five_hour',
      resetsAt: 1_800_000_000_000,
    });
    expect(NormalizedUpdateSchema.safeParse(result).success).toBe(true);
  });

  it('leaves usedPercent out by default, since the unit of utilization is not confirmed', () => {
    const result = normalizeClaudeUpdate(RATE_LIMIT_UPDATE, { utilizationUnit: 'ignore' });
    expect(result).not.toHaveProperty('usedPercent');
  });

  it('reads utilization as a fraction when told so', () => {
    const result = normalizeClaudeUpdate(RATE_LIMIT_UPDATE, { utilizationUnit: 'fraction' });
    expect(result).toMatchObject({ kind: 'rate_limit', usedPercent: 83 });
    expect(NormalizedUpdateSchema.safeParse(result).success).toBe(true);
  });

  it('reads utilization as a percent when told so', () => {
    const result = normalizeClaudeUpdate(RATE_LIMIT_UPDATE, { utilizationUnit: 'percent' });
    expect(result).toMatchObject({ kind: 'rate_limit', usedPercent: 0.83 });
  });

  it('maps the statuses: allowed, rejected, and anything else as a warning', () => {
    const of = (status: string): unknown =>
      normalizeClaudeUpdate({
        sessionUpdate: 'usage_update',
        _meta: { '_claude/rateLimit': { status, resetsAt: 10 } },
      });
    expect(of('allowed')).toMatchObject({ status: 'allowed', resetsAt: 10_000 });
    expect(of('rejected')).toMatchObject({ status: 'rejected' });
    expect(of('allowed_warning')).toMatchObject({ status: 'warning' });
    expect(of('something_new')).toMatchObject({ status: 'warning' });
  });

  it('ignores a rate-limit meta that has no status and falls back to the counters', () => {
    expect(
      normalizeClaudeUpdate({
        sessionUpdate: 'usage_update',
        used: 5,
        size: 10,
        _meta: { '_claude/rateLimit': { resetsAt: 10 } },
      }),
    ).toEqual({ kind: 'usage', contextUsed: 5, contextSize: 10 });
  });
});

describe('normalizeClaudeUpdate: robustness', () => {
  it('swallows what it does not know instead of throwing', () => {
    for (const raw of [null, undefined, 3, [], {}, { sessionUpdate: 'brand_new_update' }]) {
      expect(normalizeClaudeUpdate(raw)).toBeNull();
    }
  });

  it('swallows a tool call with no id', () => {
    expect(normalizeClaudeUpdate({ sessionUpdate: 'tool_call', title: 'x' })).toBeNull();
  });

  it('never returns a value the schema refuses', () => {
    for (const fixture of UPDATE_FIXTURES) {
      const result = normalizeClaudeUpdate(fixture.raw);
      if (result !== null) expect(() => NormalizedUpdateSchema.parse(result)).not.toThrow();
    }
  });
});

describe('readUtilization (N123)', () => {
  it('ignores everything when the unit is ignore', () => {
    expect(readUtilization(0.5, 'ignore')).toMatchObject({ ok: false });
  });

  it('records the unit: auto takes 0..1 as a fraction and above 1 as a percent', () => {
    expect(readUtilization(0, 'auto')).toEqual({ ok: true, percent: 0, seen: 'fraction' });
    expect(readUtilization(0.25, 'auto')).toEqual({ ok: true, percent: 25, seen: 'fraction' });
    expect(readUtilization(1, 'auto')).toEqual({ ok: true, percent: 100, seen: 'fraction' });
    expect(readUtilization(37, 'auto')).toEqual({ ok: true, percent: 37, seen: 'percent' });
    expect(readUtilization(100, 'auto')).toEqual({ ok: true, percent: 100, seen: 'percent' });
  });

  it('refuses a value outside 0..100 with the reason, whatever the unit, and never clamps', () => {
    for (const unit of ['fraction', 'percent', 'auto'] as const) {
      const high = readUtilization(140, unit);
      expect(high.ok).toBe(false);
      if (!high.ok) expect(high.reason).toContain('above 100');
    }
    const low = readUtilization(-0.1, 'auto');
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.reason).toContain('below 0');
    expect(readUtilization(1.5, 'fraction')).toMatchObject({ ok: false });
  });

  it('refuses what is not a finite number', () => {
    for (const value of ['0.5', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readUtilization(value, 'auto')).toMatchObject({
        ok: false,
        reason: 'the utilization is not a finite number',
      });
    }
  });
});

describe('readRateLimitEvent', () => {
  const raw = (event: unknown): unknown => ({
    sessionUpdate: 'usage_update',
    _meta: { '_claude/rateLimit': event },
  });

  it('is undefined for an update with no event, or an event with no status', () => {
    expect(readRateLimitEvent({ sessionUpdate: 'usage_update' })).toBeUndefined();
    expect(readRateLimitEvent(raw({ resetsAt: 1 }))).toBeUndefined();
    expect(readRateLimitEvent(null)).toBeUndefined();
  });

  it('reads every window of the event, with the dominant one once, and the resets in ms', () => {
    const result = readRateLimitEvent(
      raw({
        status: 'rejected',
        resetsAt: 10,
        rateLimitType: 'five_hour',
        unifiedWindows: {
          five_hour: { utilization: 1, resetsAt: 10 },
          seven_day: { utilization: 0.1, resetsAt: 20 },
        },
      }),
      'auto',
    );
    expect(result).toEqual({
      status: 'rejected',
      dominant: 'five_hour',
      resetsAt: 10_000,
      windows: [
        { name: 'five_hour', percent: 100, seen: 'fraction', resetsAt: 10_000 },
        { name: 'seven_day', percent: 10, seen: 'fraction', resetsAt: 20_000 },
      ],
    });
  });

  it('gives no percent with the default unit, and marks a refused value only when a unit is set', () => {
    const event = raw({
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 300 } },
    });
    expect(readRateLimitEvent(event)?.windows).toEqual([{ name: 'five_hour' }]);
    expect(readRateLimitEvent(event, 'auto')?.windows).toEqual([
      { name: 'five_hour', refused: expect.stringContaining('above 100') as string },
    ]);
  });
});
