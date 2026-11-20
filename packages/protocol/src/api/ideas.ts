// SPDX-License-Identifier: MPL-2.0
import { IDEA_STATES, IdeaRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { PageQuerySchema, pageOf } from './page.js';
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

export const IDEA_ROUTES = defineRoutes(listIdeas, getIdea);
