// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { IdeaQueueHeldPayloadSchema } from '../idea-events.js';
import { ScenarioSystemMessagePayloadSchema } from '../scenario-events.js';
import { ApiErrorBodySchema } from './errors.js';
import { ScenarioIdSchema } from './ids.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * Chat of the Producer with the Orchestrator over a WebSocket (architecture 5.4 and 5.12, P7 of
 * the plan docs/17). It replaces the polling channel of N78 (`channel-http.ts`): the same things
 * the six routes and `poll` exchange, in both directions, as a discriminated union by `type`.
 * The attachment itself goes by REST; the message carries only the ids of attachments already
 * sent. [proposta] Every message shape of this file is a proposal of the plan.
 */

/** How long a chat ticket lives, in milliseconds. */
export const CHAT_TICKET_TTL_MS = 30_000;

/** Header-less authentication of the socket: the ticket goes in the `ticket` query parameter. */
export const CHAT_TICKET_PARAM = 'ticket';

const DecisionIdSchema = z.string().min(1);
const AnswerSchema = z.record(z.string(), z.json());

/** What the client sends. */
export const ChatClientMessageSchema = z.discriminatedUnion('type', [
  /** A message for the Director. It goes in the single prompt queue with the Producer's source. */
  z.strictObject({
    type: z.literal('message'),
    text: z.string(),
    /** Ids of attachments already sent by REST. */
    attachments: z.array(z.string().min(1)).optional(),
  }),
  /** The answer to a pending decision (a question of the Director, or a menu). */
  z.strictObject({
    type: z.literal('answer'),
    decisionId: DecisionIdSchema,
    answer: AnswerSchema,
  }),
  /** A command typed with a slash (`/idea add ...`). The daemon parses it; the line goes as typed. */
  z.strictObject({
    type: z.literal('command'),
    text: z.string().regex(/^\//),
  }),
  /**
   * After a reconnection: the id of the last event the client got. The daemon sends again what
   * came after it, as the event stream does.
   */
  z.strictObject({
    type: z.literal('resume'),
    lastEventId: z.int().min(0),
  }),
]);
export type ChatClientMessage = z.infer<typeof ChatClientMessageSchema>;

/** What a play is waiting for an Executor on, as the chat shows it (`waits` of the old poll). */
export const ChatWaitSchema = z.strictObject({
  role: z.string().min(1),
  playId: z.string().min(1).nullable(),
  demandId: z.string().min(1).nullable(),
  on: z.array(z.strictObject({ profile: z.string().min(1), reason: z.string().min(1) })),
  /** The earliest known end, epoch milliseconds, or `null`. */
  until: z.int().min(0).nullable(),
});
export type ChatWait = z.infer<typeof ChatWaitSchema>;

/**
 * `eventId` of every message of the daemon but `error`: the id of the event of the log that
 * produced it, so the client keeps one cursor for the stream and the chat.
 */
const eventId = z.int().min(1);

/** What the daemon sends. */
export const ChatServerMessageSchema = z.discriminatedUnion('type', [
  /** A reply of the Director: whole (`final` at once) or in parts, the last one with `final`. */
  z.strictObject({
    type: z.literal('director_reply'),
    eventId,
    /** The turn this reply belongs to: parts of one reply share it. */
    replyId: z.int().min(1),
    text: z.string(),
    final: z.boolean(),
  }),
  /** A question or a menu waiting for the Producer's answer. */
  z.strictObject({
    type: z.literal('ask'),
    eventId,
    decisionId: DecisionIdSchema,
    /** `producer_question`, `producer_menu`, or another kind the daemon adds. */
    kind: z.string().min(1),
    playId: z.string().min(1).nullable(),
    input: AnswerSchema,
  }),
  /** A message of the daemon itself (the reconciliation of the start-up, a handoff, a wait...). */
  z.strictObject({
    type: z.literal('system'),
    eventId,
    message: ScenarioSystemMessagePayloadSchema,
  }),
  /** The idea queue stopped and why (architecture 5.20). */
  z.strictObject({
    type: z.literal('queue_held'),
    eventId,
    held: IdeaQueueHeldPayloadSchema,
  }),
  /** A play of the scenario changed state. */
  z.strictObject({
    type: z.literal('play_state'),
    eventId,
    playId: z.string().min(1),
    state: z.string().min(1),
  }),
  /** What waits for an Executor now: the state of the moment, sent again when it changes. */
  z.strictObject({
    type: z.literal('waits'),
    eventId,
    waits: z.array(ChatWaitSchema),
  }),
  /** Whether something is still going on that the Producer does not have to answer. */
  z.strictObject({
    type: z.literal('busy'),
    eventId,
    busy: z.boolean(),
  }),
  /**
   * A message of the client the daemon refused, or a failure of the socket. `eventId` is `null`
   * because no event of the log produced it.
   */
  z.strictObject({
    type: z.literal('error'),
    eventId: z.null(),
    error: ApiErrorBodySchema,
  }),
]);
export type ChatServerMessage = z.infer<typeof ChatServerMessageSchema>;

/** The `type`s a message may have, per direction. */
export const CHAT_CLIENT_MESSAGE_TYPES = ChatClientMessageSchema.options.map(
  (option) => option.shape.type.value,
);
export const CHAT_SERVER_MESSAGE_TYPES = ChatServerMessageSchema.options.map(
  (option) => option.shape.type.value,
);

/**
 * A ticket for the socket. The browser cannot set `Authorization` on a WebSocket, and the token
 * must never travel in a URL, so the client trades the token for a ticket that works once, for
 * one scenario, for {@link CHAT_TICKET_TTL_MS}.
 */
export const ChatTicketRequestSchema = z.strictObject({ scenarioId: ScenarioIdSchema });
export const ChatTicketSchema = z.strictObject({
  ticket: z.string().min(16).max(256),
  /** Milliseconds the ticket is good for, from the answer. */
  expiresInMs: z.int().min(1),
});
export type ChatTicket = z.infer<typeof ChatTicketSchema>;

export const createChatTicket = defineRoute({
  id: 'createChatTicket',
  method: 'POST',
  path: '/v1/chat-tickets',
  summary: 'One-use ticket to open the chat socket of a scenario (valid for 30 s)',
  body: ChatTicketRequestSchema,
  response: ChatTicketSchema,
  errors: ['not_found', 'recovering'],
});

export const openChatSocket = defineRoute({
  id: 'openChatSocket',
  method: 'GET',
  path: '/v1/scenarios/:id/chat',
  kind: 'websocket',
  summary: 'WebSocket of the chat with the Director; authenticated by a ticket, not by the token',
  params: z.strictObject({ id: ScenarioIdSchema }),
  query: z.strictObject({ [CHAT_TICKET_PARAM]: ChatTicketSchema.shape.ticket }),
  response: ChatServerMessageSchema,
  clientMessage: ChatClientMessageSchema,
  errors: ['not_found'],
});

export const CHAT_ROUTES = defineRoutes(createChatTicket, openChatSocket);
