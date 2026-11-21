// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payload of the `telemetry.store_reset` event (Phase 8, P1, N54; architecture 5.11). The
 * telemetry base was thrown away and recreated, or could not be (`outcome: unavailable`: there is
 * no base and the records are discarded and counted). Registered in `DAEMON_EVENT_DEFINITIONS`
 * (events.ts) at `schemaVersion` 1. A strict object, with no telemetry content and no full path:
 * the daemon also writes a warning to the log with the full path. [proposta] The fields below.
 */

/** Why the base was left: a corrupted file, a full disk, migrations that failed, or any other open failure. */
export const TELEMETRY_RESET_REASONS = [
  'corrupt',
  'disk_full',
  'migration_failed',
  'io_error',
] as const;
export type TelemetryResetReason = (typeof TELEMETRY_RESET_REASONS)[number];

/** `recreated`: a new empty base is in use. `unavailable`: there is none, writes are discards. */
export const TELEMETRY_RESET_OUTCOMES = ['recreated', 'unavailable'] as const;
export type TelemetryResetOutcome = (typeof TELEMETRY_RESET_OUTCOMES)[number];

export const TelemetryStoreResetPayloadSchema = z.strictObject({
  reason: z.enum(TELEMETRY_RESET_REASONS),
  outcome: z.enum(TELEMETRY_RESET_OUTCOMES),
  /** Name (no folder) of the file kept beside the base, `telemetry.sqlite.broken-<date>`; `null` if none. */
  brokenFile: z.string().min(1).max(256).nullable(),
  /** Times the base was recreated since the daemon started (this one included). */
  resets: z.int().min(0),
});
