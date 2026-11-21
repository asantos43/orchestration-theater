// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { PlayParamsSchema } from './plays.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The two reads the telemetry panels of the Usage tab need (Phase 8, P10; architecture 5.13).
 * [proposta] Both are minimal: nothing in the API showed the spans of a play or the state of the
 * telemetry, and both only read what the daemon already keeps (the spans in the telemetry base and
 * the counters the receiver and the exporter already hold). Neither records an event, and neither
 * carries a record of the clients: only the spans the daemon itself made, and counts.
 */

/**
 * What a span of the tree is, from its name and attributes: the play, a stage (a visit of a state
 * of the machine), an attempt, the session of an attempt, a tool call, or a wait. `other` is a span
 * the daemon made that the tree does not know yet (a later convention): it is listed, not dropped.
 */
export const PLAY_SPAN_KINDS = [
  'play',
  'stage',
  'attempt',
  'session',
  'tool',
  'wait',
  'other',
] as const;
export type PlaySpanKind = (typeof PLAY_SPAN_KINDS)[number];

export const PlaySpanStatusSchema = z.enum(['unset', 'ok', 'error']);

/** One span of the tree of a play, in depth-first order (a parent, then its children by start). */
export const PlaySpanSchema = z.strictObject({
  spanId: z.string().min(1),
  /** `null` for a root; also for a span whose parent is not in the base (it was not closed yet). */
  parentSpanId: z.string().nullable(),
  kind: z.enum(PLAY_SPAN_KINDS),
  /** 0 for a root. */
  depth: z.int().min(0),
  /** The state (stage), the role (attempt, session), the tool or the kind of wait; empty if none. */
  label: z.string(),
  /** What qualifies the label: `<client>/<profile>`, the outcome of a tool or of a wait; or `null`. */
  detail: z.string().nullable(),
  /** Epoch milliseconds. */
  startMs: z.number().min(0),
  durationMs: z.number().min(0),
  status: PlaySpanStatusSchema,
  attemptId: z.string().nullable(),
});
export type PlaySpan = z.infer<typeof PlaySpanSchema>;

export const PlaySpansSchema = z.strictObject({
  playId: z.string().min(1),
  spans: z.array(PlaySpanSchema),
  /**
   * False while the play runs: the daemon writes a span when it closes, so the span of the play
   * (and of whatever is still open) is not in the base yet and the tree lists what is over.
   */
  playClosed: z.boolean(),
  /** True when the base had more spans than `limit` and the oldest ones are listed. */
  truncated: z.boolean(),
});
export type PlaySpans = z.infer<typeof PlaySpansSchema>;

export const GetPlaySpansQuerySchema = z.strictObject({
  /** The most spans read (default 2000). */
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
export type GetPlaySpansQuery = z.input<typeof GetPlaySpansQuerySchema>;

export const getPlaySpans = defineRoute({
  id: 'getPlaySpans',
  method: 'GET',
  path: '/v1/plays/:playId/spans',
  summary:
    'The spans the daemon made for a play (stages, attempts, sessions, tool calls, waits) as a tree with the durations',
  params: PlayParamsSchema,
  query: GetPlaySpansQuerySchema,
  response: PlaySpansSchema,
  errors: ['not_found', 'unavailable'],
});

/** What `telemetry.export` is set to (the same list as the daemon's key). */
export const TELEMETRY_STATUS_EXPORT_MODES = ['off', 'otlp', 'prometheus', 'both'] as const;

/**
 * Why there is (or is not) a receiver: `on` (the base is open and the receiver listens), `off`
 * (`telemetry.enabled` is off), `no_base` (on, but the telemetry base could not be opened) or
 * `no_receiver` (the base is open, the receiver could not listen: the clients send nothing).
 */
export const TELEMETRY_STATUS_STATES = ['on', 'off', 'no_base', 'no_receiver'] as const;

const countSchema = z.int().min(0);

export const TelemetryStatusSchema = z.strictObject({
  state: z.enum(TELEMETRY_STATUS_STATES),
  /** The spans of the daemon itself (`telemetry.daemon_spans`). */
  daemonSpans: z.boolean(),
  /** The OTLP receiver (P2); `null` unless `state` is `on`. Counts are since the daemon started. */
  receiver: z
    .strictObject({
      port: z.int().min(1).max(65535),
      /** Batches taken, by signal. */
      accepted: z.strictObject({ traces: countSchema, metrics: countSchema, logs: countSchema }),
      /** Batches refused, by reason (`format`, `size`, `token`). */
      rejected: z.strictObject({ format: countSchema, size: countSchema, token: countSchema }),
    })
    .nullable(),
  /** The telemetry base (its health); `null` when there is none. */
  base: z
    .strictObject({
      state: z.enum(['ok', 'degraded', 'no_base']),
      queued: countSchema,
      written: countSchema,
      /** Dropped from a full queue (the oldest go first). */
      droppedOverflow: countSchema,
      /** Discarded because there was no base or a write failed for good. */
      discarded: countSchema,
      resets: countSchema,
      fileBytes: z.number().min(0).nullable(),
    })
    .nullable(),
  /** What leaves the daemon (P7). */
  export: z.strictObject({
    mode: z.enum(TELEMETRY_STATUS_EXPORT_MODES),
    /** The OTLP exporter; `null` when it is not running. `destination` is scheme, host and port only. */
    otlp: z
      .strictObject({
        destination: z.string(),
        exported: countSchema,
        /** Records dropped after the retries, by reason. */
        dropped: z.record(z.string(), countSchema),
      })
      .nullable(),
    /** `GET /metrics` is served. */
    prometheus: z.boolean(),
  }),
});
export type TelemetryStatus = z.infer<typeof TelemetryStatusSchema>;

export const getTelemetryStatus = defineRoute({
  id: 'getTelemetryStatus',
  method: 'GET',
  path: '/v1/telemetry',
  summary:
    'The state of the telemetry: the OTLP receiver and its refused batches, the base, and the export with its drops',
  response: TelemetryStatusSchema,
});

export const TELEMETRY_ROUTES = defineRoutes(getPlaySpans, getTelemetryStatus);
