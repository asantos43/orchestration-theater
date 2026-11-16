// SPDX-License-Identifier: MPL-2.0

/** Semver of the `Clock` port contract (architecture 5.18, "Versão dos contratos"). */
export const CLOCK_PORT_VERSION = '0.1.0';

/**
 * Current time and cancellable waiting: validity of directives, schedules, timeouts.
 * Nothing in the daemon calls `Date.now()` or `setTimeout` directly; it asks the `Clock`, so tests
 * can drive time (`FakeClock` in `@otheater/core/testing`).
 *
 * Contract (checked by `describeClockConformance` in `@otheater/sdk`):
 * - `now()` never goes backwards between two calls on the same clock.
 * - `sleep(ms)` resolves after at least `ms` of this clock's time has passed. `ms` must be a
 *   finite number >= 0; anything else rejects with `InvalidInput`. Adapters must support delays
 *   beyond the 2^31-1 ms limit of platform timers (quota waits last hours or days).
 * - If `signal` is already aborted, or aborts while waiting, `sleep` rejects with `Cancelled`
 *   (`cause` = `signal.reason`) and the wait is released: no timer or listener is left behind.
 */
export interface Clock {
  /**
   * Current time as epoch milliseconds (integer).
   *
   * [proposta] epoch ms rather than `Date`: it is immutable and free to copy, serializes as-is in
   * SQLite and JSON (the event envelope uses it), subtracts without conversions, and a `Date`
   * handed around can be mutated by any holder. Call sites needing a `Date` do `new Date(ms)`.
   */
  now(): number;

  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
