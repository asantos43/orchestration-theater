// SPDX-License-Identifier: MPL-2.0
import { DAY_BOUNDARY_PATTERN } from './analysis-config.js';

/**
 * The days of the aggregates (Phase 8, P9). A day is `YYYY-MM-DD` in the boundary of
 * `analysis.day_boundary`: `local` (the time zone of the machine), `utc` or a fixed offset. The
 * calendar arithmetic runs on UTC dates, so it has no clock of its own and no DST surprise: only
 * `local` can have a day of 23 or 25 hours, and then the start of the next day is the answer.
 */

const MS_PER_DAY = 86_400_000;

export interface DayBoundary {
  /** The day (`YYYY-MM-DD`) an instant belongs to. */
  dayOf(ms: number): string;
  /** The first instant of the day (epoch ms). */
  startOf(day: string): number;
  /** The first instant after the day (the start of the next one). */
  endOf(day: string): number;
}

export function parseDay(day: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) throw new RangeError(`not a day: ${day}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function formatDay(y: number, m: number, d: number): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** The day `n` days after `day` (negative: before), by the calendar. */
export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return formatDay(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** The days from `from` to `to`, both included; empty when `to` is before `from`. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** A real calendar day (`2026-02-30` is not one). */
export function isRealDay(day: string): boolean {
  try {
    const { y, m, d } = parseDay(day);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  } catch {
    return false;
  }
}

export function dayBoundary(spec: string): DayBoundary {
  if (!DAY_BOUNDARY_PATTERN.test(spec)) throw new RangeError(`bad day boundary: ${spec}`);
  if (spec === 'local') {
    return {
      dayOf(ms) {
        const date = new Date(ms);
        return formatDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
      },
      startOf(day) {
        const { y, m, d } = parseDay(day);
        return new Date(y, m - 1, d).getTime();
      },
      endOf(day) {
        const { y, m, d } = parseDay(day);
        return new Date(y, m - 1, d + 1).getTime();
      },
    };
  }
  const offsetMs = fixedOffsetMs(spec);
  return {
    dayOf(ms) {
      const date = new Date(ms + offsetMs);
      return formatDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    },
    startOf(day) {
      const { y, m, d } = parseDay(day);
      return Date.UTC(y, m - 1, d) - offsetMs;
    },
    endOf(day) {
      const { y, m, d } = parseDay(day);
      return Date.UTC(y, m - 1, d) + MS_PER_DAY - offsetMs;
    },
  };
}

function fixedOffsetMs(spec: string): number {
  if (spec === 'utc') return 0;
  const sign = spec.startsWith('-') ? -1 : 1;
  const hours = Number(spec.slice(1, 3));
  const minutes = Number(spec.slice(4, 6));
  return sign * (hours * 60 + minutes) * 60_000;
}
