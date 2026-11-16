// SPDX-License-Identifier: MPL-2.0
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidInput, LOCAL_MODEL_SERVER_PORT_VERSION } from '@otheater/core';
import { describeLocalModelServerConformance, type LocalServerBehavior } from '@otheater/sdk';
import {
  DEFAULT_TIMEOUT_MS,
  LlamaCppConfigSchema,
  LlamaCppServer,
  MAX_BODY_BYTES,
} from './index.js';
import { FakeLlamaServer, type FakeLlamaBehavior } from './testing/fake-llama-server.js';

const SHORT_TIMEOUT_MS = 300;

/** Awaits a promise that must reject and returns the error. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject, but it resolved');
}

/** Runs `body` with the base URL of a server that answers every request with `handler`. */
async function withRawServer(
  handler: RequestListener,
  body: (url: string) => Promise<void>,
): Promise<void> {
  const raw = createServer(handler);
  await new Promise<void>((resolve) => {
    raw.listen(0, '127.0.0.1', resolve);
  });
  try {
    await body(`http://127.0.0.1:${String((raw.address() as AddressInfo).port)}`);
  } finally {
    await new Promise<void>((resolve) => {
      raw.close(() => {
        resolve();
      });
    });
  }
}

/** Checks code and message of a rejection. */
async function expectUnavailable(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await failure(promise);
  expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  expect(error.message).toMatch(message);
}

/** The suite's behaviors, written in what the fake `llama-server` speaks. */
function toFake(behavior: LocalServerBehavior): Partial<FakeLlamaBehavior> {
  switch (behavior.kind) {
    case 'malformed':
      return { fault: 'malformed' };
    case 'hung':
      return { fault: 'hang' };
    case 'serving':
      return {
        health: behavior.health === 'ok' ? 'ready' : 'loading',
        models: behavior.models,
        props:
          behavior.slots === 'unreported'
            ? 'absent'
            : { totalSlots: behavior.slots.count, nCtx: behavior.slots.contextPerSlot },
        slots: behavior.slots === 'unreported' ? 'disabled' : 'absent',
      };
  }
}

