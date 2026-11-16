// SPDX-License-Identifier: MPL-2.0
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidInput, LOCAL_MODEL_SERVER_PORT_VERSION } from '@otheater/core';
import { describeLocalModelServerConformance, type LocalServerBehavior } from '@otheater/sdk';
import {
  createOllamaServer,
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  OllamaConfigSchema,
  OllamaServer,
  type OllamaServerOptions,
} from './index.js';
import { FakeOllamaServer, type FakeOllamaBehavior } from './testing/fake-ollama-server.js';

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

describeLocalModelServerConformance('OllamaServer', () => {
  const fakes: FakeOllamaServer[] = [];
  /** `OLLAMA_NUM_PARALLEL` the suite "configures" for each instance it starts. */
  const parallelOf = new Map<string, number>();
  return {
    server: new OllamaServer({
      timeoutMs: SHORT_TIMEOUT_MS,
      parallel: (url) => parallelOf.get(url),
    }),
    timeoutMs: SHORT_TIMEOUT_MS,
    serve: async (behavior: LocalServerBehavior) => {
      let fake: FakeOllamaServer;
      switch (behavior.kind) {
        case 'malformed':
          fake = await FakeOllamaServer.start({ fault: 'malformed' });
          break;
        case 'hung':
          fake = await FakeOllamaServer.start({ fault: 'hang' });
          break;
        case 'serving': {
          // Ollama does not say its slots: the user does (`parallel`), and the loaded model's
          // `context_length` is the total (`context_mode: total`), so it is count x per slot.
          const slots = behavior.slots;
          fake = await FakeOllamaServer.start({
            health: behavior.health === 'ok' ? 'ready' : 'loading',
            installed: behavior.models,
            loaded:
              slots === 'unreported'
                ? []
                : [{ name: 'loaded:latest', contextLength: slots.count * slots.contextPerSlot }],
          });
          if (slots !== 'unreported') parallelOf.set(fake.url, slots.count);
        }
      }
      fakes.push(fake);
      return fake.url;
    },
    unreachableUrl: closedPortUrl,
    dispose: async () => {
      parallelOf.clear();
      await Promise.all(fakes.splice(0).map((fake) => fake.close()));
    },
  };
});

