// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import {
  DIRECT_PROMOTE_TARGETS,
  DIRECT_TEXT_MAX,
  DIRECT_WORK_OUTCOMES,
  DIRECT_WORKSPACES,
} from '../direct-events.js';
import { IdempotencyHeadersSchema } from './page.js';
import { defineRoute, defineRoutes } from './route.js';
import { ScenarioParamsSchema } from './scenarios.js';

/**
 * The direct session with an Actor (Phase 7, P19; N44, N190; architecture 5.20). [proposta] The
 * Producer talks to one Executor of the profile list without the Director in between, in a tab of
 * the scenario. The daemon holds the session; a client opens it, writes, runs a command of the
 * client, stops a turn, closes it and promotes its result. What happens is in the event log
 * (`direct.session.*`) and in the answer of `getDirectSession`, which carries the conversation so a
 * client that arrives late draws it whole.
 */

export const DIRECT_SESSION_STATES = ['idle', 'running', 'closed'] as const;
export type DirectSessionState = (typeof DIRECT_SESSION_STATES)[number];

const toolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);

/** One line of the conversation of a session. The Actor's text grows in place while `streaming`. */
export const ApiDirectItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('message'),
    from: z.enum(['producer', 'actor']),
    turn: z.int().min(1),
    at: z.int().min(0),
    text: z.string(),
    /** The Actor is still writing this message. */
    streaming: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('tool'),
    turn: z.int().min(1),
    at: z.int().min(0),
    toolCallId: z.string().min(1),
    title: z.string(),
    status: toolStatus,
  }),
  z.strictObject({
    kind: z.literal('decision'),
    turn: z.int().min(0),
    at: z.int().min(0),
    title: z.string(),
    answered: z.enum(['allow', 'reject', 'cancelled']),
    rule: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('command'),
    turn: z.int().min(1),
    at: z.int().min(0),
    command: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('notice'),
    turn: z.int().min(0),
    at: z.int().min(0),
    level: z.enum(['warning', 'error']),
    text: z.string(),
  }),
]);
export type ApiDirectItem = z.infer<typeof ApiDirectItemSchema>;

