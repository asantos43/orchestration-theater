// SPDX-License-Identifier: MPL-2.0
import {
  API_ROUTES,
  PageQuerySchema,
  IdempotencyHeadersSchema,
  apiError,
  defaultLayout,
  defineRoute,
  pageOf,
} from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiClient } from './client.js';
import {
  ApiInputError,
  ApiNetworkError,
  ApiProtocolError,
  ApiRequestError,
  ApiVersionError,
  DaemonIdMismatchError,
} from './errors.js';
import { startTestDaemon, type TestDaemon } from './test-daemon.test-support.js';

const open: TestDaemon[] = [];
async function daemon(options?: Parameters<typeof startTestDaemon>[0]): Promise<TestDaemon> {
  const started = await startTestDaemon(options);
  open.push(started);
  return started;
}
afterEach(async () => {
  for (const started of open.splice(0)) await started.close();
});

function clientOf(started: TestDaemon, extra: { timeoutMs?: number } = {}): ApiClient {
  return new ApiClient({
    url: started.url,
    token: started.token,
    daemonId: started.daemonId,
    ...extra,
  });
}

/** A route with a query, a list answer and a command header: none of the first routes has them yet. */
const listThings = defineRoute({
  id: 'listThings',
  method: 'GET',
  path: '/v1/things/:kind',
  summary: 'test route',
  params: z.strictObject({ kind: z.string() }),
  query: PageQuerySchema.extend({ tag: z.array(z.string()).optional() }),
  response: pageOf(z.strictObject({ id: z.string() })),
});
const createThing = defineRoute({
  id: 'createThing',
  method: 'POST',
  path: '/v1/things',
  summary: 'test route',
  headers: IdempotencyHeadersSchema,
  body: z.strictObject({ name: z.string().min(1) }),
  response: z.strictObject({ id: z.string() }),
  errors: ['conflict'],
});

describe('typed calls', () => {
  it('status() sends the bearer token and returns the parsed status', async () => {
    const started = await daemon();
    const status = await clientOf(started).status();
    expect(status.daemonId).toBe(started.daemonId);
    expect(status.state).toBe('running');
    const [request] = started.requests;
    expect(request?.method).toBe('GET');
    expect(request?.target).toBe('/v1/status');
    expect(request?.headers.authorization).toBe(`Bearer ${started.token}`);
    expect(request?.headers.accept).toBe('application/json');
  });

  it('fills the path parameters and sends the JSON body', async () => {
    const started = await daemon();
    const client = clientOf(started);
    const layout = { ...defaultLayout('tui'), chatWidth: 77 };
    const saved = await client.call(API_ROUTES.putLayout, {
      params: { interface: 'tui' },
      body: layout,
    });
    expect(saved).toEqual(layout);
    expect(await client.call(API_ROUTES.getLayout, { params: { interface: 'tui' } })).toEqual(
      layout,
    );
    expect(await client.call(API_ROUTES.getLayout, { params: { interface: 'web' } })).toEqual(
      defaultLayout('web'),
    );
    const put = started.requests.find((request) => request.method === 'PUT');
    expect(put?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(put?.body ?? '')).toEqual(layout);
  });

  it('serializes the query (lists as repeated keys) and the extra headers', async () => {
    const started = await daemon({
      handler: (request) =>
        request.target.startsWith('/v1/things')
          ? {
              json:
                request.method === 'GET'
                  ? { items: [{ id: 'a' }], nextCursor: null }
                  : { id: 'n1' },
            }
          : undefined,
    });
    const client = clientOf(started);
    const page = await client.call(listThings, {
      params: { kind: 'a b/c' },
      query: { limit: 5, tag: ['x', 'y'], after: 'cur' },
    });
    expect(page.items).toEqual([{ id: 'a' }]);
    const created = await client.call(createThing, {
      body: { name: 'n' },
      headers: { 'Idempotency-Key': 'k-1' },
    });
    expect(created).toEqual({ id: 'n1' });
    const [get, post] = started.requests;
    expect(get?.target).toBe('/v1/things/a%20b%2Fc?limit=5&tag=x&tag=y&after=cur');
    expect(post?.headers['idempotency-key']).toBe('k-1');
  });

  it('keeps a path prefix of the base URL and ignores a trailing slash', async () => {
    const seen: string[] = [];
    const client = new ApiClient({
      url: 'https://example.test/prefix//',
      token: 't',
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve(new Response('{}', { status: 500 }));
      },
    });
    await client.status().catch(() => undefined);
    expect(seen).toEqual(['https://example.test/prefix/v1/status']);
  });

  it('types the options by the route (checked by the compiler, not at run time)', () => {
    const client = new ApiClient({ url: 'http://127.0.0.1:1', token: 't' });
    const never = (): void => {
      // @ts-expect-error getLayout needs its path parameters
      void client.call(API_ROUTES.getLayout);
      // @ts-expect-error the interface is 'tui' or 'web'
      void client.call(API_ROUTES.getLayout, { params: { interface: 'phone' } });
      // @ts-expect-error putLayout needs a body
      void client.call(API_ROUTES.putLayout, { params: { interface: 'tui' } });
      // @ts-expect-error getStatus takes no body
      void client.call(API_ROUTES.getStatus, { body: {} });
      void client.call(API_ROUTES.getStatus);
      void client.call(API_ROUTES.getStatus, { timeoutMs: 5 });
      // @ts-expect-error a command with a required body
      void client.call(createThing);
    };
    expect(typeof never).toBe('function');
  });

  it('refuses a stream route and an input outside the schema without sending anything', async () => {
    const started = await daemon();
    const client = clientOf(started);
    await expect(
      (client as unknown as { call(route: unknown): Promise<unknown> }).call(
        API_ROUTES.streamEvents,
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      client.call(API_ROUTES.putLayout, {
        params: { interface: 'tui' },
        body: { ...defaultLayout('tui'), chatWidth: 0 },
      }),
    ).rejects.toMatchObject({ name: 'ApiInputError', part: 'body' });
    await expect(
      client.call(API_ROUTES.getLayout, { params: { interface: 'phone' as never } }),
    ).rejects.toBeInstanceOf(ApiInputError);
    await expect(client.call(API_ROUTES.getStatus, { body: 1 } as never)).rejects.toMatchObject({
      part: 'body',
    });
    expect(started.requests).toEqual([]);
  });

  it('scenarioRef needs the id of the daemon and returns the global reference', async () => {
    const started = await daemon();
    expect(clientOf(started).scenarioRef('S1')).toEqual({
      daemonId: started.daemonId,
      scenarioId: 'S1',
    });
    expect(() => new ApiClient({ url: started.url, token: 't' }).scenarioRef('S1')).toThrow(
      TypeError,
    );
  });
});

