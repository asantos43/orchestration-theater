// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the direct session with an Actor (N44, N190; architecture 5.20).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. [proposta] Every payload
 * is a strict object and the scenario is in the envelope (`scenarioId`). The text of a message is cut
 * at {@link DIRECT_TEXT_MAX}: the whole conversation is in the session (the client's own record), the
 * log keeps what the Producer and the Actor said so the trajectory of the session can be read back.
 */

/** Where the session works (`direct_session.workspace`). */
export const DIRECT_WORKSPACES = ['worktree', 'readonly', 'scenario'] as const;
export type DirectWorkspace = (typeof DIRECT_WORKSPACES)[number];

/** The most characters of one message the log keeps. */
export const DIRECT_TEXT_MAX = 8000;

/** Who said it. */
export const DIRECT_SPEAKERS = ['producer', 'actor'] as const;

/** Why a session ended. `failed` is a session the client lost; `shutdown` is the daemon stopping. */
export const DIRECT_CLOSE_REASONS = ['closed', 'failed', 'shutdown', 'idle'] as const;

/** Where a session's result goes when the Producer promotes it. */
export const DIRECT_PROMOTE_TARGETS = ['demand', 'piece'] as const;
export type DirectPromoteTarget = (typeof DIRECT_PROMOTE_TARGETS)[number];

/** What became of the folder the session worked in, when it ended. */
export const DIRECT_WORK_OUTCOMES = ['none', 'kept', 'discarded', 'not_applicable'] as const;

/**
 * Why a session did not open: `no_executor` nobody in the list of the Actor can ever take it,
 * `waiting` the quota, the cap or a slot of the profile is short for now, `not_available` the
 * Executor asked for is not in the list, `too_many` the scenario holds `direct_session.max_open`
 * sessions, `failed` the folder or the client did not come up.
 */
export const DIRECT_REFUSAL_CODES = [
  'no_executor',
  'waiting',
  'not_available',
  'too_many',
  'failed',
] as const;

/** `direct.session.opened`: the session is open. `branch` is the own branch of a `worktree` session. */
export const DirectSessionOpenedPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  profile: z.string().min(1),
  client: z.string().min(1),
  workspace: z.enum(DIRECT_WORKSPACES),
  branch: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});

/** `direct.session.message`: the Producer wrote, or the Actor finished a message of its turn. */
export const DirectSessionMessagePayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  turn: z.int().min(1),
  from: z.enum(DIRECT_SPEAKERS),
  text: z.string().max(DIRECT_TEXT_MAX),
  truncated: z.boolean(),
});

/** `direct.session.tool`: a tool call of the Actor started or changed. */
export const DirectSessionToolPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  turn: z.int().min(1),
  toolCallId: z.string().min(1),
  title: z.string().max(500),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
});

/**
 * `direct.session.permission`: the policy of the scenario answered a request of the Actor (layer 2,
 * architecture 5.8). [proposta] The answer is the policy's, at once: asking the Producer in the tab
 * needs a request that waits, which the port does not have yet (see the PR of P19).
 */
export const DirectSessionPermissionPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  turn: z.int().min(0),
  title: z.string().max(500),
  decision: z.string().min(1),
  answered: z.enum(['allow', 'reject', 'cancelled']),
  rule: z.string().min(1),
  reason: z.string().min(1),
});

/** `direct.session.command`: the Producer ran a command of the client (`/compact`, ...) in the session. */
export const DirectSessionCommandPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  turn: z.int().min(1),
  command: z.string().min(1).max(200),
});

/** `direct.session.turn_finished`: a turn ended. */
export const DirectSessionTurnFinishedPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  turn: z.int().min(1),
  stopReason: z.string().min(1),
  /** Set when the turn ended in an error, not in a stop reason (English, for the log). */
  error: z.string().max(1000).optional(),
});

/** `direct.session.closed`: the session ended. `work` is what became of its own folder. */
export const DirectSessionClosedPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  reason: z.enum(DIRECT_CLOSE_REASONS),
  turns: z.int().min(0),
  work: z.enum(DIRECT_WORK_OUTCOMES),
  branch: z.string().min(1).nullable(),
});

/** `direct.session.promoted`: the Producer sent the result to a demand (an idea) or a piece (a play). */
export const DirectSessionPromotedPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  target: z.enum(DIRECT_PROMOTE_TARGETS),
  /** The id of the idea or of the play it became. */
  ref: z.string().min(1),
});

/**
 * `direct.session.refused`: a session did not open. The situation a log line alone would hide: no
 * quota, no budget, no slot, an Executor that is not in the list, or too many sessions open.
 */
export const DirectSessionRefusedPayloadSchema = z.strictObject({
  profile: z.string().min(1).nullable(),
  workspace: z.enum(DIRECT_WORKSPACES),
  code: z.enum(DIRECT_REFUSAL_CODES),
  reason: z.string().max(1000),
});
