// SPDX-License-Identifier: MPL-2.0
import { formatInTimezone, isKnownTimezone, zonedTimeToEpoch } from '@otheater/core';
import type { BudgetPeriod } from '@otheater/protocol';

/** One period of a cap: it holds `[start, end)`, in epoch ms. */
export interface PeriodBounds {
  readonly start: number;
  /** The instant the period turns: midnight of the next day, or of day 1 of the next month. */
  readonly end: number;
}

/**
 * The calendar day or month that holds `at`, in `timezone` (architecture 5.6: the cap's period turns
 * at midnight and on day 1). The turn is read in the zone's wall clock, so a day of 23 or 25 hours
 * (daylight saving) still ends at midnight. An unknown zone reads as UTC.
 */
export function periodBounds(period: BudgetPeriod, at: number, timezone: string): PeriodBounds {
  const [date = ''] = formatInTimezone(at, timezone).split(' ');
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const zone = isKnownTimezone(timezone) ? timezone : 'UTC';
  const midnight = (y: number, m: number, d: number): number => {
    // `Date.UTC` normalizes an overflowing day or month (day 32, month 13) into the next one.
    const wall = new Date(Date.UTC(y, m - 1, d));
    return zonedTimeToEpoch(
      {
        year: wall.getUTCFullYear(),
        month: wall.getUTCMonth() + 1,
        day: wall.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      zone,
    );
  };
  return period === 'day'
    ? { start: midnight(year, month, day), end: midnight(year, month, day + 1) }
    : { start: midnight(year, month, 1), end: midnight(year, month + 1, 1) };
}