/** A URL where nothing listens: bind a port, read it, release it. */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(port)}`;
}

describeLocalModelServerConformance('LlamaCppServer', () => {
  const fakes: FakeLlamaServer[] = [];
  return {
    server: new LlamaCppServer({ timeoutMs: SHORT_TIMEOUT_MS }),
    timeoutMs: SHORT_TIMEOUT_MS,
    serve: async (behavior) => {
      const fake = await FakeLlamaServer.start(toFake(behavior));
      fakes.push(fake);
      return fake.url;
    },
    unreachableUrl: closedPortUrl,
    dispose: async () => {
      await Promise.all(fakes.splice(0).map((fake) => fake.close()));
    },
  };
});

describe('LlamaCppServer', () => {
  const fakes: FakeLlamaServer[] = [];
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  });

  async function start(behavior: Partial<FakeLlamaBehavior> = {}): Promise<FakeLlamaServer> {
    const fake = await FakeLlamaServer.start(behavior);
    fakes.push(fake);
    return fake;
  }

  const server = new LlamaCppServer({ timeoutMs: SHORT_TIMEOUT_MS });

  it('declares the LocalModelServer port at the version of core', () => {
    expect(server.id).toBe('llama-cpp');
    expect(server.implements).toEqual({
      port: 'LocalModelServer',
      range: `^${LOCAL_MODEL_SERVER_PORT_VERSION}`,
    });
  });

  describe('health', () => {
    it('reads "Loading model" from the 503 body', async () => {
      const fake = await start({ health: 'loading' });
      expect(await server.health(fake.url)).toEqual({ status: 'loading', detail: 'Loading model' });
    });

    it('is loading on a bare 503, without the documented body', async () => {
      await withRawServer(
        (_req, res) => {
          res.writeHead(503).end('Service Unavailable');
        },
        async (url) => {
          expect(await server.health(url)).toEqual({ status: 'loading', detail: 'HTTP 503' });
        },
      );
    });

    it('is unreachable on an HTTP error that is not 503, with the status in detail', async () => {
      const fake = await start({ fault: 'error' });
      expect(await server.health(fake.url)).toEqual({ status: 'unreachable', detail: 'HTTP 500' });
    });

    it('does not follow a redirect', async () => {
      const fake = await start({ fault: 'redirect' });
      const health = await server.health(fake.url);
      expect(health.status).toBe('unreachable');
      expect(fake.requests).toEqual(['GET /health']);
    });

    it('keeps a path prefix of the base URL, and ignores a trailing slash and a query', async () => {
      const fake = await start();
      await server.health(`${fake.url}/llama/?x=1`);
      expect(fake.requests).toEqual(['GET /llama/health']);
    });
  });

  describe('URL', () => {
    it.each([
      ['ftp://127.0.0.1:8080', /http: or https:/],
      ['file:///etc/hosts', /http: or https:/],
      ['not a url', /not a valid URL/],
      ['http://user:secret@127.0.0.1:8080', /credentials/],
    ])('refuses %s with INVALID_INPUT, for every call', async (url, message) => {
      for (const call of [server.health(url), server.models(url), server.slots(url)]) {
        const error = await failure(call);
        expect(error).toMatchObject({ code: 'INVALID_INPUT' });
        expect(error.message).toMatch(message);
        expect(error.message).not.toContain('secret');
      }
    });

    it('accepts https: (the connection fails, but the URL is taken)', async () => {
      const url = (await closedPortUrl()).replace('http:', 'https:');
      expect((await server.health(url)).status).toBe('unreachable');
    });
  });

  describe('models', () => {
    it('does not report a context window: n_ctx_train is the training context, not the loaded one', async () => {
      const fake = await start({ models: ['a.gguf'] });
      expect(await server.models(fake.url)).toEqual([{ id: 'a.gguf' }]);
    });

    it('rejects a list whose entry has no id', async () => {
      await withRawServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ object: 'model' }] }));
        },
        async (url) => {
          await expectUnavailable(server.models(url), /unexpected format/);
        },
      );
    });

    it('rejects JSON of another shape and HTTP errors, with the reason in the message', async () => {
      const wrong = await start({ fault: 'wrong-shape' });
      await expectUnavailable(server.models(wrong.url), /unexpected format/);
      const broken = await start({ fault: 'error' });
      await expectUnavailable(server.models(broken.url), /HTTP 500/);
    });

    it('rejects a body over the limit', async () => {
      const fake = await start({ fault: 'huge' });
      await expectUnavailable(server.models(fake.url), new RegExp(String(MAX_BODY_BYTES)));
    });

    it('says "no answer" with the timeout in the message when the server hangs', async () => {
      const fake = await start({ fault: 'hang' });
      await expectUnavailable(server.models(fake.url), /no answer within 300 ms/);
    });
  });

  describe('slots', () => {
    it('takes both numbers from /props, and does not touch /slots', async () => {
      const fake = await start({ props: { totalSlots: 3, nCtx: 8192 } });
      expect(await server.slots(fake.url)).toEqual({ count: 3, contextPerSlot: 8192 });
      expect(fake.requests).toEqual(['GET /props']);
    });

    it('does not divide default_generation_settings.n_ctx: it already is the context of one slot', async () => {
      const fake = await start({ props: { totalSlots: 4, nCtx: 8192 } });
      expect((await server.slots(fake.url)).contextPerSlot).toBe(8192);
    });

    it('completes what /props lacks with /slots', async () => {
      const fake = await start({ props: { totalSlots: 2 }, slots: { count: 2, nCtx: 16_384 } });
      expect(await server.slots(fake.url)).toEqual({ count: 2, contextPerSlot: 16_384 });
      expect(fake.requests).toEqual(['GET /props', 'GET /slots']);
    });

    it('falls back to /slots when the server has no /props (old server)', async () => {
      const fake = await start({ props: 'absent', slots: { count: 2, nCtx: 4096 } });
      expect(await server.slots(fake.url)).toEqual({ count: 2, contextPerSlot: 4096 });
    });

    it('keeps what /props said when /slots is disabled (501)', async () => {
      const fake = await start({ props: { totalSlots: 2 }, slots: 'disabled' });
      expect(await server.slots(fake.url)).toEqual({ count: 2, contextPerSlot: undefined });
    });

    it('says nothing when neither endpoint tells (old server, --no-slots)', async () => {
      const fake = await start({ props: 'absent', slots: 'disabled' });
      expect(await server.slots(fake.url)).toEqual({ count: undefined, contextPerSlot: undefined });
      const older = await start({ props: 'absent', slots: 'absent' });
      expect(await server.slots(older.url)).toEqual({
        count: undefined,
        contextPerSlot: undefined,
      });
    });

    it('rejects a /props that is not a valid object, naming the reason', async () => {
      const fake = await start({ props: { totalSlots: 0, nCtx: 4096 } });
      await expectUnavailable(server.slots(fake.url), /\/props.*unexpected format/);
    });

    it('rejects an HTTP error other than "not supported" instead of reporting nothing', async () => {
      const fake = await start({ fault: 'error' });
      await expectUnavailable(server.slots(fake.url), /HTTP 500/);
    });
  });

  describe('construction', () => {
    it.each([0, -1, 1.5, Number.NaN])('refuses timeoutMs %s with INVALID_INPUT', (timeoutMs) => {
      expect(() => new LlamaCppServer({ timeoutMs })).toThrow(InvalidInput);
    });

    it('config schema: default timeout, and a typo fails', () => {
      expect(LlamaCppConfigSchema.parse({})).toEqual({ timeout_ms: DEFAULT_TIMEOUT_MS });
      expect(LlamaCppConfigSchema.safeParse({ timeout: 10 }).success).toBe(false);
    });
  });
});
