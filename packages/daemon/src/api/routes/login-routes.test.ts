// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON */
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeLoginFlow,
  FakeProcessLauncher,
  InMemoryStore,
} from '@otheater/core/testing';
import type { DaemonId } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryGate } from '../../recovery/gate.js';
import { ProfileLoginService } from '../../profiles/login.js';
import type { ProfileService } from '../../profiles/service.js';
import type { DirectiveService } from '../../directives/index.js';
import type { LayoutPreferencesStore } from '../../layout/preferences.js';
import { captureLogger, makeTempDataDir, RecordingSituations } from '../../test-helpers.js';
import { generateApiToken } from '../files.js';
import { ApiServer } from '../server.js';
import { registerCommandRoutes } from './index.js';

/**
 * The login routes (P5 of Phase 7, N186) over a real `ApiServer`, a fake adapter and a fake login
 * flow: nothing real runs, no client is started, no credential is read.
 */

const DAEMON_ID = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11' as DaemonId;
const URL_SECRET = 'https://login.example.test/authorize?state=ROUTE-STATE-31337';
const CODE_SECRET = 'ABCD-4321';
const PASTED_SECRET = 'ROUTE-PASTED-7070';

let dispose: () => Promise<void>;
let server: ApiServer;
let token: string;
let flows: FakeLoginFlow[];
let store: InMemoryStore;
let lines: ReturnType<typeof captureLogger>['lines'];
let mode: 'browser' | 'device_code' | 'terminal';

beforeEach(async () => {
  const tmp = await makeTempDataDir();
  dispose = tmp.dispose;
  token = generateApiToken();
  flows = [];
  mode = 'browser';
  const clock = new FakeClock();
  store = new InMemoryStore({ clock });
  const captured = captureLogger();
  lines = captured.lines;
  const gate = new RecoveryGate();
  gate.open();
  server = await ApiServer.start({
    port: 'auto',
    token,
    tokenMode: 'persistent',
    tokenFile: join(tmp.dir, 'api-token'),
    discoveryFile: join(tmp.dir, 'api.json'),
    daemonId: DAEMON_ID,
    maxBodyBytes: 4096,
    rejectionWindowMs: 10_000,
    now: () => 1_000_000,
    logger: captured.logger,
    situations: new RecordingSituations(),
    gate,
  });
  const adapter = new FakeClientAdapter({
    id: 'opencode',
    launcher: new FakeProcessLauncher(),
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: [] },
    login: () => {
      const flow = new FakeLoginFlow({
        mode,
        url: URL_SECRET,
        ...(mode === 'device_code' ? { code: CODE_SECRET } : {}),
        acceptsCode: mode === 'browser',
        expectCode: PASTED_SECRET,
      });
      flows.push(flow);
      return flow;
    },
  });
  registerCommandRoutes(server.handlers, {
    store,
    clock,
    logger: captured.logger,
    directives: {} as DirectiveService,
    profiles: {} as ProfileService,
    logins: new ProfileLoginService({
      store,
      clock,
      logger: captured.logger,
      adapters: (client) => (client === 'opencode' ? adapter : undefined),
    }),
    configPath: join(tmp.dir, 'config.yaml'),
    idempotencyTtlMs: () => 60_000,
    layout: {} as LayoutPreferencesStore,
  });
  await store.profiles.create({
    client: 'opencode',
    name: 'main',
    kind: 'token_plan',
    provider: 'openai',
    dir: '/tmp/not-used/opencode-main',
    secretRef: null,
  });
});

afterEach(async () => {
  await server.stop();
  await dispose();
});

async function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: JSON.parse(text) };
}

const LOGIN = '/v1/profiles/opencode/main/login';

describe('the login routes', () => {
  it('opens a browser login, takes the pasted code and records the end as an event', async () => {
    const opened = await post(LOGIN);
    expect(opened.status).toBe(200);
    expect(opened.json).toEqual({
      status: 'started',
      profileId: 'opencode/main',
      mode: 'browser',
      url: URL_SECRET,
      code: null,
      takesCode: true,
    });

    const sent = await post(`${LOGIN}/code`, { code: PASTED_SECRET });
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ profileId: 'opencode/main', submitted: true });
    expect(sent.text).not.toContain(PASTED_SECRET);
    expect(flows[0]?.submitted).toEqual([PASTED_SECRET]);

    for (let i = 0; i < 200; i += 1) {
      const types = (await store.events.readFrom(0, 100)).map((e) => e.type);
      if (types.includes('profile.login.completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const events = (await store.events.readFrom(0, 100)).filter((e) =>
      e.type.startsWith('profile.login.'),
    );
    expect(events.map((e) => e.type)).toEqual(['profile.login.started', 'profile.login.completed']);

    // Only the first answer holds the URL; no event and no log line holds it, or a code.
    const written = JSON.stringify({ events: await store.events.readFrom(0, 100), lines });
    for (const secret of [URL_SECRET, 'ROUTE-STATE-31337', CODE_SECRET, PASTED_SECRET]) {
      expect(written).not.toContain(secret);
    }
  });

  it('opens a device_code login, answers the code, and cancel kills the process', async () => {
    mode = 'device_code';
    const opened = await post(LOGIN);
    expect(opened.json).toMatchObject({ mode: 'device_code', url: URL_SECRET, code: CODE_SECRET });
    expect(opened.json.takesCode).toBe(false);

    const refused = await post(`${LOGIN}/code`, { code: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('conflict');

    const cancelled = await post(`${LOGIN}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toEqual({ profileId: 'opencode/main', cancelled: true });
    expect(cancelled.text).not.toContain(URL_SECRET);
    expect(flows[0]?.cancelled).toBe(true);
    const failed = (await store.events.readFrom(0, 100)).find(
      (e) => e.type === 'profile.login.failed',
    );
    expect(failed?.payload).toMatchObject({ reason: 'cancelled', mode: 'device_code' });

    const again = await post(`${LOGIN}/cancel`);
    expect(again.json.cancelled).toBe(false);
  });

  it('answers that a terminal login is local and runs nothing', async () => {
    mode = 'terminal';
    const answer = await post(LOGIN);
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({
      status: 'local',
      profileId: 'opencode/main',
      mode: 'terminal',
      command: 'ot profile exec opencode/main login',
    });
    expect(
      (await store.events.readFrom(0, 100)).filter((e) => e.type.startsWith('profile.login.')),
    ).toEqual([]);
  });

  it('answers the first result again for the same Idempotency-Key, and opens one login only', async () => {
    const headers = { 'idempotency-key': 'login-1' };
    const first = await post(LOGIN, undefined, headers);
    const second = await post(LOGIN, undefined, headers);
    expect(second.json).toEqual(first.json);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect(flows).toHaveLength(1);
    // Another key while the login is open is a conflict.
    const other = await post(LOGIN, undefined, { 'idempotency-key': 'login-2' });
    expect(other.status).toBe(409);
  });

  it('answers 404 for an unknown profile and 400 for a body with no code', async () => {
    expect((await post('/v1/profiles/opencode/ghost/login')).status).toBe(404);
    expect((await post('/v1/profiles/opencode/ghost/login/cancel')).status).toBe(404);
    await post(LOGIN);
    const bad = await post(`${LOGIN}/code`, {});
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_input');
    const empty = await post(`${LOGIN}/code`, { code: '   ' });
    expect(empty.status).toBe(400);
  });
});
