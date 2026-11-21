// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatFraction,
  formatMaybeDuration,
  GAP,
  localDay,
  previousDay,
  trendRows,
  trendWindow,
} from './panels-model.js';

describe('the days of the trend', () => {
  it('goes back by the calendar, across a month and a year', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2024-03-01')).toBe('2024-02-29');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });

  it('takes the days ending yesterday, in the local time of the terminal', () => {
    const noon = new Date(2026, 10, 21, 12, 0, 0).getTime();
    expect(localDay(noon)).toBe('2026-11-21');
    expect(trendWindow(noon, 1)).toEqual({ from: '2026-11-20', to: '2026-11-20' });
    expect(trendWindow(noon, 14)).toEqual({ from: '2026-11-07', to: '2026-11-20' });
    // Just after midnight it is already another day.
    const early = new Date(2026, 11, 1, 0, 5, 0).getTime();
    expect(trendWindow(early, 3)).toEqual({ from: '2026-11-28', to: '2026-11-30' });
  });

  it('makes one row per day, oldest first, with a day with no aggregate as a gap', () => {
    const window = { from: '2026-11-18', to: '2026-11-20' };
    const group = { key: '2026-11-20', summary: {} as never };
    const rows = trendRows({ groups: [group] }, window);
    expect(rows.map((row) => row.day)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    expect(rows.map((row) => row.group === undefined)).toEqual([true, true, false]);
    // A group outside the window is not drawn.
    expect(
      trendRows({ groups: [{ ...group, key: '2026-01-01' }] }, window).every(
        (r) => r.group === undefined,
      ),
    ).toBe(true);
  });
});

describe('what a duration or a fraction looks like', () => {
  it('writes milliseconds, seconds, minutes and hours', () => {
    expect(formatDuration(12)).toBe('12ms');
    expect(formatDuration(3400)).toBe('3.4s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(formatDuration(3_720_000)).toBe('1h02m');
  });

  it('does not write 60 seconds or a minute that has not rounded up', () => {
    expect(formatDuration(59_960)).toBe('1m00s');
    expect(formatDuration(119_600)).toBe('2m00s');
  });

  it('writes a dash, never a zero, for what nobody measured', () => {
    expect(formatMaybeDuration(null)).toBe(GAP);
    expect(formatMaybeDuration(0)).toBe('0ms');
    expect(formatFraction(null)).toBe(GAP);
    expect(formatFraction(0)).toBe('0%');
    expect(formatFraction(0.375)).toBe('38%');
  });
});
