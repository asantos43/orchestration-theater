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

/**
 * Why a batch was not taken: the destination did not answer (`unreachable`, `timeout`), answered
 * with a server error (`server_error`), refused the credentials (`unauthorized`) or the batch
 * (`rejected`), a header secret was not in the vault (`secret_missing`, nothing was sent), or the
 * telemetry base could not be read (`store_unavailable`).
 */
export const TELEMETRY_EXPORT_FAILURE_REASONS = [
  'unreachable',
  'timeout',
  'server_error',
  'unauthorized',
  'rejected',
  'secret_missing',
  'store_unavailable',
] as const;
export type TelemetryExportFailureReason = (typeof TELEMETRY_EXPORT_FAILURE_REASONS)[number];

/**
 * Payload of `telemetry.export_failed` (Phase 8, P7, N70; architecture 5.11): the OTLP exporter
 * could not deliver a batch to `telemetry.otlp.endpoint` after its retries. Aggregated: one event
 * per signal and reason per window (`telemetry.otlp.failure_report`), `count` records and `batches`
 * batches in it. Strict, with no telemetry content, no header and no secret: `destination` is the
 * scheme, host and port of the endpoint (never its path, query or user info). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. [proposta] The name and the fields.
 */
export const TelemetryExportFailedPayloadSchema = z.strictObject({
  destination: z.string().min(1).max(256),
  signal: z.enum(TELEMETRY_SIGNALS),
  reason: z.enum(TELEMETRY_EXPORT_FAILURE_REASONS),
  /** The HTTP status of the last answer, or `null` when there was none. */
  status: z.int().min(100).max(599).nullable(),
  /** Records the failed batches held. */
  count: z.int().min(1),
  batches: z.int().min(1),
  /** `drop`: the batches were dropped. `hold`: they stay in the base and are tried again. */
  mode: z.enum(['drop', 'hold']),
});

/** What decided a purge: the age (`telemetry.retention.days`), the size (`telemetry.retention.max_mb`) or both. */
export const TELEMETRY_PURGE_REASONS = ['age', 'size', 'age_and_size'] as const;
export type TelemetryPurgeReason = (typeof TELEMETRY_PURGE_REASONS)[number];

/**
 * Payload of `telemetry.purged` (Phase 8, P8, N216 (a); architecture 5.11): the purge of the raw
 * telemetry removed rows from the telemetry base. Written only when something went (a pass that
 * finds nothing past the limits says nothing). Strict, with no telemetry content. Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. [proposta] The name and the fields.
 *
 * - `spans`, `metrics` and `logs`: the rows removed of each signal; `rows` is their sum;
 * - `bytes`: the bytes of data the base freed (pages in use before minus after); `fileBytes`: the
 *   size of the file after the pass (it only shrinks when the file was compacted: `compacted`);
 * - `fromMs` and `untilMs`: the period removed, as epoch milliseconds: from the oldest record that
 *   was in the base to the cut (exclusive). `fromMs` is `null` when the base could not say;
 * - `readyThrough`: the last day the daily aggregates cover (the purge never goes past the end of
 *   it, unless `telemetry.retention.guard` is `none`), or `null` when there is none.
 */
export const TelemetryPurgedPayloadSchema = z.strictObject({
  reason: z.enum(TELEMETRY_PURGE_REASONS),
  rows: z.int().min(1),
  spans: z.int().min(0),
  metrics: z.int().min(0),
  logs: z.int().min(0),
  bytes: z.int().min(0),
  fileBytes: z.int().min(0).nullable(),
  compacted: z.boolean(),
  fromMs: z.int().min(0).nullable(),
  untilMs: z.int().min(0),
  readyThrough: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .nullable(),
});
