// SPDX-License-Identifier: MPL-2.0
import { Cancelled, InvalidInput, type Clock } from '@otheater/core';

/**
 * Longest delay a platform timer accepts: 2^31-1 ms (about 24.8 days). Node warns and runs a
 * longer `setTimeout` after 1 ms, so longer waits are split into slices of at most this length.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The `Clock` of the running system: wall-clock time and real timers. Timers are I/O, so this
 * lives in an adapter and not in core, which holds only pure logic.
 */
export class SystemClock implements Clock {
  /** Highest value `now()` has returned so far. */
  #last = 0;

  /**
   * Epoch milliseconds, never lower than a previous result of this instance.
   *
   * [proposta] `max(last, Date.now())`. `Date.now()` follows the wall clock, which an NTP step,
   * a manual change or a VM resume can move backwards, and the `Clock` contract forbids that
   * (directive validity and schedules compare two `now()` readings). Holding the last value
   * freezes `now()` until the wall clock catches up, so it stays an honest epoch time once the
   * adjustment is over. The alternatives are worse: `performance.now()` anchored at start-up
   * never goes back but also never follows a legitimate correction (the clock would drift from
   * the real date for as long as the daemon runs), and a running offset would keep `now()`
   * ahead of the real date forever after one backward step. `sleep` does not depend on
   * `now()`: it uses platform timers, which are monotonic, so a freeze delays nothing.
   */
  now(): number {
    const wall = Date.now();
    if (wall > this.#last) this.#last = wall;
    return this.#last;
  }

  /**
   * Waits `ms` (finite, >= 0) of real time. Delays above {@link MAX_TIMER_MS} are split in
   * slices, one timer at a time. An abort (before or during) rejects with `Cancelled` and
   * `cause = signal.reason`; on every exit the timer is cleared and the listener removed.
   *
   * [proposta] no `unref()` on the timer: a pending sleep keeps the process alive, as a plain
   * `setTimeout` would. The daemon decides how to stop; a silently dropped quota wait would be
   * worse than a process that waits.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(
        new InvalidInput(`sleep(ms) needs a finite ms >= 0, got ${String(ms)}`),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(cancelled(signal));
    }
    return new Promise<void>((resolve, reject) => {
      let remaining = ms;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = (): void => {
        clearTimeout(timer);
        timer = undefined;
        reject(cancelled(signal));
      };
      const arm = (): void => {
        const slice = Math.min(remaining, MAX_TIMER_MS);
        remaining -= slice;
        timer = setTimeout(() => {
          timer = undefined;
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
