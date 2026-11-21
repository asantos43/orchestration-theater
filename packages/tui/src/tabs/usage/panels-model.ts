// SPDX-License-Identifier: MPL-2.0
import type { AnalysisGroup, AnalysisReport } from '@otheater/protocol';

/**
 * The pure parts of the telemetry panels of the Usage tab (Phase 8, P10; architecture 5.13): the
 * days the trend asks for, its rows (a day with no aggregate is a row of its own, not a zero), and
 * the way the panels write a duration or a fraction that may be unknown.
 */

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` of an instant, in the local time of the terminal. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The day before `day` (`YYYY-MM-DD`), by the calendar (not by 24 hours). */
export function previousDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const before = new Date(year, month - 1, date - 1);
  return `${String(before.getFullYear())}-${two(before.getMonth() + 1)}-${two(before.getDate())}`;
}

/**
 * The window of the trend: `days` days ending yesterday (today is not closed, the aggregates only
 * hold closed days). [proposta] The day is the one of the terminal; when the daemon cuts its days
 * another way (`analysis.day_boundary`) a day the daemon has not closed shows as a gap.
 */
export function trendWindow(
  now: number,
  days: number,
): { readonly from: string; readonly to: string } {
  const to = previousDay(localDay(now));
  let from = to;
  for (let i = 1; i < days; i += 1) from = previousDay(from);
  return { from, to };
}

export interface TrendRow {
  readonly day: string;
  /** `undefined`: the aggregates have nothing for the day (not closed, purged, or nothing happened). */
  readonly group: AnalysisGroup | undefined;
}

/** One row per day of the window, oldest first, the days with no aggregate as gaps. */
export function trendRows(
  report: Pick<AnalysisReport, 'groups'>,
  window: { readonly from: string; readonly to: string },
): readonly TrendRow[] {
  const byDay = new Map(report.groups.map((group) => [group.key, group]));
  const days: string[] = [];
  for (let day = window.to; ; day = previousDay(day)) {
    days.push(day);
    if (day <= window.from || days.length > 400) break;
  }
  return days.reverse().map((day) => ({ day, group: byDay.get(day) }));
}

/** `12ms`, `3.4s`, `2m05s`, `1h02m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  // Under a minute, in tenths of a second; from there, in whole seconds (rounded before the split).
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)}m${two(total % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h${two(minutes % 60)}m`;
}

/** A duration that may be unknown: `—` for a gap. */
export function formatMaybeDuration(ms: number | null): string {
  return ms === null ? GAP : formatDuration(ms);
}

/** A fraction 0 to 1 as `37%`; `—` for a gap. */
export function formatFraction(value: number | null): string {
  return value === null ? GAP : `${String(Math.round(value * 100))}%`;
}

/** What a figure nobody measured looks like. Never `0`. */
export const GAP = '—';
