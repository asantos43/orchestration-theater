// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode, type Clock, type EventEnvelope, type JsonValue } from '@otheater/core';
import { z } from 'zod';

/** What the generic steps share. */

/**
 * Sleeps on the clock of the daemon. `true` when the time passed, `false` when `signal` aborted
 * first (a cancelled run or a stopping daemon). Any other error is the caller's.
 */
export async function sleepOrAbort(
  clock: Clock,
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await clock.sleep(Math.max(0, ms), signal);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'CANCELLED')) return false;
    throw error;
  }
}

/**
 * A signal that aborts when `signal` does or when `ms` of the clock have passed, and a way to tell
 * which one it was. `ms` of `null` has no deadline. `dispose` releases the timer: call it when the
 * work ends.
 */
export function withDeadline(
  clock: Clock,
  ms: number | null,
  signal: AbortSignal,
): { readonly signal: AbortSignal; readonly expired: () => boolean; readonly dispose: () => void } {
  if (ms === null) return { signal, expired: () => false, dispose: () => undefined };
  const controller = new AbortController();
  const timer = new AbortController();
  let expired = false;
  const onAbort = (): void => {
    controller.abort(signal.reason);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  void sleepOrAbort(clock, ms, timer.signal).then((slept) => {
    if (!slept) return;
    expired = true;
    controller.abort(new Error('deadline'));
  });
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
      timer.abort();
    },
  };
}

const JsonValueSchema = z.json();

/** The value as JSON (what can be saved and put in an event); anything else becomes `null`. */
export function toJsonValue(value: unknown): JsonValue {
  const parsed = JsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Equal as JSON values (objects by their fields, arrays by their items). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every(
        (key) =>
          Object.hasOwn(b, key) &&
          jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

/**
 * Whether an event of the log is the one a `wait_event` waits for: the type is the same and every
 * field of `filter` is equal to the field of the payload with that name. [proposta] The filter is
 * an exact match on the first level of the payload; the language of the conditions is not used
 * here (the plan fixes only `filter` as a record).
 */
export function eventMatches(
  event: Pick<EventEnvelope, 'type' | 'payload'>,
  type: string,
  filter: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (event.type !== type) return false;
  if (filter === undefined) return true;
  return Object.entries(filter).every(([key, value]) => jsonEqual(event.payload[key], value));
}
