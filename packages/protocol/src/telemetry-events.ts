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

/**
 * Payloads of the receiver events (Phase 8, P2, N211 to N213; architecture 5.11). All strict, with
 * no telemetry content and no token: counts, names of attributes and the port. Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. [proposta] The fields below.
 */

/** `telemetry.receiver_started`: the OTLP receiver listens on this loopback port (the token never appears). */
export const TelemetryReceiverStartedPayloadSchema = z.strictObject({
  port: z.int().min(1).max(65535),
});

/** Why a batch was refused: the body format, its size, or the token. */
export const TELEMETRY_BATCH_REJECT_REASONS = ['format', 'size', 'token'] as const;
export type TelemetryBatchRejectReason = (typeof TELEMETRY_BATCH_REJECT_REASONS)[number];

/** The OTLP signals the receiver takes. */
export const TELEMETRY_SIGNALS = ['traces', 'metrics', 'logs'] as const;
export type TelemetrySignal = (typeof TELEMETRY_SIGNALS)[number];

/**
 * `telemetry.batch_rejected`: batches the receiver refused (aggregated: one event per reason and
 * signal per window, `count` batches in it). `signal` is `null` when the path did not name one.
 */
export const TelemetryBatchRejectedPayloadSchema = z.strictObject({
  reason: z.enum(TELEMETRY_BATCH_REJECT_REASONS),
  signal: z.enum(TELEMETRY_SIGNALS).nullable(),
  count: z.int().min(1),
});

/**
 * `telemetry.redacted`: what the redaction removed in the last minute (aggregated). `names` are
 * attribute names (never values), sorted and capped; `count` is how many values were replaced.
 */
export const TelemetryRedactedPayloadSchema = z.strictObject({
  mode: z.enum(['default', 'full']),
  count: z.int().min(1),
  records: z.int().min(1),
  names: z.array(z.string().min(1).max(128)).max(64),
});
