// SPDX-License-Identifier: MPL-2.0
import { EventEnvelopeSchema, EventTypeSchema, type EventEnvelope } from '@otheater/core';
import { z } from 'zod';
import { DaemonIdSchema, ScenarioIdSchema, type DaemonId } from './ids.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * Event stream (architecture 5.12, P4 of the plan docs/17): `GET /v1/events` as Server-Sent
 * Events. First the history after the cursor, then the live events, with no gap and no repeat.
 */

/** Cursor of a reconnection. It wins over the `since` parameter. */
export const LAST_EVENT_ID_HEADER = 'Last-Event-ID';

export const SSE_CONTENT_TYPE = 'text/event-stream';

/** A parameter that may come once or repeated (`?scenario=S1&scenario=S2`). [proposta] */
function listParam<Item extends z.ZodType>(item: Item) {
  return z.union([item, z.array(item).min(1)]).optional();
}

/** One value or a list, as a list. */
export function queryList<Item>(value: Item | readonly Item[] | undefined): Item[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly Item[])] : [value as Item];
}

/** A type filter: a prefix of the event types (`play.`, `quota.`) or a whole type (`play.created`). */
export const EventTypePrefixSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/);

export const EventStreamQuerySchema = z.strictObject({
  /** Only the events of these scenarios. Without it: all of them. */
  scenario: listParam(ScenarioIdSchema),
  /** Only the events whose type starts with one of these prefixes. Without it: all of them. */
  types: listParam(EventTypePrefixSchema),
  /**
   * Cursor: the id of the last event the client has (the stream starts after it). Without it and
   * without `Last-Event-ID`, the stream starts at the newest event, with no history. The cursor
   * is always the global id of the log, filtered or not.
   */
  since: z.coerce.number().int().min(0).optional(),
});
export type EventStreamQuery = z.input<typeof EventStreamQuerySchema>;

/** Request headers of the stream, keyed by the lower-case name. */
export const EventStreamHeadersSchema = z.looseObject({
  'last-event-id': z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .optional(),
});

/** An event as the API shows it: the stored envelope plus the daemon that holds the log. */
export const ApiEventEnvelopeSchema = EventEnvelopeSchema.extend({ daemonId: DaemonIdSchema });
export type ApiEventEnvelope = z.infer<typeof ApiEventEnvelopeSchema>;

/**
 * One message of the stream, as the fields of the SSE frame: `id` is the id of the log as a
 * string (what the browser sends back in `Last-Event-ID`), `event` is the type, and `data` is the
 * envelope (serialised as JSON in the `data:` line).
 */
export const ApiSseMessageSchema = z
  .strictObject({
    id: z.string().regex(/^[1-9]\d*$/),
    event: EventTypeSchema,
    data: ApiEventEnvelopeSchema,
  })
  .refine((message) => message.id === String(message.data.id), {
    message: 'id must be the id of the event',
    path: ['id'],
  })
  .refine((message) => message.event === message.data.type, {
    message: 'event must be the type of the event',
    path: ['event'],
  });
export type ApiSseMessage = z.infer<typeof ApiSseMessageSchema>;

/** The stream message of a stored event. */
export function sseMessageOf(envelope: EventEnvelope, daemonId: DaemonId): ApiSseMessage {
  return {
    id: String(envelope.id),
    event: envelope.type,
    data: { ...envelope, daemonId },
  };
}

export const streamEvents = defineRoute({
  id: 'streamEvents',
  method: 'GET',
  path: '/v1/events',
  kind: 'sse',
  summary: 'Event stream with resume by Last-Event-ID: history after the cursor, then live',
  query: EventStreamQuerySchema,
  headers: EventStreamHeadersSchema,
  response: ApiSseMessageSchema,
  // Too many open streams: 503 with Retry-After.
  errors: ['unavailable'],
});

export const EVENT_ROUTES = defineRoutes(streamEvents);
