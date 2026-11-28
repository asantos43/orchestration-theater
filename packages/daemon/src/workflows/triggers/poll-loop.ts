// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '@otheater/core';
import { sleepOrAbort } from '../steps/support.js';

/**
 * The loop that looks at the sources of the triggers on a timer of the daemon's `Clock` (D3; plan
 * of Phase 11b, P6). There is no trigger of the operating system in any mode: the timer is the
 * daemon's own, so a daemon that is not running looks at nothing, and the Phase 9b (timed
 * triggers) can lend the same loop to its own sources.
 *
 * [proposta] The plan says "the `Clock` port and the `wakeups`". The `wakeups` table of the store
 * serves a profile that waits for its quota (the cause is `quota` or `budget`, one row per
 * profile), so it does not fit the sources of the triggers, which belong to bindings; this loop
 * sleeps on the `Clock` itself, as the `WakeupManager` does, and keeps the next time of each
 * source in memory (what is not seen yet is on the host, and the ledger keeps what was).
 *
 * One pass looks at every source that is due, one after the other (a failing source never stops
 * the others). A source that fails waits longer before its next look: `interval * 2^failures`, up
 * to `backoffMax`; one look that works clears it. What to do about a failure beyond waiting (pause
 * the binding, say so in an event) is the handler's.
 */

/** Something to look at. `id` is stable between passes (the loop keeps its schedule by it). */
export interface PollSource {
  readonly id: string;
  /** One look. A throw is a failure of the look. */
  poll(signal: AbortSignal): Promise<void>;
}

/** A look that failed. */
export interface PollFailure {
  readonly source: PollSource;
  readonly error: unknown;
  /** Failures in a row of this source, this one included. */
  readonly failures: number;
  /** How long the loop waits before it looks at the source again (ms). */
  readonly retryInMs: number;
}

export interface PollLoopOptions {
  readonly clock: Pick<Clock, 'now' | 'sleep'>;
  /** The time between two passes (ms); read at every pass, so a change of configuration applies. */
  readonly interval: () => number;
  /** The longest wait of the backoff (ms). */
  readonly backoffMax: () => number;
  /** What to look at in this pass. */
  readonly sources: () => Promise<readonly PollSource[]> | readonly PollSource[];
  /** Told of every failed look (it must not throw; if it does, the loop goes on). */
  readonly onFailure: (failure: PollFailure) => Promise<void> | void;
  /** Told when the list of sources itself could not be made. */
  readonly onListFailure?: ((error: unknown) => Promise<void> | void) | undefined;
}

interface Schedule {
  failures: number;
  /** Not before this time (ms of the clock). */
  notBefore: number;
}

export class PollLoop {
  readonly #opts: PollLoopOptions;
  readonly #schedule = new Map<string, Schedule>();
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(options: PollLoopOptions) {
    this.#opts = options;
  }

  /** Whether the timer is going. */
  get started(): boolean {
    return this.#controller !== undefined;
  }

  /** Starts the timer: a first pass now, then one after every `interval`. Starting twice does nothing. */
  start(): void {
    if (this.#controller !== undefined) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#running = this.#run(controller.signal);
  }

  /** Stops the timer and waits for the pass in flight to end. */
  async stop(): Promise<void> {
    const controller = this.#controller;
    if (controller === undefined) return;
    this.#controller = undefined;
    controller.abort();
    await this.#running;
    this.#running = undefined;
  }

  /**
   * One pass now, outside the timer: looks at every source that is due. Resolves when the pass
   * ends. Safe to call while the timer runs only from a test (two passes would overlap).
   */
  async pass(signal: AbortSignal = new AbortController().signal): Promise<void> {
    let sources: readonly PollSource[];
    try {
      sources = await this.#opts.sources();
    } catch (error) {
      await this.#safely(() => this.#opts.onListFailure?.(error));
      return;
    }
    const alive = new Set(sources.map((source) => source.id));
    for (const id of this.#schedule.keys()) {
      if (!alive.has(id)) this.#schedule.delete(id);
    }
    for (const source of sources) {
      if (signal.aborted) return;
      const now = this.#opts.clock.now();
      const state = this.#schedule.get(source.id);
      if (state !== undefined && state.notBefore > now) continue;
      try {
        await source.poll(signal);
        this.#schedule.delete(source.id);
      } catch (error) {
        if (isAborted(signal)) return;
        const failures = (state?.failures ?? 0) + 1;
        const interval = this.#opts.interval();
        const retryInMs = Math.min(this.#opts.backoffMax(), interval * 2 ** failures);
        this.#schedule.set(source.id, { failures, notBefore: now + retryInMs });
        await this.#safely(() => this.#opts.onFailure({ source, error, failures, retryInMs }));
      }
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pass(signal);
      if (!(await sleepOrAbort(this.#opts.clock, this.#opts.interval(), signal))) return;
    }
  }

  async #safely(fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch {
      // A handler that fails must not stop the loop: the failure it was told about is already
      // in the schedule, and the next pass looks again.
    }
  }
}

/** `signal.aborted` as the type system cannot narrow it: the signal can fire during an await. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