describe('OllamaServer', () => {
  const fakes: FakeOllamaServer[] = [];
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  });

  async function start(behavior: Partial<FakeOllamaBehavior> = {}): Promise<FakeOllamaServer> {
    const fake = await FakeOllamaServer.start(behavior);
    fakes.push(fake);
    return fake;
  }

  function make(options: OllamaServerOptions = {}): OllamaServer {
    return new OllamaServer({ timeoutMs: SHORT_TIMEOUT_MS, ...options });
  }

  const server = make();

  it('declares the LocalModelServer port at the version of core', () => {
    expect(server.id).toBe('ollama');
    expect(server.implements).toEqual({
      port: 'LocalModelServer',
      range: `^${LOCAL_MODEL_SERVER_PORT_VERSION}`,
    });
  });

  describe('health', () => {
    it('reads /api/version by default, and says nothing else', async () => {
      const fake = await start();
      expect(await server.health(fake.url)).toEqual({ status: 'ok' });
      expect(fake.requests).toEqual(['GET /api/version']);
    });

    it('is loading on a 503, with the status in detail', async () => {
      const fake = await start({ health: 'loading' });
      expect(await server.health(fake.url)).toEqual({ status: 'loading', detail: 'HTTP 503' });
    });

    it('is unreachable on an HTTP error that is not 503, with the status in detail', async () => {
      const fake = await start({ fault: 'error' });
      expect(await server.health(fake.url)).toEqual({ status: 'unreachable', detail: 'HTTP 500' });
    });

    it('is unreachable on a 200 that is not the version document', async () => {
      const fake = await start({ fault: 'wrong-shape' });
      const health = await server.health(fake.url);
      expect(health.status).toBe('unreachable');
      expect(health.detail).toMatch(/unexpected format/);
    });

    it('does not follow a redirect', async () => {
      const fake = await start({ fault: 'redirect' });
      expect((await server.health(fake.url)).status).toBe('unreachable');
      expect(fake.requests).toEqual(['GET /api/version']);
    });

    it('keeps a path prefix of the base URL, and ignores a trailing slash and a query', async () => {
      const fake = await start();
      await server.health(`${fake.url}/ollama/?x=1`);
      expect(fake.requests).toEqual(['GET /ollama/api/version']);
    });

    it('health_probe root reads the banner of GET /', async () => {
      const fake = await start();
      expect(await make({ healthProbe: 'root' }).health(fake.url)).toEqual({ status: 'ok' });
      expect(fake.requests).toEqual(['GET /']);
      await withRawServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('something else');
        },
        async (url) => {
          const health = await make({ healthProbe: 'root' }).health(url);
          expect(health).toMatchObject({ status: 'unreachable' });
          expect(health.detail).toMatch(/banner/);
        },
      );
    });

    it('health_probe tags reads /api/tags', async () => {
      const fake = await start();
      expect((await make({ healthProbe: 'tags' }).health(fake.url)).status).toBe('ok');
      expect(fake.requests).toEqual(['GET /api/tags']);
    });
  });

  describe('URL', () => {
    it.each([
      ['ftp://127.0.0.1:11434', /http: or https:/],
      ['file:///etc/hosts', /http: or https:/],
      ['not a url', /not a valid URL/],
      ['http://user:secret@127.0.0.1:11434', /credentials/],
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
    it('lists the installed models of /api/tags, with the names as ids', async () => {
      const fake = await start({ installed: ['a:latest', 'b:7b'] });
      expect(await server.models(fake.url)).toEqual([{ id: 'a:latest' }, { id: 'b:7b' }]);
      expect(fake.requests).toEqual(['GET /api/tags', 'GET /api/ps']);
    });

    it('gives contextWindow only to the installed model that is loaded', async () => {
      const fake = await start({
        installed: ['a:latest', 'b:7b'],
        loaded: [{ name: 'b:7b', contextLength: 32_768 }],
      });
      expect(await server.models(fake.url)).toEqual([
        { id: 'a:latest' },
        { id: 'b:7b', contextWindow: 32_768 },
      ]);
    });

    it('leaves contextWindow out when a loaded model has no usable context_length', async () => {
      const fake = await start({
        installed: ['a:latest', 'b:7b'],
        loaded: [{ name: 'a:latest' }, { name: 'b:7b', contextLength: 0 }],
      });
      expect(await server.models(fake.url)).toEqual([{ id: 'a:latest' }, { id: 'b:7b' }]);
    });

    it('context_window none does not ask /api/ps at all', async () => {
      const fake = await start({
        installed: ['a:latest'],
        loaded: [{ name: 'a:latest', contextLength: 4096 }],
      });
      expect(await make({ contextWindow: 'none' }).models(fake.url)).toEqual([{ id: 'a:latest' }]);
      expect(fake.requests).toEqual(['GET /api/tags']);
    });

    it('still lists the installed models when the server has no /api/ps', async () => {
      const fake = await start({ installed: ['a:latest'], loaded: 'absent' });
      expect(await server.models(fake.url)).toEqual([{ id: 'a:latest' }]);
    });

    it('models_source loaded lists what /api/ps lists, and does not read /api/tags', async () => {
      const fake = await start({
        installed: ['a:latest', 'b:7b'],
        loaded: [{ name: 'b:7b', contextLength: 8192 }],
      });
      expect(await make({ modelsSource: 'loaded' }).models(fake.url)).toEqual([
        { id: 'b:7b', contextWindow: 8192 },
      ]);
      expect(fake.requests).toEqual(['GET /api/ps']);
    });

    it('models_source loaded lists nothing when the server has no /api/ps', async () => {
      const fake = await start({ loaded: 'absent' });
      expect(await make({ modelsSource: 'loaded' }).models(fake.url)).toEqual([]);
    });

    it('rejects JSON of another shape and HTTP errors, with the reason in the message', async () => {
      const wrong = await start({ fault: 'wrong-shape' });
      await expectUnavailable(server.models(wrong.url), /unexpected format/);
      const broken = await start({ fault: 'error' });
      await expectUnavailable(server.models(broken.url), /HTTP 500/);
    });

    it('rejects an /api/tags entry without a name', async () => {
      await withRawServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ models: [{ size: 1 }] }));
        },
        async (url) => {
          await expectUnavailable(server.models(url), /\/api\/tags.*unexpected format/);
        },
      );
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
    const loaded = [{ name: 'a:latest', contextLength: 32_768 }];

    it('has no count without parallel, and takes the context from /api/ps as it is', async () => {
      const fake = await start({ loaded });
      expect(await server.slots(fake.url)).toEqual({ count: undefined, contextPerSlot: 32_768 });
      expect(fake.requests).toEqual(['GET /api/ps']);
    });

    it('count is the configured parallel, and the total context is divided by it', async () => {
      const fake = await start({ loaded });
      expect(await make({ parallel: 4 }).slots(fake.url)).toEqual({
        count: 4,
        contextPerSlot: 8192,
      });
    });

    it('context_mode per_slot does not divide', async () => {
      const fake = await start({ loaded });
      expect(await make({ parallel: 4, contextMode: 'per_slot' }).slots(fake.url)).toEqual({
        count: 4,
        contextPerSlot: 32_768,
      });
    });

    it('parallel can depend on the URL', async () => {
      const a = await start({ loaded });
      const b = await start({ loaded });
      const many = make({ parallel: (url) => (url === a.url ? 2 : undefined) });
      expect((await many.slots(a.url)).count).toBe(2);
      expect((await many.slots(b.url)).count).toBeUndefined();
    });

    it('takes the smallest context among the loaded models', async () => {
      const fake = await start({
        loaded: [
          { name: 'a:latest', contextLength: 32_768 },
          { name: 'b:7b', contextLength: 4096 },
          { name: 'c:1b' },
        ],
      });
      expect((await server.slots(fake.url)).contextPerSlot).toBe(4096);
    });

    it('says nothing about the context with no model loaded, or no context_length', async () => {
      const none = await start({ loaded: [] });
      expect(await make({ parallel: 2 }).slots(none.url)).toEqual({
        count: 2,
        contextPerSlot: undefined,
      });
      const old = await start({ loaded: [{ name: 'a:latest' }] });
      expect((await server.slots(old.url)).contextPerSlot).toBeUndefined();
    });

    it('says nothing about the context when the division would give less than 1 token', async () => {
      const fake = await start({ loaded: [{ name: 'a:latest', contextLength: 3 }] });
      expect((await make({ parallel: 4 }).slots(fake.url)).contextPerSlot).toBeUndefined();
    });

    it('keeps the configured count when the server has no /api/ps', async () => {
      const fake = await start({ loaded: 'absent' });
      expect(await make({ parallel: 3 }).slots(fake.url)).toEqual({
        count: 3,
        contextPerSlot: undefined,
      });
    });

    it('rejects an HTTP error other than "not supported" instead of reporting nothing', async () => {
      const fake = await start({ fault: 'error' });
      await expectUnavailable(server.slots(fake.url), /HTTP 500/);
    });

    it('rejects a resolver that gives something that is not a positive integer', async () => {
      const fake = await start({ loaded });
      const error = await failure(make({ parallel: () => 0 }).slots(fake.url));
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('construction', () => {
    it.each([0, -1, 1.5, Number.NaN])('refuses timeoutMs %s with INVALID_INPUT', (timeoutMs) => {
      expect(() => new OllamaServer({ timeoutMs })).toThrow(InvalidInput);
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses parallel %s with INVALID_INPUT', (parallel) => {
      expect(() => new OllamaServer({ parallel })).toThrow(InvalidInput);
    });
  });

  describe('config', () => {
    it('has a default for every key, and a typo fails', () => {
      expect(OllamaConfigSchema.parse({})).toEqual({
        timeout_ms: DEFAULT_TIMEOUT_MS,
        health_probe: 'version',
        models_source: 'installed',
        context_window: 'loaded',
        context_mode: 'total',
        parallel_by_url: {},
      });
      expect(OllamaConfigSchema.safeParse({ timeout: 10 }).success).toBe(false);
      expect(OllamaConfigSchema.safeParse({ health_probe: 'ping' }).success).toBe(false);
      expect(OllamaConfigSchema.safeParse({ parallel: 0 }).success).toBe(false);
      expect(OllamaConfigSchema.safeParse({ parallel_by_url: { nope: 2 } }).success).toBe(false);
    });

    it('createOllamaServer applies parallel_by_url over parallel, by base URL', async () => {
      const fake = await start({ loaded: [{ name: 'a:latest', contextLength: 16_384 }] });
      const config = OllamaConfigSchema.parse({
        timeout_ms: SHORT_TIMEOUT_MS,
        parallel: 2,
        parallel_by_url: { [`${fake.url}/`]: 4 },
      });
      const built = createOllamaServer(config);
      expect(await built.slots(fake.url)).toEqual({ count: 4, contextPerSlot: 4096 });
      const other = await start({ loaded: [{ name: 'a:latest', contextLength: 16_384 }] });
      expect(await built.slots(other.url)).toEqual({ count: 2, contextPerSlot: 8192 });
    });

    it('createOllamaServer applies the options of the config', async () => {
      const fake = await start({
        installed: ['a:latest'],
        loaded: [{ name: 'a:latest', contextLength: 4096 }],
      });
      const built = createOllamaServer(
        OllamaConfigSchema.parse({
          timeout_ms: SHORT_TIMEOUT_MS,
          health_probe: 'root',
          models_source: 'loaded',
          context_window: 'none',
        }),
      );
      expect((await built.health(fake.url)).status).toBe('ok');
      expect(await built.models(fake.url)).toEqual([{ id: 'a:latest' }]);
      expect(fake.requests).toEqual(['GET /', 'GET /api/ps']);
    });
  });
});
