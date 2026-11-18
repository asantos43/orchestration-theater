// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { periodBounds } from './calendar.js';

const SP = 'America/Sao_Paulo';

describe('periodBounds (5.6: the cap turns at midnight and on day 1, in the daemon timezone)', () => {
  it('turns the day at midnight of São Paulo, not of UTC', () => {
    // 2026-11-18 09:00 in São Paulo (UTC-3).
    const at = Date.UTC(2026, 10, 18, 12);
    expect(periodBounds('day', at, SP)).toEqual({
      start: Date.UTC(2026, 10, 18, 3),
      end: Date.UTC(2026, 10, 19, 3),
    });
  });

  it('holds the last millisecond before midnight in the same day, and midnight in the next', () => {
    const midnight = Date.UTC(2026, 10, 19, 3);
    expect(periodBounds('day', midnight - 1, SP).end).toBe(midnight);
    expect(periodBounds('day', midnight, SP).start).toBe(midnight);
  });

  it('turns the month on day 1, and the year with it', () => {
    expect(periodBounds('month', Date.UTC(2026, 10, 18, 12), SP)).toEqual({
      start: Date.UTC(2026, 10, 1, 3),
      end: Date.UTC(2026, 11, 1, 3),
    });
    expect(periodBounds('month', Date.UTC(2026, 11, 31, 12), SP).end).toBe(Date.UTC(2027, 0, 1, 3));
  });

  it('reads the date of the zone: 01:00 UTC of the 19th is still the 18th in São Paulo', () => {
    const at = Date.UTC(2026, 10, 19, 1);
    expect(periodBounds('day', at, SP).start).toBe(Date.UTC(2026, 10, 18, 3));
    expect(periodBounds('day', at, 'UTC').start).toBe(Date.UTC(2026, 10, 19));
  });

  it('keeps a day of 23 hours (daylight saving) ending at midnight', () => {
    // New York springs forward on 2026-03-08: that day has 23 hours.
    const day = periodBounds('day', Date.UTC(2026, 2, 8, 12), 'America/New_York');
    expect(day.start).toBe(Date.UTC(2026, 2, 8, 5));
    expect(day.end).toBe(Date.UTC(2026, 2, 9, 4));
    expect(day.end - day.start).toBe(23 * 3_600_000);
  });

  it('reads an unknown zone as UTC', () => {
    expect(periodBounds('day', Date.UTC(2026, 10, 18, 12), 'Mars/Olympus')).toEqual({
      start: Date.UTC(2026, 10, 18),
      end: Date.UTC(2026, 10, 19),
    });
  });
});
