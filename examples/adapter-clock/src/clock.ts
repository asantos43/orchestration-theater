// SPDX-License-Identifier: MPL-2.0
import { Cancelled, InvalidInput, type Clock } from '@otheater/core';

/** Longest delay a platform timer accepts (2^31-1 ms); a longer wait is split in slices. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The smallest complete `Clock`: wall-clock time and real timers. It is a teaching copy of
 * `SystemClock` (`packages/adapters/clock-system`), with the comments of the contract kept short.
 */
export class ExampleClock implements Clock {
  /** Highest value `now()` has returned, so the clock never goes backwards. */
  #last = 0;

  now(): number {
    this.#last = Math.max(this.#last, Date.now());
    return this.#last;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // A typed error is part of the contract: the caller decides by `code`, never by the message.
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(
        new InvalidInput(`sleep(ms) needs a finite ms >= 0, got ${String(ms)}`),
      );
    }
    if (signal?.aborted === true) return Promise.reject(cancelled(signal));

    return new Promise<void>((resolve, reject) => {
      let remaining = ms;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // Whatever the way out, no timer and no listener may be left behind.
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(cancelled(signal));
      };
      const arm = (): void => {
        const slice = Math.min(remaining, MAX_TIMER_MS);
        remaining -= slice;
        timer = setTimeout(() => {
          if (remaining > 0) {
            arm();
            return;
          }
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, slice);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      arm();
    });
  }
}

function cancelled(signal: AbortSignal | undefined): Cancelled {
  return new Cancelled('sleep cancelled', { cause: signal?.reason });
}
