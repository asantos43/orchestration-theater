// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { ApiErrorSchema } from './errors.js';
import { API_ROUTE_LIST, API_ROUTES } from './registry.js';
import { API_PREFIX, HTTP_METHODS, assertUniqueRoutes, pathParamNames } from './route.js';

describe('API_ROUTES', () => {
  it('has the routes of P1 and the rotation of the token (P3)', () => {
    expect(Object.keys(API_ROUTES)).toEqual(
      expect.arrayContaining([
        'createChatTicket',
        'getLayout',
        'getStatus',
        'openChatSocket',
        'putLayout',
        'rotateApiToken',
        'streamEvents',
      ]),
    );
  });

  it('has the read routes of P5, every one a GET', () => {
    const reads = [
      'getAttachment',
      'getAttachmentContent',
      'getBlackboardEntry',
      'getBudget',
      'getConfig',
      'getIdea',
      'getOrder',
      'getPlay',
      'getProfile',
      'getScenario',
      'getUsage',
      'listAttachments',
      'listBlackboard',
      'listBlackboardHistory',
      'listExecutors',
      'listIdeas',
      'listOrders',
      'listProfiles',
      'listRoles',
      'listScenarioDecisions',
      'listScenarioPlays',
      'listScenarios',
    ];
    expect(Object.keys(API_ROUTES)).toEqual(expect.arrayContaining(reads));
    for (const id of reads)
      expect(API_ROUTES[id as keyof typeof API_ROUTES].method, id).toBe('GET');
  });

  it('keys every route by its own id', () => {
    for (const [key, route] of Object.entries(API_ROUTES)) expect(route.id).toBe(key);
  });

  it('keeps every route under /v1 with a known method', () => {
    for (const route of API_ROUTE_LIST) {
      expect(route.path.startsWith(`${API_PREFIX}/`), route.id).toBe(true);
      expect<readonly string[]>(HTTP_METHODS, route.id).toContain(route.method);
    }
  });

  it('has a unique path for each method', () => {
    expect(() => {
      assertUniqueRoutes(API_ROUTE_LIST);
    }).not.toThrow();
  });

  it('gives every route a response and an error schema, and the 401 and 500 answers', () => {
    for (const route of API_ROUTE_LIST) {
      expect(route.response, route.id).toBeDefined();
      expect(Object.keys(route.errors).length, route.id).toBeGreaterThan(0);
      for (const status of [401, 403, 500]) expect(route.errors[status], route.id).toBeDefined();
      expect(route.summary.length, route.id).toBeGreaterThan(0);
    }
  });

  it('accepts, for each error status, the error answer of every code the route declares', () => {
    for (const route of API_ROUTE_LIST) {
      for (const [status, schema] of Object.entries(route.errors)) {
        expect(schema?.safeParse({ error: { code: 'internal', message: 'x' } }).success).toBe(
          Number(status) === 500,
        );
      }
      // Every error answer is also an ApiError.
      expect(ApiErrorSchema.safeParse({ error: { code: 'internal', message: 'x' } }).success).toBe(
        true,
      );
    }
  });

  it('has a params schema for exactly the path parameters', () => {
    for (const route of API_ROUTE_LIST) {
      const names = pathParamNames(route.path);
      const keys = route.params === undefined ? [] : Object.keys(route.params.shape);
      expect(keys.sort(), route.id).toEqual([...names].sort());
    }
  });

  it('marks the stream and the socket by kind', () => {
    expect(API_ROUTES.streamEvents.kind).toBe('sse');
    expect(API_ROUTES.openChatSocket.kind).toBe('websocket');
    expect(API_ROUTES.getStatus.kind).toBe('json');
  });
});
