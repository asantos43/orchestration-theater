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

export const ApiPlaySchema = PlayRecordSchema.omit({ snapshot: true });
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
 * takes it to the end state `CANCELLED` from any state that is not final. Pausing, resuming and
 * cancelling one Actor are not here: the daemon has no such command yet.
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

export const PLAY_ROUTES = defineRoutes(listScenarioPlays, getPlay, cancelPlay);
