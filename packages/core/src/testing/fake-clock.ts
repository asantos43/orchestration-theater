// SPDX-License-Identifier: MPL-2.0
import { Cancelled, InvalidInput } from '../errors.js';
import type { Clock } from '../ports/clock.js';

interface PendingSleep {
  readonly dueAt: number;
  readonly seq: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

/** Epoch ms of 2026-01-01T00:00:00Z: a fixed, recognisable start for tests. */
export const FAKE_CLOCK_START = Date.UTC(2026, 0, 1);

/**
 * A `Clock` whose time only moves when the test says so. `advance(ms)` moves time forward and
 * fires, in due order, every `sleep` that falls inside the window.
 *
 * `sleep(0)` is no exception: it waits for the next `advance` (even `advance(0)`).
 */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #pending = new Set<PendingSleep>();

  constructor(startMs: number = FAKE_CLOCK_START) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  /** Sleeps waiting right now. Handy to assert that a cancelled sleep released its timer. */
  get pendingSleeps(): number {
    return this.#pending.size;
  }

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
      const onAbort = (): void => {
        this.#pending.delete(entry);
        signal?.removeEventListener('abort', onAbort);
        reject(cancelled(signal));
      };
      const entry: PendingSleep = {
        dueAt: this.#now + ms,
        seq: this.#seq++,
        resolve,
        reject,
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort);
        },
      };
      this.#pending.add(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Moves time forward by `ms` (a finite number >= 0) and fires the due sleeps, earliest first
   * (ties in call order), with `now()` set to each one's due time while it fires. After each one
   * it lets pending continuations run, so a loop `for (;;) { await clock.sleep(10) }` advances
   * one lap per 10 ms inside a single `advance(100)`. Resolves when the window is done.
   */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new InvalidInput(`advance(ms) needs a finite ms >= 0, got ${String(ms)}`);
    }
    const target = this.#now + ms;
    for (;;) {
      const next = this.#nextDue(target);
      if (next === undefined) break;
      this.#pending.delete(next);
      next.cleanup();
      this.#now = Math.max(this.#now, next.dueAt);
      next.resolve();
      await yieldToContinuations();
    }
    this.#now = target;
    // One last turn so continuations of the final firing see the final time.
    await yieldToContinuations();
  }

  #nextDue(target: number): PendingSleep | undefined {
    let best: PendingSleep | undefined;
    for (const entry of this.#pending) {
      if (entry.dueAt > target) continue;
      if (
        best === undefined ||
        entry.dueAt < best.dueAt ||
        (entry.dueAt === best.dueAt && entry.seq < best.seq)
      ) {
        best = entry;
      }
    }
    return best;
  }
}

function cancelled(signal: AbortSignal | undefined): Cancelled {
  return new Cancelled('sleep cancelled', { cause: signal?.reason });
}

/**
 * Lets every promise continuation (microtask) queued so far run to completion, however deep the
 * `await` chain. A zero-delay `setTimeout` is a macrotask, so it only fires after the microtask
 * queue drains. `setTimeout` is a platform global (not a `node:` import) and its duration is not
 * what the tests observe: all test time comes from the `FakeClock`. Do not combine this clock
 * with `vi.useFakeTimers()`, which would freeze this yield.
 */
function yieldToContinuations(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
