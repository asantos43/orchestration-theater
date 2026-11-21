// SPDX-License-Identifier: MPL-2.0
import { DemandRecordSchema, PlayRecordSchema, StageRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';
import { ScenarioParamsSchema } from './scenarios.js';

/**
 * The plays of a scenario, with their stages and demands (P5 of docs/17). [proposta] The state
 * machine snapshot (`snapshot`) is the daemon's own and stays out of the API; a client reads the
 * `state` name and the `counters`.
 */

/** The `:playId` of the routes of one play. */
export const PlayParamsSchema = z.strictObject({ playId: z.string().min(1).max(256) });

/**
 * A play as the API shows it: its registry row without the snapshot of the machine, plus `paused`
 * (P25, N200 item 2; [proposta]): the play got a `PAUSE` and no `RESUME` yet. It is read from the
 * snapshot, so it holds across a restart of the daemon, and it is `false` once the play finishes.
 * An interface that connects after the pause reads it here and offers "resume" only then.
 */
export const ApiPlaySchema = PlayRecordSchema.omit({ snapshot: true }).extend({
  paused: z.boolean(),
});
export type ApiPlay = z.infer<typeof ApiPlaySchema>;

export const ApiPlayDetailSchema = z.strictObject({
  play: ApiPlaySchema,
  stages: z.array(StageRecordSchema),
  demands: z.array(DemandRecordSchema),
});
export type ApiPlayDetail = z.infer<typeof ApiPlayDetailSchema>;

export const ListPlaysQuerySchema = PageQuerySchema.extend({
  /** `true`: only the plays not finished; `false`: only the finished ones. */
  open: z.enum(['true', 'false']).optional(),
  /** Only the plays in this state of the machine. */
  state: z.string().min(1).max(64).optional(),
});
export type ListPlaysQuery = z.input<typeof ListPlaysQuerySchema>;

export const listScenarioPlays = defineRoute({
  id: 'listScenarioPlays',
  method: 'GET',
  path: '/v1/scenarios/:scenarioId/plays',
  summary: 'Plays of a scenario, oldest first, by cursor; filter by open and state',
  params: ScenarioParamsSchema,
  query: ListPlaysQuerySchema,
  response: pageOf(ApiPlaySchema),
  errors: ['not_found'],
});

export const getPlay = defineRoute({
  id: 'getPlay',
  method: 'GET',
  path: '/v1/plays/:playId',
  summary: 'One play with its stages and demands',
  params: PlayParamsSchema,
  response: ApiPlayDetailSchema,
  errors: ['not_found'],
});

/**
 * Cancels a play (P6 of docs/17). [proposta] It sends `CANCEL` to the machine of the play, which
 * takes it to the end state `CANCELLED` from any state that is not final. Pausing and resuming a
 * play are below (N176); the commands on one Actor are in `attempts.ts`.
 */
export const CancelPlayBodySchema = z.strictObject({
  reason: z.string().min(1).max(2000).optional(),
});
export type CancelPlayBody = z.input<typeof CancelPlayBodySchema>;

export const cancelPlay = defineRoute({
  id: 'cancelPlay',
  method: 'POST',
  path: '/v1/plays/:playId/cancel',
  summary: 'Cancels a play that is not finished; idempotent by Idempotency-Key',
  params: PlayParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: CancelPlayBodySchema.optional(),
  response: z.strictObject({ play: ApiPlaySchema }),
  errors: ['not_found', 'conflict', 'unavailable'],
});

/**
 * Pauses a play (Phase 7, P2, N176; architecture 5.12). [proposta] It sends `PAUSE` to the machine
 * of the play. A paused play opens no new stage, attempt or judgment, and stays paused after a
 * restart of the daemon. `mode` overrides the key `pause.mode` of the daemon for this pause:
 * `drain` lets what runs finish, `interrupt` interrupts the attempts in flight with the cause
 * `paused` (checkpoint saved). A play that is already paused or finished answers `conflict`.
 */
export const PausePlayBodySchema = z.strictObject({
  mode: z.enum(['drain', 'interrupt']).optional(),
  reason: z.string().min(1).max(2000).optional(),
});
export type PausePlayBody = z.input<typeof PausePlayBodySchema>;

export const pausePlay = defineRoute({
  id: 'pausePlay',
  method: 'POST',
  path: '/v1/plays/:playId/pause',
  summary: 'Pauses a play: nothing new opens until it resumes; idempotent by Idempotency-Key',
  params: PlayParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: PausePlayBodySchema.optional(),
  response: z.strictObject({ play: ApiPlaySchema }),
  errors: ['not_found', 'conflict', 'unavailable'],
});

/** Resumes a paused play (N176): what was held back starts, and the attempts it interrupted resume. */
export const ResumePlayBodySchema = z.strictObject({
  reason: z.string().min(1).max(2000).optional(),
});
export type ResumePlayBody = z.input<typeof ResumePlayBodySchema>;

export const resumePlay = defineRoute({
  id: 'resumePlay',
  method: 'POST',
  path: '/v1/plays/:playId/resume',
  summary: 'Resumes a paused play; idempotent by Idempotency-Key',
  params: PlayParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: ResumePlayBodySchema.optional(),
  response: z.strictObject({ play: ApiPlaySchema }),
  errors: ['not_found', 'conflict', 'unavailable'],
});

export const PLAY_ROUTES = defineRoutes(
  listScenarioPlays,
  getPlay,
  cancelPlay,
  pausePlay,
  resumePlay,
);
