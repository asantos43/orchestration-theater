// SPDX-License-Identifier: MPL-2.0
import { API_ROUTES, SetupRunViewSchema, type SetupRunView } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from './client.js';
import { ApiInputError, ApiRequestError } from './errors.js';
import { startTestDaemon, type TestDaemon } from './test-daemon.test-support.js';

const RUN_ID = 'SR1';

const view: SetupRunView = {
  id: RUN_ID,
  flow: 'first_run',
  state: 'active',
  step: 'detect',
  steps: ['detect', 'preset', 'executors', 'review'],
  done: [],
  prompt: { step: 'detect', clients: [{ client: 'codex', installed: true }], profiles: [] },
  result: null,
  createdAt: 1,
  updatedAt: 1,
  finishedAt: null,
};

const open: TestDaemon[] = [];
afterEach(async () => {
  for (const started of open.splice(0)) await started.close();
});

async function clientOf(options: Parameters<typeof startTestDaemon>[0] = {}): Promise<{
  client: ApiClient;
  daemon: TestDaemon;
}> {
  const daemon = await startTestDaemon(options);
  open.push(daemon);
  return {
    client: new ApiClient({ url: daemon.url, token: daemon.token, daemonId: daemon.daemonId }),
    daemon,
  };
}

describe('the setup assistant through the typed client', () => {
  it('the schema of the test answer is the one of the protocol', () => {
    expect(SetupRunViewSchema.parse(view)).toEqual(view);
  });

  it('calls the six routes with the right method, path, key and body', async () => {
    const { client, daemon } = await clientOf({
      handler: (request) =>
        request.target.startsWith('/v1/setup')
          ? { json: request.target === '/v1/setup' ? { firstRunNeeded: true, flows: [] } : view }
          : undefined,
    });
    expect(await client.call(API_ROUTES.getSetup)).toEqual({ firstRunNeeded: true, flows: [] });
    const key = { 'Idempotency-Key': 'setup-1' };
    await client.call(API_ROUTES.startSetup, { params: { flow: 'first_run' }, headers: key });
    await client.call(API_ROUTES.submitSetupStep, {
      params: { runId: RUN_ID },
      body: { step: 'preset', input: { preset: 'balanced' } },
      headers: key,
    });
    await client.call(API_ROUTES.backSetup, { params: { runId: RUN_ID } });
    await client.call(API_ROUTES.confirmSetup, { params: { runId: RUN_ID }, headers: key });
    await client.call(API_ROUTES.cancelSetup, { params: { runId: RUN_ID } });
    expect(daemon.requests.map((request) => `${request.method} ${request.target}`)).toEqual([
      'GET /v1/setup',
      'POST /v1/setup/first_run/start',
      'POST /v1/setup/SR1/step',
      'POST /v1/setup/SR1/back',
      'POST /v1/setup/SR1/confirm',
      'POST /v1/setup/SR1/cancel',
    ]);
    const step = daemon.requests[2];
    expect(JSON.parse(step?.body ?? '')).toEqual({ step: 'preset', input: { preset: 'balanced' } });
    expect(step?.headers['idempotency-key']).toBe('setup-1');
  });

  it('refuses a flow or a step outside the schema without sending anything', async () => {
    const { client, daemon } = await clientOf();
    await expect(
      client.call(API_ROUTES.startSetup, { params: { flow: 'nope' as never } }),
    ).rejects.toBeInstanceOf(ApiInputError);
    await expect(
      client.call(API_ROUTES.submitSetupStep, {
        params: { runId: RUN_ID },
        body: { step: 'review', input: {} } as never,
      }),
    ).rejects.toBeInstanceOf(ApiInputError);
    expect(daemon.requests).toEqual([]);
  });

  it('keeps the code of a conflict (a run already in progress)', async () => {
    const { client } = await clientOf({
      handler: (request) =>
        request.target === '/v1/setup/first_run/start'
          ? { status: 409, json: { error: { code: 'conflict', message: 'a run is in progress' } } }
          : undefined,
    });
    const failure = await client
      .call(API_ROUTES.startSetup, { params: { flow: 'first_run' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({ code: 'conflict', status: 409 });
  });

  it('refuses an answer that is not a run view, naming the field', async () => {
    const { client } = await clientOf({
      handler: (request) =>
        request.target === '/v1/setup/SR1/confirm'
          ? { json: { ...view, state: 'lost' } }
          : undefined,
    });
    await expect(
      client.call(API_ROUTES.confirmSetup, { params: { runId: RUN_ID } }),
    ).rejects.toThrow(/state/);
  });
});