/** A command of the client the session announced (`/claude:compact`), filtered by `chat.client_commands`. */
export const ApiDirectCommandSchema = z.strictObject({
  /** `claude:compact`. */
  id: z.string().min(1),
  /** What the Producer types: `/claude:compact`. */
  name: z.string().regex(/^\//),
  description: z.string(),
  args: z.string(),
});
export type ApiDirectCommand = z.infer<typeof ApiDirectCommandSchema>;

export const ApiDirectSessionSchema = z.strictObject({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  /** The Executor the Producer chose (`executors.<id>`). */
  executor: z.string().min(1),
  /** `<client>/<profile>`. */
  profile: z.string().min(1),
  client: z.string().min(1),
  model: z.string().min(1).nullable(),
  workspace: z.enum(DIRECT_WORKSPACES),
  /** The own branch of a `worktree` session; null for the others. */
  branch: z.string().min(1).nullable(),
  state: z.enum(DIRECT_SESSION_STATES),
  /** The number of the last turn; 0 before the first. */
  turns: z.int().min(0),
  openedAt: z.int().min(0),
  lastActivityAt: z.int().min(0),
  /** Set when the session is closed. */
  closedAt: z.int().min(0).nullable(),
  /** The commands of the client that the Producer may run now. */
  commands: z.array(ApiDirectCommandSchema),
});
export type ApiDirectSession = z.infer<typeof ApiDirectSessionSchema>;

export const ApiDirectSessionDetailSchema = ApiDirectSessionSchema.extend({
  /** The conversation, oldest first, cut to `direct_session.history_max` items. */
  items: z.array(ApiDirectItemSchema),
});
export type ApiDirectSessionDetail = z.infer<typeof ApiDirectSessionDetailSchema>;

const SessionParamsSchema = z.strictObject({ sessionId: z.string().min(1).max(64) });
const directErrors = ['not_found', 'conflict', 'unavailable'] as const;

/**
 * Opens a session. `executor` is the id of an Executor of the list of the Actor (`GET /v1/executors`);
 * absent, the first that can take it. `workspace` overrides `direct_session.workspace` for this
 * session. `confirm` answers the question of `workspace: scenario` (see {@link OpenDirectResultSchema}).
 */
export const OpenDirectBodySchema = z.strictObject({
  executor: z.string().min(1).max(256).optional(),
  workspace: z.enum(DIRECT_WORKSPACES).optional(),
  confirm: z.boolean().optional(),
});
export type OpenDirectBody = z.input<typeof OpenDirectBodySchema>;

/**
 * `opened`: the session is open (`session`). `confirm`: nothing happened, because a session that
 * writes in the folder of the scenario asks for the Producer's confirmation; send the same body
 * again with `confirm: true`.
 */
export const OpenDirectResultSchema = z.strictObject({
  status: z.enum(['opened', 'confirm']),
  workspace: z.enum(DIRECT_WORKSPACES),
  session: ApiDirectSessionDetailSchema.optional(),
});
export type OpenDirectResult = z.infer<typeof OpenDirectResultSchema>;

export const openDirectSession = defineRoute({
  id: 'openDirectSession',
  method: 'POST',
  path: '/v1/scenarios/:scenarioId/direct',
  summary:
    'Opens a direct session with an Actor of the scenario; 429 when the profile has no quota or money, 409 at the limit of open sessions; idempotent by Idempotency-Key',
  params: ScenarioParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: OpenDirectBodySchema,
  response: OpenDirectResultSchema,
  errors: [...directErrors, 'quota_exhausted'],
});

export const ListDirectResultSchema = z.strictObject({
  sessions: z.array(ApiDirectSessionSchema),
});
export type ListDirectResult = z.infer<typeof ListDirectResultSchema>;

export const listDirectSessions = defineRoute({
  id: 'listDirectSessions',
  method: 'GET',
  path: '/v1/scenarios/:scenarioId/direct',
  summary: 'The direct sessions of a scenario (open ones, then the last closed), newest first',
  params: ScenarioParamsSchema,
  response: ListDirectResultSchema,
  errors: ['not_found', 'unavailable'],
});

export const getDirectSession = defineRoute({
  id: 'getDirectSession',
  method: 'GET',
  path: '/v1/direct/:sessionId',
  summary: 'One direct session with its conversation',
  params: SessionParamsSchema,
  response: ApiDirectSessionDetailSchema,
  errors: ['not_found', 'unavailable'],
});

export const DirectMessageBodySchema = z.strictObject({
  text: z.string().min(1).max(DIRECT_TEXT_MAX),
});
export type DirectMessageBody = z.input<typeof DirectMessageBodySchema>;

/** The turn the message started; it runs on and its end is told by the events. */
export const DirectTurnResultSchema = z.strictObject({ turn: z.int().min(1) });
export type DirectTurnResult = z.infer<typeof DirectTurnResultSchema>;

export const sendDirectMessage = defineRoute({
  id: 'sendDirectMessage',
  method: 'POST',
  path: '/v1/direct/:sessionId/messages',
  summary:
    'Writes to the Actor of a direct session and starts a turn; 409 while a turn runs; idempotent by Idempotency-Key',
  params: SessionParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: DirectMessageBodySchema,
  response: DirectTurnResultSchema,
  errors: directErrors,
});

export const DirectCommandBodySchema = z.strictObject({
  /** The line with the slash, as the Producer typed it: `/claude:compact keep the tests`. */
  text: z.string().regex(/^\/\S/).max(DIRECT_TEXT_MAX),
});
export type DirectCommandBody = z.input<typeof DirectCommandBodySchema>;

export const runDirectCommand = defineRoute({
  id: 'runDirectCommand',
  method: 'POST',
  path: '/v1/direct/:sessionId/commands',
  summary:
    'Runs a command of the client in a direct session (`chat.client_commands` and `chat.slash_access` apply); 403 when not allowed; idempotent by Idempotency-Key',
  params: SessionParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: DirectCommandBodySchema,
  response: DirectTurnResultSchema,
  errors: [...directErrors, 'forbidden'],
});

export const DirectCancelResultSchema = z.strictObject({ cancelled: z.boolean() });

export const cancelDirectTurn = defineRoute({
  id: 'cancelDirectTurn',
  method: 'POST',
  path: '/v1/direct/:sessionId/cancel',
  summary: 'Stops the turn that runs in a direct session; `cancelled: false` when none runs',
  params: SessionParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: DirectCancelResultSchema,
  errors: directErrors,
});

export const DirectCloseResultSchema = z.strictObject({
  work: z.enum(DIRECT_WORK_OUTCOMES),
  branch: z.string().min(1).nullable(),
});
export type DirectCloseResult = z.infer<typeof DirectCloseResultSchema>;

export const closeDirectSession = defineRoute({
  id: 'closeDirectSession',
  method: 'POST',
  path: '/v1/direct/:sessionId/close',
  summary:
    'Closes a direct session: the client ends, the worktree is committed and removed and the branch stays or goes by `direct_session.on_close`',
  params: SessionParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: DirectCloseResultSchema,
  errors: directErrors,
});

/**
 * Sends the result of a session on. `demand`: the text becomes an idea of the queue of the scenario
 * (5.20); `piece`: it opens a play from it. `text` is what to send; absent, the last message of the
 * Actor.
 */
export const DirectPromoteBodySchema = z.strictObject({
  target: z.enum(DIRECT_PROMOTE_TARGETS),
  text: z.string().min(1).max(DIRECT_TEXT_MAX).optional(),
});
export type DirectPromoteBody = z.input<typeof DirectPromoteBodySchema>;

export const DirectPromoteResultSchema = z.strictObject({
  target: z.enum(DIRECT_PROMOTE_TARGETS),
  /** The id of the idea or of the play it became. */
  ref: z.string().min(1),
});
export type DirectPromoteResult = z.infer<typeof DirectPromoteResultSchema>;

export const promoteDirectSession = defineRoute({
  id: 'promoteDirectSession',
  method: 'POST',
  path: '/v1/direct/:sessionId/promote',
  summary:
    'Sends the result of a direct session to a demand (an idea of the queue) or a piece (a play); idempotent by Idempotency-Key',
  params: SessionParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: DirectPromoteBodySchema,
  response: DirectPromoteResultSchema,
  errors: directErrors,
});

export const DIRECT_ROUTES = defineRoutes(
  openDirectSession,
  listDirectSessions,
  getDirectSession,
  sendDirectMessage,
  runDirectCommand,
  cancelDirectTurn,
  closeDirectSession,
  promoteDirectSession,
);
