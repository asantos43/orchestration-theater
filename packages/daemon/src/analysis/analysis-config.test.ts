// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DaemonConfigSchema } from '../config.js';
import { AnalysisConfigSchema } from './analysis-config.js';

describe('the keys of analysis.*', () => {
  it('has the defaults of the plan', () => {
    const analysis = AnalysisConfigSchema.parse(undefined);
    expect(analysis).toEqual({
      schedule: { mode: 'daily' },
      day_boundary: 'local',
      producer_wait_states: ['AWAITING_PRODUCER'],
      retention: { days: 365 },
      report: { default_days: 7, top: 5 },
    });
    expect(DaemonConfigSchema.parse({}).analysis).toEqual(analysis);
  });

  it.each(['daily', 'startup', 'off'])('accepts the schedule mode %s', (mode) => {
    expect(AnalysisConfigSchema.parse({ schedule: { mode } }).schedule.mode).toBe(mode);
  });

  it.each(['local', 'utc', '-03:00', '+05:30'])('accepts the day boundary %s', (boundary) => {
    expect(AnalysisConfigSchema.parse({ day_boundary: boundary }).day_boundary).toBe(boundary);
  });

  it('keeps the aggregates forever with retention.days 0', () => {
    expect(AnalysisConfigSchema.parse({ retention: { days: 0 } }).retention.days).toBe(0);
  });

  it.each([
    { schedule: { mode: 'weekly' } },
    { day_boundary: 'Europe/Paris' },
    { day_boundary: '-3' },
    { retention: { days: -1 } },
    { report: { default_days: 0 } },
    { report: { top: 0 } },
    { producer_wait_states: ['NOT_A_STATE'] },
    { unknown_key: true },
  ])('refuses %j', (value) => {
    expect(() => AnalysisConfigSchema.parse(value)).toThrow();
  });
});
