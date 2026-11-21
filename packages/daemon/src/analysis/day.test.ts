// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { addDays, dayBoundary, daysBetween, isRealDay } from './day.js';

const NOON_UTC = Date.UTC(2026, 10, 20, 12, 0, 0);

describe('the days of the analysis', () => {
  it('counts the days of the calendar across months, years and leap days', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-11-28', '2026-12-01')).toEqual([
      '2026-11-28',
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
    ]);
    expect(daysBetween('2026-11-02', '2026-11-01')).toEqual([]);
  });

  it('tells a real day from one that does not exist', () => {
    expect(isRealDay('2026-11-20')).toBe(true);
    expect(isRealDay('2028-02-29')).toBe(true);
    expect(isRealDay('2026-02-29')).toBe(false);
    expect(isRealDay('2026-13-01')).toBe(false);
    expect(isRealDay('yesterday')).toBe(false);
  });

  it('cuts the day at UTC', () => {
    const utc = dayBoundary('utc');
    expect(utc.dayOf(NOON_UTC)).toBe('2026-11-20');
    expect(utc.startOf('2026-11-20')).toBe(Date.UTC(2026, 10, 20));
    expect(utc.endOf('2026-11-20')).toBe(Date.UTC(2026, 10, 21));
    expect(utc.dayOf(utc.endOf('2026-11-20') - 1)).toBe('2026-11-20');
    expect(utc.dayOf(utc.endOf('2026-11-20'))).toBe('2026-11-21');
  });

  it('cuts the day at a fixed offset', () => {
    const saoPaulo = dayBoundary('-03:00');
    // 01:00 UTC is still the evening before, three hours behind.
    const night = Date.UTC(2026, 10, 21, 1, 0, 0);
    expect(saoPaulo.dayOf(night)).toBe('2026-11-20');
    expect(saoPaulo.startOf('2026-11-20')).toBe(Date.UTC(2026, 10, 20, 3));
    expect(saoPaulo.endOf('2026-11-20')).toBe(Date.UTC(2026, 10, 21, 3));
    const india = dayBoundary('+05:30');
    expect(india.dayOf(Date.UTC(2026, 10, 20, 19, 0, 0))).toBe('2026-11-21');
    expect(india.startOf('2026-11-21')).toBe(Date.UTC(2026, 10, 20, 18, 30));
  });

  it('cuts the day at the local midnight, whatever the time zone of the machine', () => {
    const local = dayBoundary('local');
    for (const day of ['2026-03-08', '2026-11-01', '2026-11-20']) {
      const start = local.startOf(day);
      expect(local.dayOf(start)).toBe(day);
      expect(local.dayOf(start - 1)).toBe(addDays(day, -1));
      expect(local.endOf(day)).toBe(local.startOf(addDays(day, 1)));
    }
  });

  it('refuses a boundary it does not know', () => {
    expect(() => dayBoundary('-3')).toThrow(RangeError);
    expect(() => dayBoundary('Europe/Paris')).toThrow(RangeError);
  });
});