describe('pause, resume and cancel (N176)', () => {
  const play = {
    id: 'play-1',
    scenarioId: 's1',
    need: 'Do it',
    flowId: 'software',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
    parentPlayId: null,
    createdAt: 1,
    updatedAt: 2,
    finishedAt: null,
  };
  const attempt = {
    attemptId: 'play-1/alpha/1',
    playId: 'play-1',
    demandId: 'alpha',
    attempt: 1,
    client: 'fake',
    profile: 'one',
    state: 'awaiting_resume',
    cause: 'paused',
    sessionId: 'session-1',
    branch: 'attempt/alpha',
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    freeResumes: 0,
    createdAt: 1,
    updatedAt: 2,
  };

  it('pauses and resumes a play, with the mode, the reason and the key as the daemon reads them', async () => {
    const started = await daemon({
      handler: (request) =>
        request.target.startsWith('/v1/plays/') ? { json: { play } } : undefined,
    });
    const client = clientOf(started);
    expect((await client.pausePlay('play-1')).play.id).toBe('play-1');
    await client.pausePlay('play-1', {
      mode: 'interrupt',
      reason: 'lunch',
      idempotencyKey: 'k-1',
    });
    await client.resumePlay('play-1', { reason: 'back' });
    const [bare, named, resume] = started.requests;
    expect(bare?.method).toBe('POST');
    expect(bare?.target).toBe('/v1/plays/play-1/pause');
    expect(bare?.body ?? '').toBe('');
    expect(JSON.parse(named?.body ?? '')).toEqual({ mode: 'interrupt', reason: 'lunch' });
    expect(named?.headers['idempotency-key']).toBe('k-1');
    expect(resume?.target).toBe('/v1/plays/play-1/resume');
    expect(JSON.parse(resume?.body ?? '')).toEqual({ reason: 'back' });
  });

  it('pauses, resumes and cancels an Actor, with the id of the attempt percent-encoded', async () => {
    const started = await daemon({
      handler: (request) =>
        request.target.startsWith('/v1/attempts/') ? { json: { attempt } } : undefined,
    });
    const client = clientOf(started);
    const encoded = encodeURIComponent(attempt.attemptId);
    expect((await client.pauseAttempt(attempt.attemptId)).attempt.cause).toBe('paused');
    await client.resumeAttempt(attempt.attemptId, { idempotencyKey: 'k-2' });
    await client.cancelAttempt(attempt.attemptId);
    expect(started.requests.map((request) => request.target)).toEqual([
      `/v1/attempts/${encoded}/pause`,
      `/v1/attempts/${encoded}/resume`,
      `/v1/attempts/${encoded}/cancel`,
    ]);
    expect(started.requests[1]?.headers['idempotency-key']).toBe('k-2');
  });
  it('opens, drives, promotes and closes a direct session, with the ids percent-encoded', async () => {
    const session = {
      id: 'direct-1',
      scenarioId: 'scn-1',
      executor: 'fake/one',
      profile: 'fake/one',
      client: 'fake',
      model: null,
      workspace: 'worktree',
      branch: 'direct/direct-1',
      state: 'idle',
      turns: 0,
      openedAt: 1,
      lastActivityAt: 1,
      closedAt: null,
      commands: [],
    };
    const answers: Record<string, unknown> = {
      'POST /v1/scenarios/scn-1/direct': {
        status: 'opened',
        workspace: 'worktree',
        session: { ...session, items: [] },
      },
      'GET /v1/scenarios/scn-1/direct': { sessions: [session] },
      'GET /v1/direct/direct-1': { ...session, items: [] },
      'POST /v1/direct/direct-1/messages': { turn: 1 },
      'POST /v1/direct/direct-1/commands': { turn: 2 },
      'POST /v1/direct/direct-1/cancel': { cancelled: false },
      'POST /v1/direct/direct-1/promote': { target: 'demand', ref: 'idea-1' },
      'POST /v1/direct/direct-1/close': { work: 'none', branch: null },
    };
    const started = await daemon({
      handler: (request) => {
        const answer = answers[`${request.method} ${request.target.split('?')[0] ?? ''}`];
        return answer === undefined ? undefined : { json: answer };
      },
    });
    const client = clientOf(started);
    const opened = await client.openDirectSession(
      'scn-1',
      { executor: 'fake/one' },
      { idempotencyKey: 'k-3' },
    );
    expect(opened.status).toBe('opened');
    expect((await client.listDirectSessions('scn-1')).sessions).toHaveLength(1);
    expect((await client.getDirectSession('direct-1')).items).toEqual([]);
    expect((await client.sendDirectMessage('direct-1', 'hello')).turn).toBe(1);
    expect((await client.runDirectCommand('direct-1', '/fake:fake-command x')).turn).toBe(2);
    expect((await client.cancelDirectTurn('direct-1')).cancelled).toBe(false);
    expect((await client.promoteDirectSession('direct-1', { target: 'demand' })).ref).toBe(
      'idea-1',
    );
    expect((await client.closeDirectSession('direct-1')).work).toBe('none');
    const [open, , , message, command, , promote] = started.requests;
    expect(JSON.parse(open?.body ?? '')).toEqual({ executor: 'fake/one' });
    expect(open?.headers['idempotency-key']).toBe('k-3');
    expect(JSON.parse(message?.body ?? '')).toEqual({ text: 'hello' });
    expect(JSON.parse(command?.body ?? '')).toEqual({ text: '/fake:fake-command x' });
    expect(JSON.parse(promote?.body ?? '')).toEqual({ target: 'demand' });
  });
});

