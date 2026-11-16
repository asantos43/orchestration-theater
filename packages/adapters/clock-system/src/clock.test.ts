// SPDX-License-Identifier: MPL-2.0
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cancelled, CLOCK_PORT_VERSION } from '@otheater/core';
import { describeClockConformance } from '@otheater/sdk';
import { MAX_TIMER_MS, SystemClock, SystemClockConfigSchema, systemClockAdapter } from './index.js';

// Real clock, real (short) waits: `advance` simply lets the wall time pass.
describeClockConformance('SystemClock', () => ({
  clock: new SystemClock(),
  advance: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms + 10);
    }),
}));

describe('SystemClock.now()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows the wall clock when it moves forward', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const clock = new SystemClock();
    expect(clock.now()).toBe(1_800_000_000_000);
    vi.setSystemTime(1_800_000_005_000);
    expect(clock.now()).toBe(1_800_000_005_000);
  });

  it('never goes backwards when the wall clock is set back, and resumes once it catches up', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const clock = new SystemClock();
    const before = clock.now();

    vi.setSystemTime(before - 3_600_000); // wall clock stepped back one hour
    expect(clock.now()).toBe(before);
    vi.setSystemTime(before - 1_000);
    expect(clock.now()).toBe(before);

    vi.setSystemTime(before + 250);
    expect(clock.now()).toBe(before + 250);
  });

  it('keeps independent state per instance', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const a = new SystemClock();
    const b = new SystemClock();
    const high = a.now();
    vi.setSystemTime(high - 10_000);
    expect(a.now()).toBe(high);
    expect(b.now()).toBe(high - 10_000);
  });

  it('returns an integer', () => {
    expect(Number.isSafeInteger(new SystemClock().now())).toBe(true);
  });
});

describe('SystemClock.sleep() with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a short sleep arms one timer and clears it when done', async () => {
    const clock = new SystemClock();
    let done = false;
    const sleeping = clock.sleep(1_000).then(() => {
      done = true;
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('splits a wait above 2^31-1 ms in slices and resolves only at the end', async () => {
    const clock = new SystemClock();
    const total = 2 * MAX_TIMER_MS + 5_000;
    let done = false;
    const sleeping = clock.sleep(total).then(() => {
      done = true;
    });
    // Never a single timer longer than the platform limit.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
    expect(done).toBe(false);
    expect(vi.getTimerCount()).toBe(1); // second slice armed
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
    expect(done).toBe(false);
    expect(vi.getTimerCount()).toBe(1); // third slice (5 s) armed
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the sum of the slices equals the requested delay when it is an exact multiple', async () => {
    const clock = new SystemClock();
    let done = false;
    const sleeping = clock.sleep(2 * MAX_TIMER_MS).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2 * MAX_TIMER_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('never asks a platform timer for more than the limit', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const clock = new SystemClock();
    const sleeping = clock.sleep(3 * MAX_TIMER_MS + 7);
    await vi.advanceTimersByTimeAsync(3 * MAX_TIMER_MS + 7);
    await sleeping;
    const delays = spy.mock.calls.map((call) => call[1] ?? 0).filter((d) => d > 0);
    expect(delays.length).toBe(4);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_MS);
    expect(delays.reduce((sum, d) => sum + d, 0)).toBe(3 * MAX_TIMER_MS + 7);
    spy.mockRestore();
  });

  it('aborting during a later slice rejects Cancelled and leaves no timer or listener', async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    const reason = new Error('stop');
    const outcome = clock.sleep(3 * MAX_TIMER_MS, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 10); // now inside the second slice
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);

    const error = await outcome;
    expect(error).toBeInstanceOf(Cancelled);
    expect(error).toMatchObject({ code: 'CANCELLED', cause: reason });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('an already aborted signal arms nothing and adds no listener', async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    controller.abort();
    await expect(clock.sleep(1_000, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes the listener when the sleep finishes normally', async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(500, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    await sleeping;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an invalid ms with INVALID_INPUT and arms nothing', async () => {
    const clock = new SystemClock();
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(clock.sleep(ms)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sleep(0) resolves on the next timer turn', async () => {
    const clock = new SystemClock();
    const sleeping = clock.sleep(0);
    await vi.advanceTimersByTimeAsync(0);
    await expect(sleeping).resolves.toBeUndefined();
  });
});

describe('adapter identity and config', () => {
  it('declares the Clock port with a range that covers the port version', () => {
    expect(systemClockAdapter).toEqual({
      id: 'system',
      implements: { port: 'Clock', range: `^${CLOCK_PORT_VERSION}` },
    });
    expect(systemClockAdapter.implements.range).toBe('^0.1.0');
  });

  it('the config schema accepts {} and rejects unknown keys', () => {
    expect(SystemClockConfigSchema.safeParse({}).success).toBe(true);
    expect(SystemClockConfigSchema.safeParse({ tick: 5 }).success).toBe(false);
  });
});
