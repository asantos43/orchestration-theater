// SPDX-License-Identifier: MPL-2.0
import type { Clock } from './connection.js';

/**
 * A clock that never waits (N57: the tests of the reconnection must not sleep). It records every
 * delay it was asked for, and answers at once, after one turn of the microtask queue.
 */
export interface TestClock extends Clock {
  /** The delays asked for, in order. */
  readonly sleeps: number[];
}

export function createTestClock(): TestClock {
  const sleeps: number[] = [];
  return {
    sleeps,
    async sleep(ms, signal) {
      sleeps.push(ms);
      if (signal?.aborted === true) return;
      await Promise.resolve();
    },
  };
}

/** Polls until `check` is true. Loopback and microtasks only, so it is fast; it fails after `timeoutMs`. */
export async function waitFor(
  check: () => boolean,
  what = 'the condition',
  timeoutMs = 5000,
): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > limit) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}
