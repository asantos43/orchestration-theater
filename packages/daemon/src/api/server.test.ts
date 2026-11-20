// SPDX-License-Identifier: MPL-2.0
import { request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { AdapterUnavailable } from '@otheater/core';
import { defaultLayout, type DaemonId } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { RecoveryGate } from '../recovery/gate.js';
import { makeTempDataDir, RecordingSituations } from '../test-helpers.js';
import { generateApiToken, readApiToken, readDiscovery } from './files.js';
import { ApiFailure } from './handlers.js';
import { ApiServer, type ApiServerOptions } from './server.js';

const DAEMON_ID = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11' as DaemonId;
const WINDOWS = process.platform === 'win32';

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly json: () => unknown;
}

/** A raw HTTP call: `fetch` would not let a test send a strange `Host`. */
function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method ?? 'GET',
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

describe('ApiServer', () => {
  let dir: string;
  let dispose: () => Promise<void>;
  let token: string;
  let situations: RecordingSituations;
  let clock: number;
  const servers: ApiServer[] = [];

  beforeEach(async () => {
    const tmp = await makeTempDataDir();
    dir = tmp.dir;
    dispose = tmp.dispose;
    token = generateApiToken();
    situations = new RecordingSituations();
    clock = 1_000_000;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    await dispose();
  });

  async function start(extra: Partial<ApiServerOptions> = {}): Promise<ApiServer> {
    const server = await ApiServer.start({
      port: 'auto',
      token,
      tokenMode: 'persistent',
      tokenFile: join(dir, 'api-token'),
      discoveryFile: join(dir, 'api.json'),
      daemonId: DAEMON_ID,
      maxBodyBytes: 1024,
      rejectionWindowMs: 10_000,
      now: () => clock,
      logger: createSilentLogger(),
      situations,
      ...extra,
    });
    servers.push(server);
    return server;
  }

  const bearer = (value = token): Record<string, string> => ({ authorization: `Bearer ${value}` });

  describe('the guard', () => {
    it('answers 401 without a token, with a wrong one and with a malformed header; the event never holds the value', async () => {
      const api = await start();
      api.handlers.register('getStatus', () => {
        throw new Error('must not run');
      });
      const none = await call(`${api.url}/v1/status`);
      expect(none.status).toBe(401);
      expect(none.json()).toEqual({
        error: { code: 'unauthorized', message: 'A valid API token is required' },
      });
      expect(none.headers['www-authenticate']).toBe('Bearer realm="otheater"');
      const wrong = await call(`${api.url}/v1/status`, { headers: bearer('not-the-token') });
      expect(wrong.status).toBe(401);
      const basic = await call(`${api.url}/v1/status`, { headers: { authorization: 'Basic abc' } });
      expect(basic.status).toBe(401);
      // Unknown routes do not leak their existence to a client without the token either.
      expect((await call(`${api.url}/v1/nothing`)).status).toBe(401);
      expect(situations.of('api.client_rejected')).toEqual([{ reason: 'token', suppressed: 0 }]);
      expect(JSON.stringify(situations.recorded)).not.toContain('not-the-token');
    });

    it('accepts the token on every route, status included', async () => {
      const api = await start();
      api.handlers.register('getStatus', () => ({
        pid: 1,
        startedAt: 0,
        version: '1.0.0',
        dataDir: dir,
        state: 'running' as const,
        daemonId: DAEMON_ID,
        apiVersion: 1,
      }));
      const ok = await call(`${api.url}/v1/status`, { headers: bearer() });
      expect(ok.status).toBe(200);
      expect(ok.json()).toMatchObject({ daemonId: DAEMON_ID, apiVersion: 1 });
      expect(situations.of('api.client_rejected')).toEqual([]);
    });

    it('answers 403 for a strange Host, even with the right token', async () => {
      const api = await start();
      const answer = await call(`${api.url}/v1/status`, {
        headers: { ...bearer(), host: 'evil.example:80' },
      });
      expect(answer.status).toBe(403);
      expect(answer.json()).toMatchObject({ error: { code: 'forbidden' } });
      const rebinding = await call(`${api.url}/v1/status`, {
        headers: { ...bearer(), host: `localhost:${String(api.port + 1)}` },
      });
      expect(rebinding.status).toBe(403);
      expect(situations.of('api.client_rejected')).toEqual([{ reason: 'host', suppressed: 0 }]);
    });

    it('accepts the Host localhost:<port> as well as 127.0.0.1:<port>', async () => {
      const api = await start();
      api.handlers.register('getLayout', () => defaultLayout('tui'));
      const answer = await call(`${api.url}/v1/layout/tui`, {
        headers: { ...bearer(), host: `localhost:${String(api.port)}` },
      });
      expect(answer.status).toBe(200);
    });

    it('answers 403 for an Origin outside api.cors.origins, with no CORS header', async () => {
      const api = await start({ corsOrigins: ['http://allowed.example'] });
      const answer = await call(`${api.url}/v1/status`, {
        headers: { ...bearer(), origin: 'http://evil.example' },
      });
      expect(answer.status).toBe(403);
      expect(answer.headers['access-control-allow-origin']).toBeUndefined();
      expect(situations.of('api.client_rejected')).toEqual([{ reason: 'origin', suppressed: 0 }]);
      expect(JSON.stringify(situations.recorded)).not.toContain('evil.example');
    });

    it('sends no Access-Control-Allow-* header by default, not even on a preflight', async () => {
      const api = await start();
      api.handlers.register('getLayout', () => defaultLayout('web'));
      const ok = await call(`${api.url}/v1/layout/web`, { headers: bearer() });
      expect(ok.status).toBe(200);
      const preflight = await call(`${api.url}/v1/layout/web`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://page.example',
          'access-control-request-method': 'GET',
        },
      });
      expect(preflight.status).toBe(403);
      for (const answer of [ok, preflight]) {
        expect(Object.keys(answer.headers).filter((h) => h.startsWith('access-control'))).toEqual(
          [],
        );
      }
    });

    it('answers CORS for an allowed origin: preflight without a token, the headers on the real call', async () => {
      const api = await start({ corsOrigins: ['http://page.example'] });
      api.handlers.register('getLayout', () => defaultLayout('web'));
      const preflight = await call(`${api.url}/v1/layout/web`, {
        method: 'OPTIONS',
        headers: { origin: 'http://page.example', 'access-control-request-method': 'GET' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('http://page.example');
      expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
      // The real call still needs the token.
      const noToken = await call(`${api.url}/v1/layout/web`, {
        headers: { origin: 'http://page.example' },
      });
      expect(noToken.status).toBe(401);
      const ok = await call(`${api.url}/v1/layout/web`, {
        headers: { ...bearer(), origin: 'http://page.example' },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers['access-control-allow-origin']).toBe('http://page.example');
      expect(ok.headers.vary).toBe('Origin');
    });

    it('records at most one event per reason per window and counts what it held back', async () => {
      const api = await start();
      for (let i = 0; i < 4; i += 1) await call(`${api.url}/v1/status`);
      expect(situations.of('api.client_rejected')).toEqual([{ reason: 'token', suppressed: 0 }]);
      clock += 10_000;
      await call(`${api.url}/v1/status`);
      expect(situations.of('api.client_rejected')).toEqual([
        { reason: 'token', suppressed: 0 },
        { reason: 'token', suppressed: 3 },
      ]);
      // Another reason has its own window.
      await call(`${api.url}/v1/status`, { headers: { ...bearer(), host: 'x:1' } });
      expect(situations.of('api.client_rejected')).toHaveLength(3);
    });

    it('guard() is the same check for a route that takes over the connection', async () => {
      const api = await start();
      const url = `http://127.0.0.1:${String(api.port)}/v1/chat/socket`;
      const good = new Request(url, {
        headers: { ...bearer(), host: `127.0.0.1:${String(api.port)}` },
      });
      expect(api.guard(good)).toBeUndefined();
      const bad = new Request(url, { headers: { host: `127.0.0.1:${String(api.port)}` } });
      expect(api.guard(bad)?.status).toBe(401);
    });
  });

  describe('the routes', () => {
    it('answers 404 not_found for a route with no handler and for a path that does not exist', async () => {
      const api = await start();
      for (const path of ['/v1/layout/tui', '/v1/not-a-route']) {
        const answer = await call(`${api.url}${path}`, { headers: bearer() });
        expect(answer.status).toBe(404);
        expect(answer.json()).toMatchObject({ error: { code: 'not_found' } });
      }
    });

    it('validates path params, query and body with the schemas of the route, in the error format', async () => {
      const api = await start();
      let seen: unknown;
      api.handlers.register('getLayout', () => defaultLayout('tui'));
      api.handlers.register('putLayout', (callInfo) => {
        seen = callInfo.body;
        return callInfo.body;
      });
      const badParam = await call(`${api.url}/v1/layout/phone`, { headers: bearer() });
      expect(badParam.status).toBe(400);
      expect(badParam.json()).toMatchObject({
        error: { code: 'invalid_input', details: expect.anything() as unknown },
      });
      const badBody = await call(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1 }),
      });
      expect(badBody.status).toBe(400);
      expect(badBody.json()).toMatchObject({ error: { code: 'invalid_input' } });
      const notJson = await call(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: '{nope',
      });
      expect(notJson.status).toBe(400);
      expect(notJson.json()).toMatchObject({ error: { code: 'invalid_input' } });
      const good = await call(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: JSON.stringify(defaultLayout('tui')),
      });
      expect(good.status).toBe(200);
      expect(seen).toEqual(defaultLayout('tui'));
    });

    it('validates the query, a repeated key arriving as a list', async () => {
      const api = await start();
      let seen: unknown;
      api.handlers.register('streamEvents', (callInfo) => {
        seen = callInfo.query;
        return new Response('ok');
      });
      const bad = await call(`${api.url}/v1/events?since=-1`, { headers: bearer() });
      expect(bad.status).toBe(400);
      expect(bad.json()).toMatchObject({ error: { code: 'invalid_input' } });
      const ok = await call(`${api.url}/v1/events?types=run.started&types=run.ended&scenario=S1`, {
        headers: bearer(),
      });
      expect(ok.status).toBe(200);
      expect(seen).toMatchObject({ types: ['run.started', 'run.ended'], scenario: 'S1' });
    });

    it('answers 413 payload_too_large for a body above max_body_bytes, declared or not', async () => {
      const api = await start({ maxBodyBytes: 64 });
      api.handlers.register('putLayout', (callInfo) => callInfo.body);
      const body = JSON.stringify({ ...defaultLayout('tui'), openTabs: ['x'.repeat(200)] });
      const declared = await call(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: {
          ...bearer(),
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(declared.status).toBe(413);
      expect(declared.json()).toMatchObject({
        error: { code: 'payload_too_large', details: { maxBytes: 64 } },
      });
    });

    it('maps an ApiFailure and an unexpected error to the error format, never leaking the message', async () => {
      const api = await start();
      api.handlers.register('getLayout', () => {
        throw new ApiFailure('not_found', 'No layout like that');
      });
      const failed = await call(`${api.url}/v1/layout/tui`, { headers: bearer() });
      expect(failed.status).toBe(404);
      expect(failed.json()).toEqual({
        error: { code: 'not_found', message: 'No layout like that' },
      });
      api.handlers.register('putLayout', () => {
        throw new Error('secret detail /home/user/x');
      });
      const boom = await call(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: JSON.stringify(defaultLayout('tui')),
      });
      expect(boom.status).toBe(500);
      expect(boom.text).not.toContain('secret detail');
      expect(boom.json()).toMatchObject({ error: { code: 'internal' } });
    });

    it('turns an answer that does not fit the schema of the route into a 500', async () => {
      const api = await start();
      api.handlers.register('getLayout', () => ({ nonsense: true }) as never);
      const answer = await call(`${api.url}/v1/layout/tui`, { headers: bearer() });
      expect(answer.status).toBe(500);
      expect(answer.json()).toMatchObject({ error: { code: 'internal' } });
    });

    it('refuses to register a handler twice or for an unknown route', async () => {
      const api = await start();
      api.handlers.register('getLayout', () => defaultLayout('tui'));
      expect(() => api.handlers.register('getLayout', () => defaultLayout('tui'))).toThrow();
      expect(() =>
        api.handlers.register('noSuchRoute' as never, () => undefined as never),
      ).toThrow();
    });
  });

  describe('the recovery gate', () => {
    it('holds a command route until the gate opens, and answers a read at once', async () => {
      const gate = new RecoveryGate();
      const api = await start({ gate });
      api.handlers.register('getLayout', () => defaultLayout('tui'));
      api.handlers.register('putLayout', (callInfo) => callInfo.body);
      const read = await call(`${api.url}/v1/layout/tui`, { headers: bearer() });
      expect(read.status).toBe(200);

      let answered = false;
      const command = call(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: JSON.stringify(defaultLayout('tui')),
      }).then((answer) => {
        answered = true;
        return answer;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(answered).toBe(false);
      gate.open();
      expect((await command).status).toBe(200);
    });

    it('lets a handler mark itself as command or read against the default', async () => {
      const gate = new RecoveryGate();
      const api = await start({ gate });
      // A GET marked as a command waits; a PUT marked as a read does not.
      api.handlers.register('getLayout', () => defaultLayout('tui'), { command: true });
      api.handlers.register('putLayout', (callInfo) => callInfo.body, { command: false });
      const put = await call(`${api.url}/v1/layout/tui`, {
        method: 'PUT',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: JSON.stringify(defaultLayout('tui')),
      });
      expect(put.status).toBe(200);
      let answered = false;
      const get = call(`${api.url}/v1/layout/tui`, { headers: bearer() }).then((answer) => {
        answered = true;
        return answer;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(answered).toBe(false);
      gate.open();
      expect((await get).status).toBe(200);
    });
  });

  describe('the token rotation', () => {
    it('swaps the token at once, writes it to api-token and runs the listeners', async () => {
      const api = await start();
      let ran = 0;
      const off = api.onTokenRotated(() => {
        ran += 1;
      });
      api.onTokenRotated(() => {
        throw new Error('a bad listener');
      });
      const rotated = await call(`${api.url}/v1/api-token/rotate`, {
        method: 'POST',
        headers: bearer(),
      });
      expect(rotated.status).toBe(200);
      expect(rotated.json()).toEqual({ rotated: true });
      expect(rotated.text).not.toContain(token);
      expect(ran).toBe(1);
      const fresh = await readApiToken(join(dir, 'api-token'));
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(token);
      expect(rotated.text).not.toContain(fresh ?? '');
      // The old token is refused now; the new one works.
      const old = await call(`${api.url}/v1/api-token/rotate`, {
        method: 'POST',
        headers: bearer(),
      });
      expect(old.status).toBe(401);
      const again = await call(`${api.url}/v1/api-token/rotate`, {
        method: 'POST',
        headers: bearer(fresh),
      });
      expect(again.status).toBe(200);
      expect(ran).toBe(2);
      off();
      await api.rotateToken();
      expect(ran).toBe(2);
      if (!WINDOWS) expect((await stat(join(dir, 'api-token'))).mode & 0o777).toBe(0o600);
    });

    it('is not held by the recovery gate', async () => {
      const api = await start({ gate: new RecoveryGate() });
      const rotated = await call(`${api.url}/v1/api-token/rotate`, {
        method: 'POST',
        headers: bearer(),
      });
      expect(rotated.status).toBe(200);
    });
  });

  describe('start and stop', () => {
    it('publishes api.json (mode 0600, no token) and records api.started with the url and no token', async () => {
      const api = await start();
      const reading = await readDiscovery(join(dir, 'api.json'));
      expect(reading).toMatchObject({
        kind: 'live',
        info: { url: api.url, daemonId: DAEMON_ID, pid: process.pid },
      });
      expect(await readFile(join(dir, 'api.json'), 'utf8')).not.toContain(token);
      if (!WINDOWS) expect((await stat(join(dir, 'api.json'))).mode & 0o777).toBe(0o600);
      expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(situations.of('api.started')).toEqual([
        { url: api.url, daemonId: DAEMON_ID, tokenMode: 'persistent' },
      ]);
      expect(JSON.stringify(situations.recorded)).not.toContain(token);
    });

    it('removes api.json on stop, aborts stopSignal and stops listening; stop is idempotent', async () => {
      const api = await start();
      const signal = api.stopSignal;
      expect(signal.aborted).toBe(false);
      await api.stop();
      await api.stop();
      expect(signal.aborted).toBe(true);
      expect((await readDiscovery(join(dir, 'api.json'))).kind).toBe('none');
      await expect(call(`http://127.0.0.1:${String(api.port)}/v1/status`)).rejects.toThrow();
    });

    it('replaces the api.json of a dead daemon', async () => {
      const first = await start();
      // Simulate a crash: the file stays but its pid is gone.
      const dead = JSON.stringify({
        url: 'http://127.0.0.1:9',
        daemonId: DAEMON_ID,
        pid: 2_147_483_000,
        apiVersion: 1,
      });
      await first.stop();
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, 'api.json'), dead);
      expect((await readDiscovery(join(dir, 'api.json'))).kind).toBe('stale');
      const second = await start();
      expect(await readDiscovery(join(dir, 'api.json'))).toMatchObject({
        kind: 'live',
        info: { url: second.url },
      });
    });

    it('fails with AdapterUnavailable when the fixed port is busy', async () => {
      const first = await start();
      await expect(
        start({ port: first.port, discoveryFile: join(dir, 'other.json') }),
      ).rejects.toBeInstanceOf(AdapterUnavailable);
    });

    it('listens on the loopback only: a connection to another interface address is refused', async (context) => {
      const api = await start();
      const external = Object.values(networkInterfaces())
        .flat()
        .find((entry) => entry !== undefined && !entry.internal && entry.family === 'IPv4');
      if (external === undefined) context.skip('this machine has no non-loopback IPv4 address');
      const address = api.httpServer.address();
      expect(address).toMatchObject({ address: '127.0.0.1' });
      const refused = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: external?.address ?? '', port: api.port, timeout: 2000 });
        socket.on('connect', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('error', () => {
          resolve(true);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(true);
        });
      });
      expect(refused).toBe(true);
    });
  });
});
