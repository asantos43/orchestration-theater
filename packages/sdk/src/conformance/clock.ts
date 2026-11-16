// SPDX-License-Identifier: MPL-2.0
import { CLOCK_PORT_VERSION, type Clock } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

export interface ClockHarness extends Disposable {
  readonly clock: Clock;
  /**
   * Makes at least `ms` of the clock's time pass and lets the sleeps that fall due settle.
   * A fake clock moves its time; a real clock simply waits (keep `ms` small, tens of ms).
   */
  readonly advance: (ms: number) => Promise<void>;
}

/**
 * Registers the `Clock` conformance tests (port version {@link CLOCK_PORT_VERSION}) in the
 * calling Vitest file. Call it at the top level of a test file, once per adapter.
 */
export function describeClockConformance(
  name: string,
  factory: AdapterFactory<ClockHarness>,
): void {
  describe(`Clock conformance: ${name} (port ${CLOCK_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    it('now() returns an integer number of epoch milliseconds', () => {
      const now = harness().clock.now();
      expect(Number.isSafeInteger(now)).toBe(true);
      expect(now).toBeGreaterThan(0);
    });

    it('now() never goes backwards', async () => {
      const { clock, advance } = harness();
      const first = clock.now();
      await advance(10);
      const second = clock.now();
      await advance(10);
      expect(second).toBeGreaterThanOrEqual(first);
      expect(clock.now()).toBeGreaterThanOrEqual(second);
    });

    it('sleep(ms) resolves once the time has passed', async () => {
      const { clock, advance } = harness();
      const sleeping = clock.sleep(20);
      await advance(20);
      await expect(sleeping).resolves.toBeUndefined();
    });

    it('sleep(0) resolves', async () => {
      const { clock, advance } = harness();
      const sleeping = clock.sleep(0);
      await advance(0);
      await expect(sleeping).resolves.toBeUndefined();
    });

    it('several sleeps are independent and all resolve', async () => {
      const { clock, advance } = harness();
      const all = Promise.all([clock.sleep(5), clock.sleep(15), clock.sleep(10)]);
      await advance(15);
      await expect(all).resolves.toHaveLength(3);
    });

    it('rejects an invalid ms with INVALID_INPUT', async () => {
      const { clock } = harness();
      for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(await rejectionOf(clock.sleep(ms))).toMatchObject({ code: 'INVALID_INPUT' });
      }
    });

    it('rejects with CANCELLED when the signal is already aborted', async () => {
      const { clock } = harness();
      const controller = new AbortController();
      controller.abort(new Error('stop'));
      const error = await rejectionOf(clock.sleep(20, controller.signal));
      expect(error).toMatchObject({ code: 'CANCELLED' });
      expect(error).toHaveProperty('cause', controller.signal.reason);
    });

    it('rejects with CANCELLED when the signal aborts during the wait', async () => {
      const { clock } = harness();
      const controller = new AbortController();
      const sleeping = clock.sleep(10_000, controller.signal);
      controller.abort();
      expect(await rejectionOf(sleeping)).toMatchObject({ code: 'CANCELLED' });
    });

    it('a cancelled sleep stays cancelled when its time comes', async () => {
      const { clock, advance } = harness();
      const controller = new AbortController();
      // Observe the rejection right away: it happens before `advance` returns.
      const outcome = rejectionOf(clock.sleep(20, controller.signal));
      controller.abort();
      await advance(20);
      expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    });

    it('aborting after the sleep resolved is harmless', async () => {
      const { clock, advance } = harness();
      const controller = new AbortController();
      const sleeping = clock.sleep(10, controller.signal);
      await advance(10);
      await sleeping;
      expect(() => {
        controller.abort();
      }).not.toThrow();
    });
  });
}
