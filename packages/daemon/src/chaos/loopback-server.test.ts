// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { startLoopbackServer, type LoopbackServer } from './loopback-server.js';

const opened: LoopbackServer[] = [];

async function start(...args: Parameters<typeof startLoopbackServer>): Promise<LoopbackServer> {
  const server = await startLoopbackServer(...args);
  opened.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((server) => server.close()));
});

/** Resolves when `condition` holds; each lap yields to the event loop, no window of time decides. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('loopback server', () => {
  it('listens on the loopback with an ephemeral port and answers ok', async () => {
    const server = await start();
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}`);
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`${server.url}/usage`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(server.requests()).toEqual([{ method: 'GET', url: '/usage', outcome: 'ok' }]);
  });

  it('refuse: nothing listens, and the same address comes back with setMode', async () => {
    const server = await start({ mode: 'refuse' });
    await expect(fetch(`${server.url}/`)).rejects.toThrow();
    expect(server.requests()).toHaveLength(0);
    await server.setMode('ok');
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    await server.setMode('refuse');
    await expect(fetch(`${server.url}/`)).rejects.toThrow();
    expect(server.requests()).toHaveLength(1);
  });

  it('503: answers 503, with Retry-After when asked', async () => {
    const server = await start({ mode: '503', retryAfterSeconds: 7 });
    const response = await fetch(`${server.url}/`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('7');
    await response.text();
    const plain = await start({ mode: '503' });
    expect((await fetch(`${plain.url}/`)).headers.get('retry-after')).toBeNull();
  });

  it('cut: the answer ends before its Content-Length', async () => {
    const server = await start({ mode: 'cut' });
    const response = await fetch(`${server.url}/`);
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
    await expect(response.text()).rejects.toThrow();
  });

  it('slow: holds the request until release(), and a client that gives up frees it', async () => {
    const server = await start({ mode: 'slow' });
    const pending = fetch(`${server.url}/`);
    await until(() => server.held() === 1);
    server.release();
    expect(server.held()).toBe(0);
    expect((await pending).status).toBe(200);

    const abort = new AbortController();
    const given = fetch(`${server.url}/`, { signal: abort.signal });
    const outcome = expect(given).rejects.toThrow();
    await until(() => server.held() === 1);
    abort.abort();
    await outcome;
    await until(() => server.held() === 0);
    expect(server.requests().map((request) => request.outcome)).toEqual(['slow', 'slow']);
  });

  it('flap: the n-th request gets the n-th step, whatever the speed', async () => {
    const server = await start({ mode: 'flap', flapPattern: ['503', 'ok', 'cut', 'reset'] });
    expect((await fetch(`${server.url}/`)).status).toBe(503);
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    const cut = await fetch(`${server.url}/`);
    await expect(cut.text()).rejects.toThrow();
    await expect(fetch(`${server.url}/`)).rejects.toThrow();
    // The cycle starts again.
    expect((await fetch(`${server.url}/`)).status).toBe(503);
    expect(server.requests().map((request) => request.outcome)).toEqual([
      '503',
      'ok',
      'cut',
      'reset',
      '503',
    ]);
  });

  it('flap: the default pattern is reset, 503, ok', async () => {
    const server = await start({ mode: 'flap' });
    await expect(fetch(`${server.url}/`)).rejects.toThrow();
    expect((await fetch(`${server.url}/`)).status).toBe(503);
    expect((await fetch(`${server.url}/`)).status).toBe(200);
  });

  it('rejects an empty flap pattern, and closes twice without failing', async () => {
    await expect(startLoopbackServer({ flapPattern: [] })).rejects.toThrow(/at least one step/);
    const server = await start();
    await server.close();
    await server.close();
    await expect(server.setMode('ok')).rejects.toThrow(/closed/);
  });
});
