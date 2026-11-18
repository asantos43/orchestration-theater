// SPDX-License-Identifier: MPL-2.0
import type { QuotaSnapshotRecord } from '@otheater/core';
import type { QuotaCause, QuotaState } from '@otheater/protocol';

/**
 * The state of a profile from what is stored (architecture 5.6, "Estado por perfil"). Pure: the
 * same rows and the same instant always give the same answer, so a restart recomputes the state
 * from `quota_snapshots` and nothing else.
 */

/**
 * [proposta] A limit error (a `limit_hit` signal, the `-32001` error) is stored as a row of
 * `quota_snapshots` under a reserved window name, at 100%, so that it survives a restart like any
 * reading. A real window never takes these names.
 */
export const LIMIT_HIT_WINDOW = 'limit_hit';
export const BUDGET_HIT_WINDOW = 'budget_hit';

const HIT_CAUSES: Readonly<Record<string, QuotaCause>> = {
  [LIMIT_HIT_WINDOW]: 'quota',
  [BUDGET_HIT_WINDOW]: 'budget',
};

/** The reserved window of a cause. */
export function hitWindowOf(cause: QuotaCause): string {
  return cause === 'quota' ? LIMIT_HIT_WINDOW : BUDGET_HIT_WINDOW;
}

export interface QuotaRules {
  /** Fraction (0..1] of a window from which the state is `near_limit`. */
  readonly nearLimitAt: number;
  /** A reading older than this does not authorize a route. */
  readonly staleAfterMs: number;
  /**
   * The windows the probe of the profile reports. A profile is `ok` only when every one of them
   * has a fresh reading: a window with no reading is `unknown`, never `ok`. Empty: no demand.
   */
  readonly expectedWindows: readonly string[];
}

/** One window of a profile as the service holds it. */
export interface QuotaWindowState {
  readonly window: string;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly observedAt: number;
  readonly source: string;
  /** Whether it is recent enough, and its reset has not passed: only a fresh one can authorize. */
  readonly fresh: boolean;
}

export interface QuotaStatus {
  /** Complete id `<client>/<profile>`. */
  readonly profile: string;
  readonly state: QuotaState;
  /** Why it is exhausted; `null` in any other state. */
  readonly cause: QuotaCause | null;
  /** Until when it is exhausted (epoch ms); `null` when no source says it, or when not exhausted. */
  readonly untilReset: number | null;
  /** The windows read, without the reserved ones. */
  readonly windows: readonly QuotaWindowState[];
  /** The newest `observedAt` among the windows and the limit hits, or `null`. */
  readonly observedAt: number | null;
  /** The window that put the profile in `near_limit` (the fullest one), when it is. */
  readonly nearLimitWindow: QuotaWindowState | null;
  /** A short sentence for logs and for the Producer. */
  readonly reason: string;
}

/** Whether the profile may take a new session: `ok` and `near_limit` may; the rest may not. */
export function authorizes(status: Pick<QuotaStatus, 'state'>): boolean {
  return status.state === 'ok' || status.state === 'near_limit';
}

/** `null` when any of the times is unknown, else the latest. A limit with no end is not over. */
function laterOrUnknown(times: readonly (number | null)[]): number | null {
  let latest = 0;
  for (const time of times) {
    if (time === null) return null;
    latest = Math.max(latest, time);
  }
  return latest;
}

