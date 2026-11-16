// SPDX-License-Identifier: MPL-2.0
import { NormalizedUpdateSchema } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_UPDATE, UPDATE_FIXTURES } from './fixtures/updates.js';
import { normalizeClaudeUpdate } from './normalize-update.js';

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
