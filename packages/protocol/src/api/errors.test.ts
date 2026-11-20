// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Cancelled,
  Conflict,
  InvalidInput,
  NotFound,
  PermissionDenied,
  QuotaExhausted,
  Transient,
  VaultLocked,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  ApiErrorSchema,
  apiError,
  apiErrorCodeOf,
  apiErrorStatus,
  invalidInputDetails,
} from './errors.js';

describe('the error answer', () => {
  it('round-trips with and without details', () => {
    const plain = { error: { code: 'not_found', message: 'There is no scenario S9' } };
    expect(ApiErrorSchema.parse(plain)).toEqual(plain);
    const detailed = apiError('invalid_input', 'bad', {
      issues: [{ path: ['a', 0], message: 'x' }],
    });
    expect(ApiErrorSchema.parse(detailed)).toEqual(detailed);
    expect(apiError('internal', 'x')).toEqual({ error: { code: 'internal', message: 'x' } });
  });

  it('refuses an unknown code, a missing message and extra fields', () => {
    for (const bad of [
      { error: { code: 'teapot', message: 'x' } },
      { error: { code: 'internal' } },
      { error: { code: 'internal', message: 'x', extra: 1 } },
      { error: { code: 'internal', message: 'x' }, extra: 1 },
      { code: 'internal', message: 'x' },
    ]) {
      expect(ApiErrorSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the code table', () => {
  it('gives each code the status of the plan', () => {
    expect(API_ERROR_STATUS).toMatchObject({
      invalid_input: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      payload_too_large: 413,
      unavailable: 503,
      recovering: 503,
      internal: 500,
    });
    expect(API_ERROR_CODES.length).toBe(Object.keys(API_ERROR_STATUS).length);
    expect(apiErrorStatus('conflict')).toBe(409);
  });
});

describe('apiErrorCodeOf', () => {
  it('maps every error of the core', () => {
    expect(apiErrorCodeOf(new InvalidInput('x'))).toBe('invalid_input');
    expect(apiErrorCodeOf(new NotFound('x'))).toBe('not_found');
    expect(apiErrorCodeOf(new Conflict('x'))).toBe('conflict');
    expect(apiErrorCodeOf(new PermissionDenied('x'))).toBe('forbidden');
    expect(apiErrorCodeOf(new QuotaExhausted('x'))).toBe('quota_exhausted');
    expect(apiErrorCodeOf(new VaultLocked('x'))).toBe('vault_locked');
    expect(apiErrorCodeOf(new AdapterUnavailable('x'))).toBe('unavailable');
    expect(apiErrorCodeOf(new Transient('x'))).toBe('unavailable');
    expect(apiErrorCodeOf(new Cancelled('x'))).toBe('unavailable');
  });

  it('answers internal for anything else', () => {
    expect(apiErrorCodeOf(new Error('boom'))).toBe('internal');
    expect(apiErrorCodeOf('text')).toBe('internal');
    expect(apiErrorCodeOf(undefined)).toBe('internal');
  });
});

describe('invalidInputDetails', () => {
  it('lists where each wrong field is', () => {
    const result = z
      .strictObject({ list: z.array(z.strictObject({ n: z.int() })) })
      .safeParse({ list: [{ n: 1 }, { n: 'x' }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const details = invalidInputDetails(result.error);
    expect(details.issues).toHaveLength(1);
    expect(details.issues[0]?.path).toEqual(['list', 1, 'n']);
    // It fits the `details` of the error answer.
    expect(ApiErrorSchema.safeParse(apiError('invalid_input', 'bad', details)).success).toBe(true);
  });
});
