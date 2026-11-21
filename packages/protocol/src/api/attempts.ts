// SPDX-License-Identifier: MPL-2.0
import { AttemptRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
import { PlayParamsSchema } from './plays.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The commands on one attempt, the work of an Actor in flight (Phase 7, P2, N176; architecture
 * 5.12 and 5.16). [proposta] The id of an attempt (`<playId>/<demandId>/<n>`) has slashes, so a
 * client sends it percent-encoded (`routePath` does it) and the server decodes it.
 */

/** The `:attemptId` of the routes of one attempt. */
export const AttemptParamsSchema = z.strictObject({ attemptId: z.string().min(1).max(512) });

/** An attempt as the API shows it: its registry row, without the path of the worktree. */
export const ApiAttemptSchema = AttemptRecordSchema.omit({ worktree: true });
export type ApiAttempt = z.infer<typeof ApiAttemptSchema>;

const AttemptResponseSchema = z.strictObject({ attempt: ApiAttemptSchema });

/**
 * Pauses an attempt: the turn is interrupted with the cause `paused`, the checkpoint is saved and
 * the process is released. The attempt waits in `awaiting_resume` until it is resumed. An attempt
 * that is not running, or is paused already, answers `conflict`. A pause does not survive a restart
 * of the daemon: the attempt is parked `interrupted` and the play opens the demand again.
 */
export const pauseAttempt = defineRoute({
  id: 'pauseAttempt',
  method: 'POST',
  path: '/v1/attempts/:attemptId/pause',
  summary: 'Pauses an Actor in flight, saving its checkpoint; idempotent by Idempotency-Key',
  params: AttemptParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: AttemptResponseSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

/**
 * Resumes an attempt a person paused, with the policy of the cause `paused`: the same conversation
 * is loaded again when the client can, and the work passes to another session when it cannot. An
 * attempt the play paused is resumed by resuming the play (`conflict`).
 */
export const resumeAttempt = defineRoute({
  id: 'resumeAttempt',
  method: 'POST',
  path: '/v1/attempts/:attemptId/resume',
  summary: 'Resumes a paused Actor by the policy of the cause; idempotent by Idempotency-Key',
  params: AttemptParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: AttemptResponseSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

/**
 * Cancels an attempt, running or paused: it ends as `cancelled` with its work kept, and the
 * Director judges what to do with the demand (a retry, a new executor or the Producer).
 */
export const cancelAttempt = defineRoute({
  id: 'cancelAttempt',
  method: 'POST',
  path: '/v1/attempts/:attemptId/cancel',
  summary: 'Cancels an Actor in flight; the Director judges; idempotent by Idempotency-Key',
  params: AttemptParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: AttemptResponseSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

/**
 * An attempt of a play as the list of its attempts shows it (P25 of docs/18, N200 item 1;
 * [proposta]): the registry row without the worktree, plus what an interface needs to draw the
 * Actor that works on it. `model` is the one the Actor works with now; it is `null` when the daemon
 * does not know it (an attempt that no live process holds). `paused` says who paused the attempt: the
 * person (`actor`) or the pause of the play (`play`); `null` when it is not paused.
 */
export const ApiPlayAttemptSchema = ApiAttemptSchema.extend({
  model: z.string().min(1).nullable(),
  paused: z.enum(['actor', 'play']).nullable(),
});
export type ApiPlayAttempt = z.infer<typeof ApiPlayAttemptSchema>;

export const ListPlayAttemptsQuerySchema = PageQuerySchema.extend({
  /**
   * `true`: only the attempts still open (`executing`, `interrupted`, `awaiting_resume`,
   * `resuming`); `false`: only the ones that ended. Omitted: all of them.
   */
  open: z.enum(['true', 'false']).optional(),
});
export type ListPlayAttemptsQuery = z.input<typeof ListPlayAttemptsQuerySchema>;

/**
 * The attempts of a play, oldest first, by cursor (P25). An interface that connects after the play
 * began reads the open ones here to know who is working and who is paused, and the ended ones
 * (`open=false`) for the recent history; the events keep both right afterwards.
 */
export const listPlayAttempts = defineRoute({
  id: 'listPlayAttempts',
  method: 'GET',
  path: '/v1/plays/:playId/attempts',
  summary:
    'Attempts of a play, oldest first, by cursor, with Actor, state and pause; filter by open',
  params: PlayParamsSchema,
  query: ListPlayAttemptsQuerySchema,
  response: pageOf(ApiPlayAttemptSchema),
  errors: ['not_found'],
});

export const ATTEMPT_ROUTES = defineRoutes(
  pauseAttempt,
  resumeAttempt,
  cancelAttempt,
  listPlayAttempts,
);
