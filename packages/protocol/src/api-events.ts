// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { DaemonIdSchema } from './api/ids.js';

/**
 * Payloads of the `api.started`, `api.client_rejected` (Phase 6, P3 of docs/17) and `api.stream_lagged`
 * (P4) events.
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. Every payload is a
 * strict object. Neither one ever carries the token, the value a client sent (a token, a `Host`, an
 * `Origin`) or a path of the secret list.
 */

/**
 * Why the daemon turned a request away before any route ran. `ticket` (P7): the chat socket came
 * without a valid ticket (missing, used, expired or of another scenario); `message` (P7): a chat
 * message the daemon could not take (not JSON, not in the contract, too big).
 */
export const API_REJECTION_REASONS = ['token', 'host', 'origin', 'ticket', 'message'] as const;
export const ApiRejectionReasonSchema = z.enum(API_REJECTION_REASONS);
export type ApiRejectionReason = z.infer<typeof ApiRejectionReasonSchema>;

/**
 * `api.started`: the API server is listening. `url` is the base URL (`http://127.0.0.1:<port>`),
 * never with the token in it. `tokenMode` is `api.token` (`persistent` or `per_start`).
 */
export const ApiStartedPayloadSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  daemonId: DaemonIdSchema,
  tokenMode: z.enum(['persistent', 'per_start']),
});

/**
 * `api.client_rejected`: a request was refused with 401 (`reason: token`) or 403 (`host`, `origin`).
 * [proposta] Rate-limited per reason: after one event the next one of the same reason waits for a
 * window to pass, and `suppressed` counts the rejections of that reason the daemon did not write
 * as events in between (they still count in the log). The request line is not in the payload.
 */
export const ApiClientRejectedPayloadSchema = z.strictObject({
  reason: ApiRejectionReasonSchema,
  suppressed: z.int().min(0),
});

/**
 * Why an event stream (`GET /v1/events`) fell behind the live events. [proposta] `buffer_overflow`:
 * the subscriber left more live events unseen than `api.sse.buffer_events` allows, and it catches up
 * from the log. `backpressure`: the client stopped reading its socket, so the daemon holds the writes
 * until it reads again (and the events wait in the log, not in memory).
 */
export const API_STREAM_LAG_REASONS = ['buffer_overflow', 'backpressure'] as const;
export const ApiStreamLagReasonSchema = z.enum(API_STREAM_LAG_REASONS);
export type ApiStreamLagReason = z.infer<typeof ApiStreamLagReasonSchema>;

/**
 * `api.stream_lagged`: a client of the event stream is slow. It stays in the stream and loses no
 * event: it reads the history from the log. [proposta] `behind` is the size of the delay in events:
 * the live events left unseen (`buffer_overflow`) or the ids between the last one sent and the end
 * of the log (`backpressure`). Rate-limited per reason like `api.client_rejected`: `suppressed`
 * counts the episodes of that reason the daemon did not write as events in between. The payload
 * never says who the client is.
 */
export const ApiStreamLaggedPayloadSchema = z.strictObject({
  reason: ApiStreamLagReasonSchema,
  behind: z.int().min(0),
  suppressed: z.int().min(0),
});
