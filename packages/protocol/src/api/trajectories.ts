// SPDX-License-Identifier: MPL-2.0
import { EventEnvelopeSchema } from '@otheater/core';
import { z } from 'zod';
import { PageQuerySchema, pageOf } from './page.js';
import { PlayParamsSchema } from './plays.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The trajectory of a play (architecture 5.11 and 5.13, P14 of docs/18). [proposta] Two reads: the
 * events the trajectory is built from, for the history (the live part comes by the stream), and
 * the diff of one demand, which no event carries.
 */

/** The `:demandId` of the routes of one demand of a play. */
export const DemandParamsSchema = PlayParamsSchema.extend({ demandId: z.string().min(1).max(256) });

/** Why a diff is not there: `no_vcs` (the adapter cannot show one), `no_attempt` (the demand has no attempt yet), `no_branch` (the branch or the worktree is gone). */
export const DEMAND_DIFF_UNAVAILABLE = ['no_vcs', 'no_attempt', 'no_branch'] as const;

export const ApiDemandDiffSchema = z.strictObject({
  playId: z.string().min(1),
  demandId: z.string().min(1),
  /** The attempt whose work the diff shows: the latest one of the demand. */
  attemptId: z.string().min(1).nullable(),
  /** The diff is there (`diff` may still be empty: the attempt changed nothing). */
  available: z.boolean(),
  unavailable: z.enum(DEMAND_DIFF_UNAVAILABLE).nullable(),
  /** `git diff <play branch>...<attempt branch>`. */
  diff: z.string(),
  /** The text was cut at `tools.output_max_bytes`. */
  truncated: z.boolean(),
});
export type ApiDemandDiff = z.infer<typeof ApiDemandDiffSchema>;

export const listPlayTrajectory = defineRoute({
  id: 'listPlayTrajectory',
  method: 'GET',
  path: '/v1/plays/:playId/trajectory',
  summary:
    'The events a play trajectory is built from (sessions, turns, tools, permissions, attempts), oldest first, by cursor',
  params: PlayParamsSchema,
  query: PageQuerySchema,
  response: pageOf(EventEnvelopeSchema),
  errors: ['not_found', 'unavailable'],
});

/** The `:sessionId` of a direct session (the same as the routes of `api/direct.ts`). */
export const DirectTrajectoryParamsSchema = z.strictObject({
  sessionId: z.string().min(1).max(64),
});

/**
 * [proposta] P27 of docs/18 (N206): the events a direct session trajectory is built from, by cursor,
 * as the log has them: it answers for a session the daemon no longer holds in memory too.
 */
export const listDirectTrajectory = defineRoute({
  id: 'listDirectTrajectory',
  method: 'GET',
  path: '/v1/direct/:sessionId/trajectory',
  summary:
    'The events a direct session trajectory is built from (messages, tools, permissions, closing), oldest first, by cursor',
  params: DirectTrajectoryParamsSchema,
  query: PageQuerySchema,
  response: pageOf(EventEnvelopeSchema),
  errors: ['not_found', 'unavailable'],
});

export const getDemandDiff = defineRoute({
  id: 'getDemandDiff',
  method: 'GET',
  path: '/v1/plays/:playId/demands/:demandId/diff',
  summary: 'The diff of the latest attempt of a demand against the branch of its play',
  params: DemandParamsSchema,
  response: ApiDemandDiffSchema,
  errors: ['not_found', 'unavailable'],
});

export const TRAJECTORY_ROUTES = defineRoutes(
  listPlayTrajectory,
  getDemandDiff,
  listDirectTrajectory,
);
