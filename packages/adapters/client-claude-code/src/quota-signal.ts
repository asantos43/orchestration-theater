// SPDX-License-Identifier: MPL-2.0
import { readRateLimitEvent, type SeenUnit, type UtilizationUnit } from './normalize-update.js';
import { windowNameOf } from './quota-statusline.js';

/** Name of the extension notification that carries quota signals (architecture 5.6, [proposta]). */
export const QUOTA_SIGNAL_METHOD = '_otheater/quota/signal';

/** `source` of the `limit_hit` signal of a rejected `rate_limit_event`. */
export const RATE_LIMIT_EVENT_SOURCE = 'rate_limit_event';

/**
 * The `QuotaSignal` of architecture 5.6 as the daemon validates it (`quotaSignalSchema` of
 * `@otheater/protocol`, which this package does not import): `resetsAt` is ISO 8601 text.
 */
export type ClaudeQuotaSignal =
  | {
      readonly kind: 'window';
      readonly window: string;
      readonly usedPercent: number;
      readonly resetsAt?: string;
    }
  | { readonly kind: 'limit_hit'; readonly source: string; readonly resetsAt?: string };

/** What a `rate_limit_event` turned into. */
export interface ClaudeQuotaSignals {
  readonly signals: readonly ClaudeQuotaSignal[];
  /** The units the utilizations were taken for (N123: the parser records what it saw). */
  readonly units: readonly SeenUnit[];
  /** The windows whose utilization was refused (outside 0..100, not a number), with the reason. */
  readonly refused: readonly string[];
}

export interface ClaudeQuotaSignalOptions {
  /** Default `ignore`: no window signal, only the `limit_hit` of a rejected event. */
  readonly utilizationUnit?: UtilizationUnit;
}

function iso(ms: number | undefined): { resetsAt?: string } {
  return ms === undefined ? {} : { resetsAt: new Date(ms).toISOString() };
}

/**
 * Turns the `rate_limit_event` of a raw `usage_update` into the quota signals the shell sends as
 * `_otheater/quota/signal` (P6). A window with a utilization the unit rule accepts becomes a
 * `window` signal, with the daemon's window name (`5h`, `7d`) and its reset. A `rejected` event
 * becomes a `limit_hit`, whether or not it carries a number. A refused utilization becomes no
 * signal, and the reason is in `refused`: a wrong number is worse than none. An update with no
 * event gives no signal.
 */
export function quotaSignalsOf(
  raw: unknown,
  options: ClaudeQuotaSignalOptions = {},
): ClaudeQuotaSignals {
  const event = readRateLimitEvent(raw, options.utilizationUnit ?? 'ignore');
  if (event === undefined) return { signals: [], units: [], refused: [] };
  const signals: ClaudeQuotaSignal[] = [];
  const units = new Set<SeenUnit>();
  const refused: string[] = [];
  for (const window of event.windows) {
    if (window.refused !== undefined) refused.push(`${window.name}: ${window.refused}`);
    if (window.percent === undefined || window.seen === undefined) continue;
    units.add(window.seen);
    signals.push({
      kind: 'window',
      window: windowNameOf(window.name),
      usedPercent: window.percent,
      ...iso(window.resetsAt),
    });
  }
  if (event.status === 'rejected') {
    const hit = event.windows.find((w) => w.name === event.dominant);
    signals.push({
      kind: 'limit_hit',
      source: RATE_LIMIT_EVENT_SOURCE,
      ...iso(event.resetsAt ?? hit?.resetsAt),
    });
  }
  return { signals, units: [...units], refused };
}

/** The params of the notification for one session: what `QuotaService.ingestNotification` takes. */
export function quotaSignalParams(
  sessionId: string,
  signal: ClaudeQuotaSignal,
): { sessionId: string; signal: ClaudeQuotaSignal } {
  return { sessionId, signal };
}
