// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../connection.js';

/**
 * A clock the test winds by hand (N57: no real wait): `sleep` stays pending until `advance` takes
 * the time past it, or until its signal aborts. `pending` is how many sleeps wait.
 */
export class ManualClock implements Clock {
  #now = 0;
  readonly #sleeps = new Set<{ readonly due: number; readonly wake: () => void }>();
  /** Every delay asked for, in order. */
  readonly asked: number[] = [];

  get pending(): number {
    return this.#sleeps.size;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.asked.push(ms);
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const entry = {
        due: this.#now + ms,
        wake: (): void => {
          this.#sleeps.delete(entry);
          signal?.removeEventListener('abort', entry.wake);
          resolve();
        },
      };
      this.#sleeps.add(entry);
      signal?.addEventListener('abort', entry.wake, { once: true });
    });
  }

  /** Moves the time forward and wakes what is due, then lets the microtasks run. */
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    for (const entry of [...this.#sleeps]) if (entry.due <= this.#now) entry.wake();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }
}
