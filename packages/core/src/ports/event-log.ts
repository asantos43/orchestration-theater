// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { InvalidInput } from '../errors.js';

/** Semver of the `EventLog` port contract. */
export const EVENT_LOG_PORT_VERSION = '0.1.0';

/**
 * Event type: lowercase dotted name in English, at least two segments (`play.created`,
 * `session.update`, `plugin.my-tool.finished`). Which types exist, and the schema of each payload,
 * belongs to the event-type registry (architecture 5.18, "Registros"), not to this port.
 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

export const EventTypeSchema = z.string().max(128).regex(EVENT_TYPE_PATTERN);

/** JSON value (zod's own `z.json()` shape): what can cross the SQLite and wire boundaries. */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

const nonEmpty = z.string().min(1).max(256);

/** An event as the caller hands it to `append`. The log assigns `id` and `timestamp`. */
export const NewEventSchema = z.strictObject({
  type: EventTypeSchema,
  /**
   * Version of the payload schema of this `type`, so old rows stay readable after the schema
   * changes. Starts at 1.
   */
  schemaVersion: z.int().min(1),
  /** Always a JSON object (never a bare scalar or array), so fields can be added later. */
  payload: z.record(z.string(), JsonValueSchema),
  // [proposta] optional correlation ids, mirroring the columns of the `events` table (section 7:
  // "scenario/play/attempt"). The domain ids are plain opaque strings at this stage.
  scenarioId: nonEmpty.optional(),
  playId: nonEmpty.optional(),
  attemptId: nonEmpty.optional(),
});
export type NewEvent = z.infer<typeof NewEventSchema>;

/** A stored event. */
export const EventEnvelopeSchema = NewEventSchema.extend({
  /** Strictly increasing, starts at 1. See {@link EventLog} for what is and is not guaranteed. */
  id: z.int().min(1),
  /** Epoch milliseconds, read from the `Clock` when the event was appended. */
  timestamp: z.int().min(0),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/**
 * Append-only log of events with increasing ids (P6: everything is an event).
 * The default adapter is the `events` table of the `Store` (architecture 5.18).
 *
 * Contract (checked by `describeEventLogConformance` in `@otheater/sdk`):
 * - `append` validates the input with {@link NewEventSchema}; an invalid event rejects with
 *   `InvalidInput` and nothing is stored. It returns the stored envelope.
 * - Ids are **strictly increasing** in commit order and an id is never reused once committed.
 *   They are **not guaranteed gapless** (a rolled-back write or a crash may skip numbers), so a
 *   consumer keeps a cursor (the last id it processed) and never assumes `id === previous + 1`.
 * - Visibility follows id order: a reader that sees id N sees every committed id below N.
 *   Uncommitted events are invisible to everyone outside the transaction that wrote them.
 * - Timestamps come from the adapter's `Clock`; they are not guaranteed increasing with ids.
 * - Events are immutable and never deleted by this port. What it returns is a copy: changing it
 *   does not change the log.
 * - A closed store rejects with `AdapterUnavailable`.
 */
export interface EventLog {
  append(event: NewEvent): Promise<EventEnvelope>;

  /**
   * Events with `id > afterId`, ascending, at most `limit`. Use the id of the last event received
   * as the next `afterId`; `0` reads from the start. `afterId` must be an integer >= 0 and `limit`
   * an integer >= 1, else `InvalidInput`. An empty result means "nothing newer yet".
   */
  readFrom(afterId: number, limit: number): Promise<readonly EventEnvelope[]>;

  /** Id of the newest committed event, or `0` when the log is empty. */
  lastId(): Promise<number>;
}

/** Validates the input of `append`; throws `InvalidInput` (cause: the `ZodError`). */
export function parseNewEvent(input: unknown): NewEvent {
  const result = NewEventSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidInput(`Invalid event: ${z.prettifyError(result.error)}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/** Validates the arguments of `readFrom`; throws `InvalidInput`. For adapter authors. */
export function assertReadFromArgs(afterId: number, limit: number): void {
  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new InvalidInput(`afterId must be an integer >= 0, got ${String(afterId)}`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new InvalidInput(`limit must be an integer >= 1, got ${String(limit)}`);
  }
}
