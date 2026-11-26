// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DaemonStatusSchema } from '../api.js';
import { DaemonIdSchema, ScenarioRefSchema } from './ids.js';
import {
  API_PAGE_DEFAULT_LIMIT,
  API_PAGE_MAX_LIMIT,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyHeadersSchema,
  IdempotencyKeySchema,
  PageQuerySchema,
  pageOf,
} from './page.js';
import { API_VERSION } from './route.js';
import { ApiStatusSchema, getStatus, isSupportedApiVersion } from './status.js';
import { z } from 'zod';

const daemonId = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b';

describe('ids', () => {
  it('accepts a UUID as the daemon id and nothing else', () => {
    expect(DaemonIdSchema.safeParse(daemonId).success).toBe(true);
    expect(DaemonIdSchema.safeParse('local').success).toBe(false);
    expect(DaemonIdSchema.safeParse('').success).toBe(false);
  });

  it('round-trips the global reference of a scenario', () => {
    const ref = { daemonId, scenarioId: 'S3' };
    expect(ScenarioRefSchema.parse(ref)).toEqual(ref);
    expect(ScenarioRefSchema.safeParse({ scenarioId: 'S3' }).success).toBe(false);
    expect(ScenarioRefSchema.safeParse({ ...ref, extra: 1 }).success).toBe(false);
    expect(ScenarioRefSchema.safeParse({ daemonId, scenarioId: '' }).success).toBe(false);
  });
});

describe('ApiStatusSchema', () => {
  const daemonStatus = { pid: 1, startedAt: 0, version: '0.0.0', dataDir: '/d', state: 'running' };

  it('is the daemon status plus the daemon id and the API version', () => {
    const status = { ...daemonStatus, daemonId, apiVersion: API_VERSION };
    expect(ApiStatusSchema.parse(status)).toEqual(status);
    expect(ApiStatusSchema.safeParse(daemonStatus).success).toBe(false);
    expect(ApiStatusSchema.safeParse({ ...status, extra: 1 }).success).toBe(false);
    expect(ApiStatusSchema.safeParse({ ...status, apiVersion: 0 }).success).toBe(false);
  });

  it('says layer 3 and the effective security.unenforced, and an old daemon may say neither (N334)', () => {
    const base = { ...daemonStatus, daemonId, apiVersion: API_VERSION };
    const security = { layer3: false, unenforced: 'refuse' };
    expect(ApiStatusSchema.parse({ ...base, security })).toEqual({ ...base, security });
    expect(ApiStatusSchema.parse(base).security).toBeUndefined();
    expect(ApiStatusSchema.safeParse({ ...base, security: { layer3: false } }).success).toBe(false);
    expect(
      ApiStatusSchema.safeParse({ ...base, security: { layer3: true, unenforced: 'off' } }).success,
    ).toBe(false);
    expect(
      ApiStatusSchema.safeParse({ ...base, security: { ...security, extra: 1 } }).success,
    ).toBe(false);
  });

  it('leaves DaemonStatusSchema as it was (`ot daemon` uses it)', () => {
    expect(DaemonStatusSchema.safeParse(daemonStatus).success).toBe(true);
    expect(DaemonStatusSchema.safeParse({ ...daemonStatus, daemonId }).success).toBe(false);
  });

  it('is what GET /v1/status answers', () => {
    expect(getStatus.method).toBe('GET');
    expect(getStatus.path).toBe('/v1/status');
    expect(getStatus.response).toBe(ApiStatusSchema);
    expect(isSupportedApiVersion(API_VERSION)).toBe(true);
    expect(isSupportedApiVersion(API_VERSION + 1)).toBe(false);
  });
});

describe('pagination', () => {
  it('reads the query strings and fills the default limit', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: API_PAGE_DEFAULT_LIMIT });
    expect(PageQuerySchema.parse({ after: 'c1', limit: '25' })).toEqual({ after: 'c1', limit: 25 });
  });

  it('refuses a limit above the ceiling, below one or fractional, and an empty cursor', () => {
    for (const bad of [
      { limit: String(API_PAGE_MAX_LIMIT + 1) },
      { limit: '0' },
      { limit: '1.5' },
      { limit: 'many' },
      { after: '' },
      { other: 1 },
    ]) {
      expect(PageQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(PageQuerySchema.safeParse({ limit: String(API_PAGE_MAX_LIMIT) }).success).toBe(true);
  });

  it('wraps any item schema in { items, nextCursor }', () => {
    const schema = pageOf(z.strictObject({ id: z.string() }));
    const page = { items: [{ id: 'a' }], nextCursor: 'k' };
    expect(schema.parse(page)).toEqual(page);
    expect(schema.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(schema.safeParse({ items: [{ id: 1 }], nextCursor: null }).success).toBe(false);
    expect(schema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('Idempotency-Key', () => {
  it('names the header and checks the key', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
    expect(IdempotencyKeySchema.safeParse('3f2b8c1e-9d4a').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('has space').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('x'.repeat(256)).success).toBe(false);
  });

  it('is optional in the headers and lets other headers through', () => {
    expect(IdempotencyHeadersSchema.safeParse({}).success).toBe(true);
    expect(
      IdempotencyHeadersSchema.safeParse({ 'idempotency-key': 'k1', accept: 'application/json' })
        .success,
    ).toBe(true);
    expect(IdempotencyHeadersSchema.safeParse({ 'idempotency-key': '' }).success).toBe(false);
  });
});