describe('errors', () => {
  it('an error answer of the API is an ApiRequestError with code, status and details', async () => {
    const started = await daemon({
      handler: () => ({
        status: 503,
        headers: { 'retry-after': '3' },
        json: apiError('recovering', 'Still starting', { step: 'reconcile' }),
      }),
    });
    const error = await clientOf(started)
      .status()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      code: 'recovering',
      status: 503,
      details: { step: 'reconcile' },
      retryAfterSeconds: 3,
      daemonId: started.daemonId,
      routeId: 'getStatus',
    });
  });

  it('a wrong token is an unauthorized ApiRequestError, and the token is in no message', async () => {
    const started = await daemon();
    const client = new ApiClient({ url: started.url, token: 'wrong-secret-token' });
    const error = (await client.status().catch((caught: unknown) => caught)) as ApiRequestError;
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(`${error.message} ${JSON.stringify(error)} ${error.stack ?? ''}`).not.toContain(
      'wrong-secret-token',
    );
  });

  it('a 404 from the daemon keeps its code', async () => {
    const started = await daemon();
    const error = await clientOf(started)
      .call(API_ROUTES.getLayout, { params: { interface: 'tui' } })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeUndefined();
    started.respondWith(() => ({ status: 404, json: apiError('not_found', 'No such thing') }));
    await expect(clientOf(started).status()).rejects.toMatchObject({
      name: 'ApiRequestError',
      code: 'not_found',
      status: 404,
    });
  });

  it.each([
    ['a body that is not JSON', { text: '{"daemonId": ' }, 'invalid_json', 200],
    ['an empty success body', { text: '' }, 'invalid_response', 200],
    ['a success body outside the schema', { json: { pid: 'x' } }, 'invalid_response', 200],
    [
      'an HTML error page',
      { status: 502, text: '<html>Bad gateway</html>' },
      'invalid_error_body',
      502,
    ],
    [
      'an error body of another shape',
      { status: 500, json: { oops: true } },
      'invalid_error_body',
      500,
    ],
    [
      'an unknown error code',
      { status: 400, json: { error: { code: 'made_up', message: 'x' } } },
      'invalid_error_body',
      400,
    ],
    [
      'a redirect',
      { status: 302, headers: { location: 'http://elsewhere.test/' }, text: '' },
      'invalid_error_body',
      302,
    ],
  ] as const)(
    '%s is an ApiProtocolError, never a loose exception',
    async (_name, reply, reason, status) => {
      const started = await daemon({ handler: () => reply });
      const error = await clientOf(started)
        .status()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiProtocolError);
      expect(error).toMatchObject({ reason, status, daemonId: started.daemonId });
    },
  );

  it('lists which fields of a bad success answer do not fit', async () => {
    const started = await daemon({
      handler: () => ({
        json: { pid: 1, startedAt: 0, version: 'v', dataDir: '/d', state: 'nope' },
      }),
    });
    const error = (await clientOf(started)
      .status()
      .catch((caught: unknown) => caught)) as ApiProtocolError;
    expect(error.issues.map((issue) => issue.path[0])).toEqual(
      expect.arrayContaining(['state', 'daemonId', 'apiVersion']),
    );
  });

  it('a daemon that is not there is an ApiNetworkError of reason connection', async () => {
    const started = await daemon();
    const client = clientOf(started);
    await started.close();
    open.splice(open.indexOf(started), 1);
    const error = await client.status().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect(error).toMatchObject({ reason: 'connection', daemonId: started.daemonId });
  });

  it('a daemon that does not answer in time is a timeout, per client and per call', async () => {
    const started = await daemon({ handler: () => ({ hang: true }) });
    const started0 = Date.now();
    await expect(clientOf(started, { timeoutMs: 60 }).status()).rejects.toMatchObject({
      name: 'ApiNetworkError',
      reason: 'timeout',
    });
    expect(Date.now() - started0).toBeLessThan(2000);
    await expect(clientOf(started).status({ timeoutMs: 60 })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('a body that stalls after the headers also times out', async () => {
    const started = await daemon();
    const client = new ApiClient({
      url: started.url,
      token: started.token,
      timeoutMs: 60,
      fetch: (_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener('abort', () => {
                  controller.error(init.signal?.reason);
                });
              },
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(client.status()).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('the caller can abort a call, before or during it', async () => {
    const started = await daemon({ handler: () => ({ hang: true }) });
    const client = clientOf(started);
    const controller = new AbortController();
    const pending = client.status({ signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 30);
    await expect(pending).rejects.toMatchObject({ name: 'ApiNetworkError', reason: 'aborted' });
    await expect(client.status({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      reason: 'aborted',
    });
  });

  it('a timeout of 0 means no deadline', async () => {
    const started = await daemon({
      handler: () => ({ delayMs: 80, json: apiError('internal', 'x'), status: 500 }),
    });
    await expect(clientOf(started, { timeoutMs: 0 }).status()).rejects.toMatchObject({
      code: 'internal',
    });
  });
});

describe('connect()', () => {
  it('returns the status when the daemon is the one expected', async () => {
    const started = await daemon();
    expect((await clientOf(started).connect()).daemonId).toBe(started.daemonId);
  });

  it('a different daemon id is a DaemonIdMismatchError', async () => {
    const started = await daemon();
    const other = '11111111-1111-4111-8111-111111111111';
    const error = await new ApiClient({
      url: started.url,
      token: started.token,
      daemonId: other,
    })
      .connect()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DaemonIdMismatchError);
    expect(error).toMatchObject({ expected: other, actual: started.daemonId, daemonId: other });
  });

  it('an API version this build does not speak is an ApiVersionError', async () => {
    const started = await daemon({ apiVersion: 99 });
    await expect(clientOf(started).connect()).rejects.toBeInstanceOf(ApiVersionError);
  });

  it('with no expected id it checks only the version', async () => {
    const started = await daemon();
    const status = await new ApiClient({ url: started.url, token: started.token }).connect();
    expect(status.daemonId).toBe(started.daemonId);
  });
});
