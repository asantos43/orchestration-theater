// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QuotaReadingSchema,
  Transient,
  type QuotaReading,
} from '@otheater/core';
import type { CodexRateLimitWindow } from './app-server-types.js';

/** The name of the synthetic window that says "the client reports the limit reached" ([proposta]). */
export const LIMIT_REACHED_WINDOW = 'limit_reached';

/** A snapshot of the app-server as the probe keeps it: only what it reads, every field checked. */
export interface RateLimitView {
  readonly primary: CodexRateLimitWindow | null;
  readonly secondary: CodexRateLimitWindow | null;
  readonly planType: string | null;
  readonly reachedType: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** One window, or `null` when the value is absent or is not a window with a number in `usedPercent`. */
function windowOf(value: unknown): CodexRateLimitWindow | null {
  const raw = record(value);
  const used = finite(raw?.usedPercent);
  if (raw === undefined || used === undefined) return null;
  return {
    usedPercent: used,
    windowDurationMins: finite(raw.windowDurationMins) ?? null,
    resetsAt: finite(raw.resetsAt) ?? null,
  };
}

/** The snapshot of one bucket as a view; `undefined` when the value is not a snapshot at all. */
function viewOf(value: unknown): RateLimitView | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  return {
    primary: windowOf(raw.primary),
    secondary: windowOf(raw.secondary),
    planType: text(raw.planType),
    reachedType: text(raw.rateLimitReachedType),
  };
}

/**
 * The view of an `account/rateLimits/read` answer. The single-bucket field `rateLimits` is the one
 * read; when it is missing, the bucket `codex` of `rateLimitsByLimitId` stands in. An answer that is
 * neither is `Transient` (the protocol is experimental and may change [N]), never a reading.
 */
export function viewOfReadResult(result: unknown): RateLimitView {
  const response = record(result);
  const view = viewOf(response?.rateLimits) ?? viewOf(record(response?.rateLimitsByLimitId)?.codex);
  if (view === undefined) {
    throw new Transient('codex: account/rateLimits/read answered with an unknown shape');
  }
  return view;
}

/** The view of an `account/rateLimits/updated` notification, or `undefined` if it carries no snapshot. */
export function viewOfUpdate(params: unknown): RateLimitView | undefined {
  return viewOf(record(params)?.rateLimits);
}

/**
 * Merges a sparse update into the last view: a window the update carries replaces the old one, a
 * window it leaves out stays, and so does the plan. `rateLimitReachedType` follows the update (the
 * backend states it with every snapshot) [N].
 */
export function mergeUpdate(last: RateLimitView, update: RateLimitView): RateLimitView {
  return {
    primary: update.primary ?? last.primary,
    secondary: update.secondary ?? last.secondary,
    planType: update.planType ?? last.planType,
    reachedType: update.reachedType,
  };
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/**
 * The name of a window from its length: 300 minutes is `5h` and 10080 is `7d`, the two Phase 0 saw
 * [V]; any other length is written the same way (`2d`, `90m`). Without a length the slot names it
 * (`primary`, `secondary`).
 */
export function windowNameOf(minutes: number | null, slot: 'primary' | 'secondary'): string {
  if (minutes === null || !Number.isInteger(minutes) || minutes <= 0) return slot;
  if (minutes % MINUTES_PER_DAY === 0) return `${String(minutes / MINUTES_PER_DAY)}d`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${String(minutes / MINUTES_PER_HOUR)}h`;
  return `${String(minutes)}m`;
}

/**
 * Turns a view into the reading the `QuotaService` takes. `resetsAt` comes in epoch seconds and goes
 * out in milliseconds. A reached limit with no window at 100% (a credit limit, not a time window)
 * becomes the window `limit_reached` at 100% with no reset, so the profile is `exhausted`
 * and not `available` ([proposta]). A view with no window and no reached limit is not a reading:
 * the answer of an account that has no limits to show is `AdapterUnavailable`, which the service
 * leaves to age into `unknown`.
 */
export function readingOf(view: RateLimitView, observedAt: number): QuotaReading {
  const windows: QuotaReading['windows'] = [];
  const used = new Set<string>();
  for (const slot of ['primary', 'secondary'] as const) {
    const found = view[slot];
    if (found === null) continue;
    let name = windowNameOf(found.windowDurationMins, slot);
    if (used.has(name)) name = slot;
    used.add(name);
    windows.push({
      window: name,
      usedPercent: Math.max(0, found.usedPercent),
      ...(found.resetsAt !== null && found.resetsAt > 0
        ? { resetsAt: Math.round(found.resetsAt * 1000) }
        : {}),
    });
  }
  if (view.reachedType !== null && !windows.some((one) => one.usedPercent >= 100)) {
    windows.push({ window: LIMIT_REACHED_WINDOW, usedPercent: 100 });
  }
  if (windows.length === 0) {
    throw new AdapterUnavailable('codex: the account reports no rate-limit window');
  }
  return QuotaReadingSchema.parse({
    observedAt,
    windows,
    ...(view.planType === null ? {} : { planType: view.planType }),
  });
}
