// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events the chat WebSocket needs so that each message of the daemon has an event
 * of its own (Phase 6, P7 of docs/17). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at
 * `schemaVersion` 1. [proposta] Every payload is a strict object. The scenario and the play are in
 * the envelope (`scenarioId`, `playId`), as for the other events of a scenario.
 */

/** Who put a prompt in the single queue (`PromptOrigin` of the core). */
export const PROMPT_QUEUE_SOURCES = ['producer', 'director', 'daemon', 'schedule'] as const;

/**
 * `prompt.queued`: a prompt entered the single prompt queue of the Director (architecture 5.4,
 * 5.21). The text is not in the payload (the store of the queue keeps it): the log says that and
 * when a message was queued, with which priority and by whom.
 */
export const PromptQueuedPayloadSchema = z.strictObject({
  promptId: z.string().min(1),
  source: z.enum(PROMPT_QUEUE_SOURCES),
  priority: z.int(),
});

/**
 * `chat.director_reply`: the Director ended a turn and what it said is a reply for the chat.
 * `replyId` is the `seq` of the reply of the scenario (1, 2, 3...); `to` is who put the prompt
 * the reply answers in the queue. The reply goes whole, so the WebSocket message has
 * `final: true`.
 */
export const ChatDirectorReplyPayloadSchema = z.strictObject({
  replyId: z.int().min(1),
  to: z.enum(PROMPT_QUEUE_SOURCES),
  text: z.string(),
});

/**
 * `chat.ask`: a decision the Producer has to answer was created (a question of the Director, the
 * menu of a play, an effect the start-up could not settle, a group of ideas). The play is in the
 * envelope. `input` is what the decision carries (`DecisionRecord.input`).
 */
export const ChatAskPayloadSchema = z.strictObject({
  decisionId: z.string().min(1),
  kind: z.string().min(1),
  input: z.record(z.string(), z.json()),
});

/** How a decision the chat asked the Producer about ended (`DecisionState` without `pending`). */
export const CHAT_ASK_CLOSED_STATES = ['decided', 'cancelled'] as const;

/**
 * `chat.ask_closed`: a decision announced by `chat.ask` is not pending any more, because somebody
 * answered it (the socket of another client, the REST route, the Director...) or it was cancelled
 * (N179, item 2). The chat takes the question back from the clients that still show it. [proposta]
 * The answer is not in the payload: it stays in the decision record. The play is in the envelope.
 */
export const ChatAskClosedPayloadSchema = z.strictObject({
  decisionId: z.string().min(1),
  kind: z.string().min(1),
  state: z.enum(CHAT_ASK_CLOSED_STATES),
});

/**
 * Why the daemon closed a chat WebSocket (or the client went away). `feed_failed` is the feed of
 * events that broke while the socket was open ([proposta], P7): the socket ends with 1011 and the
 * client reconnects with `resume`, so nothing is lost.
 */
export const CHAT_CLOSE_REASONS = [
  'daemon_stop',
  'token_rotated',
  'no_pong',
  'client_closed',
  'protocol_error',
  'feed_failed',
] as const;

/**
 * `api.chat_closed`: a chat socket ended. `reason` says why; `code` is the WebSocket close code
 * the daemon sent or got. The ticket and the token never appear. The scenario is in the envelope.
 */
export const ApiChatClosedPayloadSchema = z.strictObject({
  reason: z.enum(CHAT_CLOSE_REASONS),
  code: z.int().min(1000).max(4999).nullable(),
});

/**
 * Why a chat socket did not send the message of an event: `unfit` when the event does not fit
 * its chat message (a payload that does not parse), `prepare_failed` when building or sending
 * the message threw. [proposta]
 */
export const CHAT_DROP_REASONS = ['unfit', 'prepare_failed'] as const;

/**
 * `api.chat_message_dropped`: a chat socket skipped the message of an event, so the situation is
 * not only in the log. `eventId` and `eventType` name the event when it is known; the error text
 * stays in the log. The scenario is in the envelope. [proposta]
 */
export const ApiChatMessageDroppedPayloadSchema = z.strictObject({
  reason: z.enum(CHAT_DROP_REASONS),
  eventId: z.int().min(1).nullable(),
  eventType: z.string().min(1).nullable(),
});
