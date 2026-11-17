// SPDX-License-Identifier: MPL-2.0
import { PERMISSION_REASONS } from '@otheater/core';
import { z } from 'zod';

/**
 * Payloads of the permission events (architecture 5.8, layer 2; Phase 4, P2). Every request the
 * client sends in `session/request_permission` is told twice: `permission.asked` when it arrives
 * and `permission.answered` with what the daemon answered and why. They are registered in
 * `DAEMON_EVENT_TYPES` (events.ts) at `schemaVersion` 1. Every payload is a strict object.
 *
 * Correlation (N54), as in the session events: `playId`, `demandId` and `attemptId` are optional,
 * because a session of the direct chat (N44) belongs to no play, and that one is outside P2.
 * [proposta] All the fields.
 *
 * What the events leave out on purpose: the command line of a request that runs one and the title
 * of the tool call, which may carry a secret the model typed. The shell of the client is always
 * rejected, so the fact (`reason: native_shell`) is what the log needs.
 */

const id = z.string().min(1).max(256);

const correlation = {
  playId: id.optional(),
  demandId: id.optional(),
  attemptId: id.optional(),
};

/** How many paths one event lists; `pathCount` has the real number. */
export const PERMISSION_EVENT_MAX_PATHS = 10;

/** What a request is about, in both events. */
const requestFields = {
  sessionId: id,
  toolCallId: id.optional(),
  /** The tool as the client names it, or its ACP kind when it does not; `unknown` when neither. */
  tool: id,
  /** The ACP kind of the tool call (`edit`, `fetch`...). */
  kind: id.optional(),
  /** The files the call touches, as the client said them (at most {@link PERMISSION_EVENT_MAX_PATHS}). */
  paths: z.array(z.string().min(1).max(1024)).max(PERMISSION_EVENT_MAX_PATHS),
  pathCount: z.int().min(0),
  /** The host of the address a fetch carries. */
  host: z.string().min(1).max(256).optional(),
};

/** `permission.asked`: the client asked for permission (before the answer). */
export const PermissionAskedPayloadSchema = z.strictObject({
  ...requestFields,
  ...correlation,
});

/** What the daemon answered: a release, a rejection, or a cancel when no option fits. */
export const PERMISSION_ANSWERS = ['allow', 'reject', 'cancelled'] as const;

/** `permission.answered`: what the daemon answered, by which rule, and why. */
export const PermissionAnsweredPayloadSchema = z.strictObject({
  ...requestFields,
  answer: z.enum(PERMISSION_ANSWERS),
  /** Id of the rule that decided; `none` when no rule did (the request was refused or matched nothing). */
  rule: id,
  /** Why: a rule, no rule, `on_ask: reject`, or what is always rejected (N99). */
  reason: z.enum(PERMISSION_REASONS),
  /** The rule that would have released the request, had N99 not forbidden it. */
  overruledRule: id.optional(),
  ...correlation,
});
