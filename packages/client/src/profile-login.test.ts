// SPDX-License-Identifier: MPL-2.0
import { API_ROUTES } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from './client.js';
import { startTestDaemon, type TestDaemon } from './test-daemon.test-support.js';

/**
 * The typed calls of the official login (P5 of Phase 7, N186): the client has no method per route,
 * so `call(API_ROUTES.<id>, ...)` is the typed call. The stand-in daemon answers like the real one.
 */

const open: TestDaemon[] = [];
afterEach(async () => {
  for (const started of open.splice(0)) await started.close();
});

describe('the login routes through the client', () => {
  it('opens, hands the code and cancels, with typed parameters and answers', async () => {
    const started = await startTestDaemon();
    open.push(started);
    started.respondWith((request) => {
      if (request.method !== 'POST' || !request.target.startsWith('/v1/profiles/'))
        return undefined;
      if (request.target.endsWith('/login')) {
        return {
          json: {
            status: 'started',
            profileId: 'claude-code/main',
            mode: 'browser',
            url: 'https://login.example.test/x',
            code: null,
            takesCode: true,
          },
        };
      }
      if (request.target.endsWith('/login/code')) {
        return { json: { profileId: 'claude-code/main', submitted: true } };
      }
      return { json: { profileId: 'claude-code/main', cancelled: true } };
    });
    const client = new ApiClient({
      url: started.url,
      token: started.token,
      daemonId: started.daemonId,
    });
    const params = { client: 'claude-code', name: 'main' };

    const opened = await client.call(API_ROUTES.startProfileLogin, {
      params,
      headers: { 'Idempotency-Key': 'login-1' },
    });
    expect(opened.status).toBe('started');
    if (opened.status === 'started') {
      expect(opened.takesCode).toBe(true);
      expect(opened.url).toBe('https://login.example.test/x');
    }

    const sent = await client.call(API_ROUTES.submitProfileLoginCode, {
      params,
      body: { code: 'pasted-code' },
    });
    expect(sent.submitted).toBe(true);
    const cancelled = await client.call(API_ROUTES.cancelProfileLogin, { params });
    expect(cancelled.cancelled).toBe(true);

    expect(started.requests.map((r) => `${r.method} ${r.target}`)).toEqual([
      'POST /v1/profiles/claude-code/main/login',
      'POST /v1/profiles/claude-code/main/login/code',
      'POST /v1/profiles/claude-code/main/login/cancel',
    ]);
    expect(started.requests[0]?.headers['idempotency-key']).toBe('login-1');
    expect(JSON.parse(started.requests[1]?.body ?? '{}')).toEqual({ code: 'pasted-code' });
  });

  it('an answer that is neither started nor local is a protocol error', async () => {
    const started = await startTestDaemon();
    open.push(started);
    started.respondWith(() => ({ json: { status: 'weird', profileId: 'a/b' } }));
    const client = new ApiClient({ url: started.url, token: started.token });
    await expect(
      client.call(API_ROUTES.startProfileLogin, { params: { client: 'a', name: 'b' } }),
    ).rejects.toThrow();
  });
});
