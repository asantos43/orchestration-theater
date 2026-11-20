// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { DaemonIdSchema } from './api/ids.js';

/**
 * Payloads of the `api.started` and `api.client_rejected` events (Phase 6, P3 of docs/17).
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
