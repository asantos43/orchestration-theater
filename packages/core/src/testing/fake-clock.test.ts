// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FAKE_CLOCK_START, FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  it('starts at a fixed instant and only moves on advance()', async () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(FAKE_CLOCK_START);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(clock.now()).toBe(FAKE_CLOCK_START);
    await clock.advance(1500);
    expect(clock.now()).toBe(FAKE_CLOCK_START + 1500);
    expect(new FakeClock(42).now()).toBe(42);
  });

  it('does not resolve a sleep before its time', async () => {
    const clock = new FakeClock();
    let done = false;
    const sleeping = clock.sleep(100).then(() => {
      done = true;
    });
    await clock.advance(99);
    expect(done).toBe(false);
    expect(clock.pendingSleeps).toBe(1);
    await clock.advance(1);
    await sleeping;
    expect(done).toBe(true);
    expect(clock.pendingSleeps).toBe(0);
  });

  it('fires sleeps in due order, ties in call order, with now() at each due time', async () => {
    const clock = new FakeClock(0);
    const fired: [string, number][] = [];
    const track = (name: string, ms: number): Promise<void> =>
      clock.sleep(ms).then(() => {
        fired.push([name, clock.now()]);
      });
    const all = Promise.all([track('c', 30), track('a', 10), track('b1', 20), track('b2', 20)]);
    await clock.advance(100);
    await all;
    expect(fired).toEqual([
      ['a', 10],
      ['b1', 20],
      ['b2', 20],
      ['c', 30],
    ]);
    expect(clock.now()).toBe(100);
  });

  it('a loop that sleeps runs one lap per period inside one advance()', async () => {
    const clock = new FakeClock(0);
    const laps: number[] = [];
    const stop = new AbortController();
    const loop = (async () => {
      for (;;) {
        await clock.sleep(10, stop.signal);
        laps.push(clock.now());
      }
    })().catch(() => undefined);

    await clock.advance(35);
    expect(laps).toEqual([10, 20, 30]);
    stop.abort();
    await loop;
  });

  it('sleep(0) waits for the next advance, even advance(0)', async () => {
    const clock = new FakeClock();
    let done = false;
    const sleeping = clock.sleep(0).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await clock.advance(0);
    await sleeping;
    expect(done).toBe(true);
  });

  it('abort releases the pending sleep and keeps the reason as cause', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const outcome = clock.sleep(1000, controller.signal).catch((e: unknown) => e);
    expect(clock.pendingSleeps).toBe(1);
    controller.abort('why');
    expect(clock.pendingSleeps).toBe(0);
    expect(await outcome).toMatchObject({ code: 'CANCELLED', cause: 'why' });
  });

  it('validates its arguments', async () => {
    const clock = new FakeClock();
    await expect(clock.sleep(-1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(clock.advance(Number.NaN)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(clock.advance(-5)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