export function evaluateQuota(
  profile: string,
  rows: readonly QuotaSnapshotRecord[],
  now: number,
  rules: QuotaRules,
): QuotaStatus {
  const isFresh = (row: QuotaSnapshotRecord): boolean =>
    now - row.observedAt <= rules.staleAfterMs && (row.resetsAt === null || row.resetsAt > now);
  const windows: QuotaWindowState[] = rows
    .filter((row) => HIT_CAUSES[row.window] === undefined)
    .map((row) => ({
      window: row.window,
      usedPercent: row.usedPercent,
      resetsAt: row.resetsAt,
      observedAt: row.observedAt,
      source: row.source,
      fresh: isFresh(row),
    }));
  const hits = rows.filter((row) => HIT_CAUSES[row.window] !== undefined);
  const observedAt = rows.reduce<number | null>(
    (latest, row) => (latest === null || row.observedAt > latest ? row.observedAt : latest),
    null,
  );
  const base = { profile, windows, observedAt };

  // A full window with a reset still to come keeps the profile exhausted even when the reading is
  // old: refusing is the safe side. With no reset time it counts only while it is fresh.
  const fullWindows = windows.filter(
    (w) =>
      w.usedPercent >= 100 &&
      ((w.resetsAt !== null && w.resetsAt > now) || (w.resetsAt === null && w.fresh)),
  );
  const newestFresh = windows
    .filter((w) => w.fresh)
    .reduce<number>((latest, w) => Math.max(latest, w.observedAt), -1);

  const quotaEnds: (number | null)[] = fullWindows.map((w) => w.resetsAt);
  const budgetEnds: (number | null)[] = [];
  let quotaSource = fullWindows.length > 0 ? 'window at 100%' : '';
  for (const hit of hits) {
    const cause = HIT_CAUSES[hit.window];
    const open = hit.resetsAt === null || hit.resetsAt > now;
    if (!open) continue;
    if (cause === 'quota') {
      // A reading taken after the limit error, with room in every window, says it is over.
      const superseded = newestFresh > hit.observedAt && fullWindows.length === 0;
      if (superseded) continue;
      quotaEnds.push(hit.resetsAt);
      quotaSource = hit.source;
    } else {
      budgetEnds.push(hit.resetsAt);
    }
  }
  if (quotaEnds.length > 0 || budgetEnds.length > 0) {
    const cause: QuotaCause = quotaEnds.length > 0 ? 'quota' : 'budget';
    const untilReset = laterOrUnknown([...quotaEnds, ...budgetEnds]);
    return {
      ...base,
      state: 'exhausted',
      cause,
      untilReset,
      nearLimitWindow: null,
      reason:
        cause === 'quota' ? `quota exhausted (${quotaSource})` : 'the spending cap was reached',
    };
  }

  const fresh = windows.filter((w) => w.fresh);
  const unknown = (reason: string): QuotaStatus => ({
    ...base,
    state: 'unknown',
    cause: null,
    untilReset: null,
    nearLimitWindow: null,
    reason,
  });
  if (fresh.length === 0) {
    return unknown(
      windows.length === 0 ? 'no reading yet' : 'every reading is stale or its window has reset',
    );
  }
  const missing = rules.expectedWindows.filter((name) => !fresh.some((w) => w.window === name));
  if (missing.length > 0) {
    return unknown(`no fresh reading of the window ${missing.join(', ')}`);
  }
  const threshold = rules.nearLimitAt * 100;
  const near = fresh
    .filter((w) => w.usedPercent >= threshold)
    .sort((a, b) => b.usedPercent - a.usedPercent);
  const fullest = near[0];
  if (fullest !== undefined) {
    return {
      ...base,
      state: 'near_limit',
      cause: null,
      untilReset: null,
      nearLimitWindow: fullest,
      reason: `the window ${fullest.window} is at ${String(fullest.usedPercent)}%`,
    };
  }
  return {
    ...base,
    state: 'ok',
    cause: null,
    untilReset: null,
    nearLimitWindow: null,
    reason: 'every window has room',
  };
}

/**
 * What changed in the readings, without the instants: two statuses with the same signature need no
 * `quota.updated`. The state is part of it, so a change by the clock alone still counts.
 */
export function signatureOf(status: QuotaStatus): string {
  const windows = status.windows
    .map((w) => `${w.window}=${String(w.usedPercent)}@${String(w.resetsAt)}`)
    .sort()
    .join(',');
  return `${status.state}|${String(status.cause)}|${String(status.untilReset)}|${windows}`;
}
