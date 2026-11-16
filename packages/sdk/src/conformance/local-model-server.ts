// SPDX-License-Identifier: MPL-2.0
import { LOCAL_MODEL_SERVER_PORT_VERSION, type LocalModelServer } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

/**
 * How the server behind a URL behaves, as the suite asks for it. The harness turns each kind into
 * whatever the adapter's server speaks (a fake `llama-server` over HTTP, a scripted double...).
 */
export type LocalServerBehavior =
  | {
      readonly kind: 'serving';
      /** `ok`: ready to answer. `loading`: up, but the model is still being loaded. */
      readonly health: 'ok' | 'loading';
      /** Ids of the models it lists. */
      readonly models: readonly string[];
      /** What it says about its slots; `unreported` is a server that does not say (old, or disabled). */
      readonly slots: { readonly count: number; readonly contextPerSlot: number } | 'unreported';
    }
  /** Answers every call with something that is not what this kind of server speaks. */
  | { readonly kind: 'malformed' }
  /** Accepts the connection and never answers. */
  | { readonly kind: 'hung' };

export interface LocalModelServerHarness extends Disposable {
  /** The adapter under test, configured with the `timeoutMs` below. */
  readonly server: LocalModelServer;
  /** Starts a server with that behavior and returns its base URL. `dispose` stops them all. */
  readonly serve: (behavior: LocalServerBehavior) => Promise<string>;
  /** A base URL where nothing listens (the connection is refused). */
  readonly unreachableUrl: () => Promise<string>;
  /** The longest the adapter waits for one answer, in ms; keep it short (a few hundred). */
  readonly timeoutMs: number;
}

/** Slack over `timeoutMs` for a call to give up, in ms: scheduling noise on a busy machine. */
const TIMEOUT_SLACK_MS = 3000;
/** Vitest time limit of the tests that wait for a timeout. */
const SLOW_TEST_MS = 15_000;

const READY: Extract<LocalServerBehavior, { kind: 'serving' }> = {
  kind: 'serving',
  health: 'ok',
  models: ['model-a.gguf'],
  slots: { count: 2, contextPerSlot: 8192 },
};

/**
 * Registers the `LocalModelServer` conformance tests (port version
 * {@link LOCAL_MODEL_SERVER_PORT_VERSION}) in the calling Vitest file. Call it at the top level of
 * a test file, once per adapter.
 */
export function describeLocalModelServerConformance(
  name: string,
  factory: AdapterFactory<LocalModelServerHarness>,
): void {
  describe(`LocalModelServer conformance: ${name} (port ${LOCAL_MODEL_SERVER_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    /** Runs `call` and checks that it settled within the adapter's timeout plus the slack. */
    async function settlesInTime<T>(call: () => Promise<T>): Promise<{ result: T; ms: number }> {
      const started = performance.now();
      const result = await call();
      return { result, ms: performance.now() - started };
    }

    it('declares the port and a contract range that covers this version', () => {
      const { server } = harness();
      expect(server.id.length).toBeGreaterThan(0);
      expect(server.implements.port).toBe('LocalModelServer');
      expect(server.implements.range.length).toBeGreaterThan(0);
    });

    describe('health', () => {
      it('is ok when the server is ready', async () => {
        const { server, serve } = harness();
        expect((await server.health(await serve(READY))).status).toBe('ok');
      });

      it('is loading while the model is being loaded', async () => {
        const { server, serve } = harness();
        const url = await serve({ ...READY, health: 'loading' });
        expect((await server.health(url)).status).toBe('loading');
      });

      it('is unreachable, and does not reject, when nothing listens', async () => {
        const { server, unreachableUrl } = harness();
        const health = await server.health(await unreachableUrl());
        expect(health.status).toBe('unreachable');
      });

      it(
        'is unreachable, and does not reject, when the server never answers',
        async () => {
          const { server, serve, timeoutMs } = harness();
          const url = await serve({ kind: 'hung' });
          const { result, ms } = await settlesInTime(() => server.health(url));
          expect(result.status).toBe('unreachable');
          expect(ms).toBeLessThan(timeoutMs + TIMEOUT_SLACK_MS);
        },
        SLOW_TEST_MS,
      );

      it('does not say ok to an answer that is not from this kind of server', async () => {
        const { server, serve } = harness();
        const health = await server.health(await serve({ kind: 'malformed' }));
        expect(health.status).not.toBe('ok');
      });

      it('carries the reason in detail when it is not ok', async () => {
        const { server, unreachableUrl } = harness();
        const health = await server.health(await unreachableUrl());
        expect(typeof health.detail).toBe('string');
      });
    });

    describe('models', () => {
      it('lists the ids the server lists, in order', async () => {
        const { server, serve } = harness();
        const url = await serve({ ...READY, models: ['b.gguf', 'a.gguf'] });
        expect((await server.models(url)).map((model) => model.id)).toEqual(['b.gguf', 'a.gguf']);
      });

      it('lists nothing when the server has no model', async () => {
        const { server, serve } = harness();
        const url = await serve({ ...READY, models: [] });
        expect(await server.models(url)).toEqual([]);
      });

      it('rejects with ADAPTER_UNAVAILABLE when nothing listens', async () => {
        const { server, unreachableUrl } = harness();
        const error = await rejectionOf(server.models(await unreachableUrl()));
        expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      });

      it(
        'rejects with ADAPTER_UNAVAILABLE when the server never answers',
        async () => {
          const { server, serve, timeoutMs } = harness();
          const url = await serve({ kind: 'hung' });
          const { result, ms } = await settlesInTime(() => rejectionOf(server.models(url)));
          expect(result).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
          expect(ms).toBeLessThan(timeoutMs + TIMEOUT_SLACK_MS);
        },
        SLOW_TEST_MS,
      );

      it('rejects with ADAPTER_UNAVAILABLE when the answer is not understood', async () => {
        const { server, serve } = harness();
        const error = await rejectionOf(server.models(await serve({ kind: 'malformed' })));
        expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      });
    });

    describe('slots', () => {
      it('gives the count and the context of one slot when the server says them', async () => {
        const { server, serve } = harness();
        const url = await serve({
          ...READY,
          slots: { count: 4, contextPerSlot: 16_384 },
        });
        expect(await server.slots(url)).toEqual({ count: 4, contextPerSlot: 16_384 });
      });

      it('gives undefined for both when the server does not say', async () => {
        const { server, serve } = harness();
        const url = await serve({ ...READY, slots: 'unreported' });
        expect(await server.slots(url)).toEqual({ count: undefined, contextPerSlot: undefined });
      });

      it('rejects with ADAPTER_UNAVAILABLE when nothing listens', async () => {
        const { server, unreachableUrl } = harness();
        const error = await rejectionOf(server.slots(await unreachableUrl()));
        expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      });

      it(
        'rejects with ADAPTER_UNAVAILABLE when the server never answers',
        async () => {
          const { server, serve, timeoutMs } = harness();
          const url = await serve({ kind: 'hung' });
          const { result, ms } = await settlesInTime(() => rejectionOf(server.slots(url)));
          expect(result).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
          expect(ms).toBeLessThan(timeoutMs + TIMEOUT_SLACK_MS);
        },
        SLOW_TEST_MS,
      );

      it('rejects with ADAPTER_UNAVAILABLE when the answer is not understood', async () => {
        const { server, serve } = harness();
        const error = await rejectionOf(server.slots(await serve({ kind: 'malformed' })));
        expect(error).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      });
    });
  });
}
