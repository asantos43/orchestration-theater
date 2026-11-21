// SPDX-License-Identifier: MPL-2.0

/**
 * The modes of the retention of the raw telemetry and of the rotation of `daemon.log` (Phase 8, P8;
 * architecture 5.11, N216 (a)). The keys are in `config.ts` (`telemetry.retention.*` and
 * `log.rotate.*`); the values they take are here, so the purge, the logger and the tests read the
 * same list. Every name and default is [proposta]: the plan names `telemetry.retention.days` (30),
 * `telemetry.retention.max_mb` (1024), `log.rotate.max_mb` (20) and `log.rotate.keep` (5).
 */

/**
 * `telemetry.retention.mode`: when the purge of the raw telemetry runs. `daily` (default): when
 * the daemon starts and then every `telemetry.retention.interval`; `startup`: only when it starts;
 * `off`: never by itself (the raw telemetry grows until the owner purges it).
 */
export const TELEMETRY_RETENTION_MODES = ['daily', 'startup', 'off'] as const;
export type TelemetryRetentionMode = (typeof TELEMETRY_RETENTION_MODES)[number];

/**
 * `telemetry.retention.guard`: what the purge waits for. `rollups` (default): it removes only the
 * days the daily aggregates of the analysis already cover (`readRollupsReadyThrough`), so raw
 * telemetry that was never aggregated is not lost; with no aggregates (`analysis.schedule.mode:
 * off`, or a base just created) nothing is purged and the base may grow past the limits (a
 * `telemetry_purge_blocked` notice says so). `none`: the limits are enforced whatever the
 * analysis has; the owner who does not use the analysis chooses this one.
 */
export const TELEMETRY_RETENTION_GUARDS = ['rollups', 'none'] as const;
export type TelemetryRetentionGuard = (typeof TELEMETRY_RETENTION_GUARDS)[number];

/** `log.rotate.mode`: `size` (default) rotates `daemon.log` when it passes `max_mb`; `off` lets it grow. */
export const LOG_ROTATE_MODES = ['size', 'off'] as const;
export type LogRotateMode = (typeof LOG_ROTATE_MODES)[number];

/** What the purge reads from `telemetry.retention` (the output of the schema in `config.ts`). */
export interface TelemetryRetentionSettings {
  readonly mode: TelemetryRetentionMode;
  /** Milliseconds between two passes of `daily`. */
  readonly interval: number;
  readonly days: number;
  readonly max_mb: number;
  readonly guard: TelemetryRetentionGuard;
}
