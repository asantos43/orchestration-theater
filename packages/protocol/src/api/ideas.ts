// SPDX-License-Identifier: MPL-2.0
import { IDEA_STATES, IdeaRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
import { ScenarioParamsSchema } from './scenarios.js';
import { defineRoute, defineRoutes } from './route.js';

/** The idea queue of the scenarios (architecture 5.20; P5 of docs/17): `state=queued` is the queue. */

export const ApiIdeaSchema = IdeaRecordSchema;
export type ApiIdea = z.infer<typeof ApiIdeaSchema>;

export const ListIdeasQuerySchema = PageQuerySchema.extend({
  state: z.enum(IDEA_STATES).optional(),
  scenarioId: z.string().min(1).max(256).optional(),
  playId: z.string().min(1).max(256).optional(),
  groupId: z.string().min(1).max(256).optional(),
});
export type ListIdeasQuery = z.input<typeof ListIdeasQuerySchema>;

export const listIdeas = defineRoute({
  id: 'listIdeas',
  method: 'GET',
  path: '/v1/ideas',
  summary: 'Ideas in the order they arrived, by cursor; filter by state, scenario, play and group',
  query: ListIdeasQuerySchema,
  response: pageOf(ApiIdeaSchema),
});

export const getIdea = defineRoute({
  id: 'getIdea',
  method: 'GET',
  path: '/v1/ideas/:ideaId',
  summary: 'One idea',
  params: z.strictObject({ ideaId: z.string().min(1).max(64) }),
  response: ApiIdeaSchema,
  errors: ['not_found'],
});

const IdeaIdParamsSchema = z.strictObject({ ideaId: z.string().min(1).max(64) });
const IdeaResultSchema = z.strictObject({ idea: ApiIdeaSchema });
const ideaErrors = ['not_found', 'conflict', 'unavailable'] as const;

/** `/idea add`: puts an idea in the queue of a scenario. [proposta] Its source is recorded as `tui`. */
export const AddIdeaBodySchema = z.strictObject({
  text: z.string().min(1).max(8000),
  area: z.string().min(1).max(256).optional(),
});
export type AddIdeaBody = z.input<typeof AddIdeaBodySchema>;

export const addIdea = defineRoute({
  id: 'addIdea',
  method: 'POST',
  path: '/v1/scenarios/:scenarioId/ideas',
  summary: 'Puts an idea in the queue of a scenario; idempotent by Idempotency-Key',
  params: ScenarioParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: AddIdeaBodySchema,
  response: IdeaResultSchema,
  errors: ideaErrors,
});

/** What one pass of the queue did: the groups the Author made and why it stopped early, if it did. */
export const DrainIdeasResultSchema = z.strictObject({
  groups: z.int().min(0),
  stopped: z.string().nullable(),
});
export type DrainIdeasResult = z.infer<typeof DrainIdeasResultSchema>;

export const drainIdeas = defineRoute({
  id: 'drainIdeas',
  method: 'POST',
  path: '/v1/scenarios/:scenarioId/ideas/drain',
  summary: 'Runs one pass of the idea queue of a scenario now (`/idea drain`)',
  params: ScenarioParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: DrainIdeasResultSchema,
  errors: ideaErrors,
});

export const IdeaReasonBodySchema = z.strictObject({ reason: z.string().min(1).max(2000) });
export type IdeaReasonBody = z.input<typeof IdeaReasonBodySchema>;

export const discardIdea = defineRoute({
  id: 'discardIdea',
  method: 'POST',
  path: '/v1/ideas/:ideaId/discard',
  summary: 'Drops an idea for good, with the reason',
  params: IdeaIdParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: IdeaReasonBodySchema,
  response: IdeaResultSchema,
  errors: ideaErrors,
});

export const deferIdea = defineRoute({
  id: 'deferIdea',
  method: 'POST',
  path: '/v1/ideas/:ideaId/defer',
  summary: 'Sets an idea aside for later, with the reason',
  params: IdeaIdParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: IdeaReasonBodySchema,
  response: IdeaResultSchema,
  errors: ideaErrors,
});

export const requeueIdea = defineRoute({
  id: 'requeueIdea',
  method: 'POST',
  path: '/v1/ideas/:ideaId/requeue',
  summary: 'Puts a deferred idea back in the queue',
  params: IdeaIdParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: IdeaResultSchema,
  errors: ideaErrors,
});

export const IDEA_ROUTES = defineRoutes(
  listIdeas,
  getIdea,
  addIdea,
  drainIdeas,
  discardIdea,
  deferIdea,
  requeueIdea,
);
