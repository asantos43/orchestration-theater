// SPDX-License-Identifier: MPL-2.0
import { NORMALIZED_ERROR_KINDS } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { ERROR_FIXTURES } from './fixtures/errors.js';
import { AUTH_REQUIRED_CODE, normalizeClaudeError } from './normalize-error.js';

describe('normalizeClaudeError: fixtures', () => {
  it.each(ERROR_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s',
    (_name, fixture) => {
      const result = normalizeClaudeError(fixture.raw);
      expect(result.kind).toBe(fixture.kind);
      expect(result.resetsAt).toBe(fixture.resetsAt);
      expect(result.cause).toBe(fixture.raw);
      expect(NORMALIZED_ERROR_KINDS).toContain(result.kind);
      expect(result.message.length).toBeGreaterThan(0);
    },
  );
});

describe('normalizeClaudeError: order and details', () => {
  it('lets the auth code win over a message that looks like a quota', () => {
    expect(
      normalizeClaudeError({ code: AUTH_REQUIRED_CODE, message: 'usage limit reached' }).kind,
    ).toBe('auth_required');
  });

  it('reads the cause from data.details when the message is generic', () => {
    expect(
      normalizeClaudeError({
        code: -32603,
        message: 'Internal error',
        data: { details: 'Claude AI usage limit reached|1800000000' },
      }),
    ).toMatchObject({ kind: 'quota_exhausted', resetsAt: 1_800_000_000_000 });
  });

  it('takes a reset in milliseconds as it is, and one in seconds times 1000', () => {
    const at = (resetsAt: number): number | undefined =>
      normalizeClaudeError({ message: 'Weekly limit reached', data: { resetsAt } }).resetsAt;
    expect(at(1_800_000_000)).toBe(1_800_000_000_000);
    expect(at(1_800_000_000_000)).toBe(1_800_000_000_000);
  });

  it('does not invent a reset when there is none, or when it is not a date', () => {
    expect(normalizeClaudeError({ message: 'usage limit reached' }).resetsAt).toBeUndefined();
    expect(
      normalizeClaudeError({ message: 'usage limit reached', data: { resetsAt: 'soon' } }).resetsAt,
    ).toBeUndefined();
  });

  it('classifies a message that carries a plain status code as transient', () => {
    expect(normalizeClaudeError(new Error('HTTP 503 from upstream')).kind).toBe('transient');
  });

  it('classifies a permission message', () => {
    expect(normalizeClaudeError(new Error('Permission denied by policy')).kind).toBe('permission');
  });

  it('never throws, whatever it is given', () => {
    for (const raw of [undefined, null, 0, {}, [], Symbol.for('x')]) {
      expect(NORMALIZED_ERROR_KINDS).toContain(normalizeClaudeError(raw).kind);
    }
  });
});
