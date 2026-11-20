// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_PREFIX,
  API_VERSION,
  assertUniqueRoutes,
  defineRoute,
  defineRoutes,
  pathParamNames,
  routePath,
} from './route.js';

const base = {
  method: 'GET',
  summary: 's',
  response: z.strictObject({ ok: z.boolean() }),
} as const;

describe('defineRoute', () => {
  it('has a version and a prefix that agree', () => {
    expect(API_VERSION).toBe(1);
    expect(API_PREFIX).toBe('/v1');
  });

  it('fills the common error answers, grouped by status', () => {
    const route = defineRoute({ ...base, id: 'a', path: '/v1/a' });
    expect(route.kind).toBe('json');
    expect(route.errorCodes).toEqual(['forbidden', 'internal', 'unauthorized']);
    expect(Object.keys(route.errors)).toEqual(['401', '403', '500']);
    expect(
      route.errors[401]?.safeParse({ error: { code: 'unauthorized', message: 'x' } }).success,
    ).toBe(true);
    expect(
      route.errors[401]?.safeParse({ error: { code: 'forbidden', message: 'x' } }).success,
    ).toBe(false);
  });

  it('adds invalid_input when the route reads input, plus the declared codes', () => {
    const route = defineRoute({
      ...base,
      id: 'b',
      path: '/v1/b',
      query: z.strictObject({ q: z.string() }),
      errors: ['unavailable', 'recovering', 'not_found'],
    });
    expect(route.errorCodes).toContain('invalid_input');
    // `unavailable` and `recovering` share the status 503 and one schema.
    const schema503 = route.errors[503];
    expect(schema503?.safeParse({ error: { code: 'recovering', message: '' } }).success).toBe(true);
    expect(schema503?.safeParse({ error: { code: 'unavailable', message: '' } }).success).toBe(
      true,
    );
    expect(schema503?.safeParse({ error: { code: 'not_found', message: '' } }).success).toBe(false);
  });

  it('refuses a path outside /v1, params that do not match the path, and a stray clientMessage', () => {
    expect(() => defineRoute({ ...base, id: 'c', path: '/v2/c' })).toThrow(
      /must start with \/v1\//,
    );
    expect(() => defineRoute({ ...base, id: 'd', path: '/v1/d/:x' })).toThrow(/do not match/);
    expect(() =>
      defineRoute({
        ...base,
        id: 'e',
        path: '/v1/e',
        params: z.strictObject({ x: z.string() }),
      }),
    ).toThrow(/do not match/);
    expect(() =>
      defineRoute({ ...base, id: 'f', path: '/v1/f', clientMessage: z.string() }),
    ).toThrow(/clientMessage/);
    expect(() => defineRoute({ ...base, id: 'g', path: '/v1/g', kind: 'websocket' })).toThrow(
      /clientMessage/,
    );
  });
});

describe('routePath', () => {
  const route = defineRoute({
    ...base,
    id: 'h',
    path: '/v1/x/:id/y/:name',
    params: z.strictObject({ id: z.string(), name: z.string() }),
  });

  it('reads the parameter names in order', () => {
    expect(pathParamNames(route.path)).toEqual(['id', 'name']);
    expect(pathParamNames('/v1/status')).toEqual([]);
  });

  it('fills and encodes the parameters', () => {
    expect(routePath(route, { id: 'S 1/2', name: 'a' })).toBe('/v1/x/S%201%2F2/y/a');
  });

  it('refuses a missing or an extra parameter', () => {
    expect(() => routePath(route, { id: 'a' })).toThrow(/expected the parameters/);
    expect(() => routePath(route, { id: 'a', name: 'b', other: 'c' })).toThrow();
  });
});

describe('defineRoutes and assertUniqueRoutes', () => {
  const one = defineRoute({ ...base, id: 'one', path: '/v1/one' });
  const two = defineRoute({ ...base, id: 'two', path: '/v1/two' });

  it('keys the table by id', () => {
    const table = defineRoutes(one, two);
    expect(table.one).toBe(one);
    expect(Object.keys(table)).toEqual(['one', 'two']);
  });

  it('refuses a repeated id', () => {
    expect(() => defineRoutes(one, { ...two, id: 'one' })).toThrow(/share the id/);
    expect(() => {
      assertUniqueRoutes([one, { ...two, id: 'one' }]);
    }).toThrow(/used twice/);
  });

  it('refuses the same method and path, even with another parameter name', () => {
    const a = defineRoute({
      ...base,
      id: 'pa',
      path: '/v1/p/:x',
      params: z.strictObject({ x: z.string() }),
    });
    const b = defineRoute({
      ...base,
      id: 'pb',
      path: '/v1/p/:y',
      params: z.strictObject({ y: z.string() }),
    });
    expect(() => {
      assertUniqueRoutes([a, b]);
    }).toThrow(/both GET/);
    // Another method on the same path is fine.
    expect(() => {
      assertUniqueRoutes([a, { ...b, method: 'PUT' }]);
    }).not.toThrow();
  });
});
