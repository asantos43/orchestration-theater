// SPDX-License-Identifier: MPL-2.0
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../handlers.js';
import { canonicalJson, IdempotencyCache, type IdempotentRequest } from './idempotency.js';

const HOUR = 3_600_000;

function request(over: Partial<IdempotentRequest> = {}): IdempotentRequest {
  return {
    key: 'key-1',
    routeId: 'createOrder',
    params: {},
    query: {},
    body: { text: 'a' },
    ...over,
  };
}

function setup(ttlMs = 24 * HOUR): {
  cache: IdempotencyCache;
  clock: FakeClock;
  runs: () => number;
  run: (r?: IdempotentRequest) => ReturnType<IdempotencyCache['run']>;
} {
  const clock = new FakeClock();
  const cache = new IdempotencyCache({ clock, ttlMs: () => ttlMs });
  let runs = 0;
  return {
    cache,
    clock,
    runs: () => runs,
    run: (r = request()) =>
      cache.run(r, () => {
        runs += 1;
        return Promise.resolve({ run: runs });
      }),
  };
}

describe('canonicalJson', () => {
  it('gives one text to two spellings of one body', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { x: 2, y: 1 }] }, b: 1 }),
    );
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('IdempotencyCache', () => {
  it('runs once and answers a repeat with the first answer', async () => {
    const { run, runs } = setup();
    const first = await run();
    const again = await run();
    expect(first).toEqual({ replayed: false, value: { run: 1 } });
    expect(again).toEqual({ replayed: true, value: { run: 1 } });
    expect(runs()).toBe(1);
  });

  it('answers 409 conflict for the same key with another body, route, param or query', async () => {
    const { run, runs } = setup();
    await run();
    for (const other of [
      request({ body: { text: 'b' } }),
      request({ routeId: 'revokeOrder' }),
      request({ params: { orderId: 'x' } }),
      request({ query: { timeoutMs: 1 } }),
    ]) {
      const failure = await run(other).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiFailure);
      expect((failure as ApiFailure).code).toBe('conflict');
    }
    expect(runs()).toBe(1);
  });

  it('takes two spellings of one body as one request', async () => {
    const { run, runs } = setup();
    await run(request({ body: { a: 1, b: 2 } }));
    const again = await run(request({ body: { b: 2, a: 1 } }));
    expect(again.replayed).toBe(true);
    expect(runs()).toBe(1);
  });

  it('keeps keys apart', async () => {
    const { run, runs } = setup();
    await run(request({ key: 'a' }));
    await run(request({ key: 'b' }));
    expect(runs()).toBe(2);
  });

  it('runs a command once when two sends arrive at once', async () => {
    const { cache } = setup();
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = async (): Promise<{ n: number }> => {
      runs += 1;
      await gate;
      return { n: runs };
    };
    const first = cache.run(request(), execute);
    const second = cache.run(request(), execute);
    release();
    expect(await first).toEqual({ replayed: false, value: { n: 1 } });
    expect(await second).toEqual({ replayed: true, value: { n: 1 } });
    expect(runs).toBe(1);
  });

  it('does not keep a failure: the repeat tries again', async () => {
    const { cache } = setup();
    let runs = 0;
    const execute = (): Promise<{ n: number }> => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ n: runs });
    };
    await expect(cache.run(request(), execute)).rejects.toThrow('boom');
    expect(await cache.run(request(), execute)).toEqual({ replayed: false, value: { n: 2 } });
    expect(cache.size).toBe(1);
  });

  it('forgets an answer after the ttl, by the clock', async () => {
    const { run, runs, clock, cache } = setup(HOUR);
    await run();
    await clock.advance(HOUR - 1);
    expect((await run()).replayed).toBe(true);
    await clock.advance(1);
    expect((await run()).replayed).toBe(false);
    expect(runs()).toBe(2);
    // A key that is not used again is swept as the cache is used.
    await run(request({ key: 'other' }));
    await clock.advance(2 * HOUR);
    await run(request({ key: 'third' }));
    expect(cache.size).toBe(1);
  });

  it('keeps nothing when the ttl is 0', async () => {
    const { run, runs, cache } = setup(0);
    await run();
    await run();
    expect(runs()).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('holds at most api.idempotency_max_entries answers: the oldest go first, and a run that is going is never dropped', async () => {
    const clock = new FakeClock();
    let max = 3;
    const cache = new IdempotencyCache({ clock, ttlMs: () => 24 * HOUR, maxEntries: () => max });
    let runs = 0;
    const run = (key: string) =>
      cache.run(request({ key }), () => {
        runs += 1;
        return Promise.resolve({ run: runs });
      });
    for (const key of ['a', 'b', 'c', 'd', 'e']) await run(key);
    expect(cache.size).toBeLessThanOrEqual(3);
    // 'a' was the oldest and went: it runs again; 'e' is the newest and is still replayed.
    expect((await run('e')).replayed).toBe(true);
    expect((await run('a')).replayed).toBe(false);
    // A cap that is lowered at run time (the getter) applies to the next call.
    max = 1;
    await run('z');
    expect(cache.size).toBeLessThanOrEqual(1);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = cache.run(request({ key: 'slow' }), async () => {
      await gate;
      return { slow: true };
    });
    await run('after-slow');
    release?.();
    expect((await slow).replayed).toBe(false);
  });
});
