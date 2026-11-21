// SPDX-License-Identifier: MPL-2.0
import { PLAY_STATES, type PlayState } from '@otheater/protocol';
import { z } from 'zod';

/**
 * The keys of the analysis of the system (Phase 8, P9; architecture 5.11, N55 and N217). All of the
 * names and modes below are [proposta]; `analysis.retention.days` and its default of 365 come from
 * the plan of the phase.
 *
 * - `analysis.schedule.mode` (default `daily`): when the daemon builds the daily aggregates.
 *   `daily`: when it starts (the closed days that are missing, up to yesterday) and every time the
 *   day rolls over; `startup`: only when it starts; `off`: never by itself (a day is built only
 *   when asked for). Today is never built, and a day already marked ready is not built again.
 * - `analysis.day_boundary` (default `local`): where a day starts and ends. `local`: the time zone
 *   of the machine; `utc`; or a fixed offset `+HH:MM` / `-HH:MM` from UTC.
 * - `analysis.producer_wait_states` (default `["AWAITING_PRODUCER"]`): the states of the play whose
 *   time counts as a wait for the Producer (an open question: N217). The time in these states is
 *   also in the time of each state.
 * - `analysis.retention.days` (default 365): how long the aggregates are kept, apart from the raw
 *   telemetry (`telemetry.retention.*`). `0` keeps them forever.
 * - `analysis.report.default_days` (default 7): the days of a report that does not say `from`.
 * - `analysis.report.top` (default 5): how many bottlenecks a report lists.
 */
export const ANALYSIS_SCHEDULE_MODES = ['daily', 'startup', 'off'] as const;
export type AnalysisScheduleMode = (typeof ANALYSIS_SCHEDULE_MODES)[number];

/** `local`, `utc` or a fixed offset from UTC. */
export const DAY_BOUNDARY_PATTERN = /^(local|utc|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export const AnalysisConfigSchema = z
  .strictObject({
    schedule: z
      .strictObject({
        mode: z.enum(ANALYSIS_SCHEDULE_MODES).default('daily'),
      })
      .prefault({}),
    day_boundary: z
      .string()
      .regex(DAY_BOUNDARY_PATTERN, 'use local, utc or an offset like -03:00')
      .default('local'),
    producer_wait_states: z
      .array(z.enum(PLAY_STATES))
      .default(['AWAITING_PRODUCER'] satisfies PlayState[]),
    retention: z
      .strictObject({
        days: z.int().min(0).max(36_500).default(365),
      })
      .prefault({}),
    report: z
      .strictObject({
        default_days: z.int().min(1).max(366).default(7),
        top: z.int().min(1).max(50).default(5),
      })
      .prefault({}),
  })
  .prefault({});

export type AnalysisSettings = z.infer<typeof AnalysisConfigSchema>;
