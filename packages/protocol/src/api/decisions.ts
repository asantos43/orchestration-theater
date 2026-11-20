// SPDX-License-Identifier: MPL-2.0
import { DECISION_STATES, DecisionRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';
import { ScenarioParamsSchema } from './scenarios.js';

/** The judgment points of a scenario, pending ones included (P5 of docs/17). */

export const ApiDecisionSchema = DecisionRecordSchema;
export type ApiDecision = z.infer<typeof ApiDecisionSchema>;

export const ListDecisionsQuerySchema = PageQuerySchema.extend({
  state: z.enum(DECISION_STATES).optional(),
  playId: z.string().min(1).max(256).optional(),
  kind: z.string().min(1).max(128).optional(),
});
export type ListDecisionsQuery = z.input<typeof ListDecisionsQuerySchema>;

export const listScenarioDecisions = defineRoute({
  id: 'listScenarioDecisions',
  method: 'GET',
  path: '/v1/scenarios/:scenarioId/decisions',
  summary: 'Judgment points of a scenario, oldest first, by cursor; filter by state, play and kind',
  params: ScenarioParamsSchema,
  query: ListDecisionsQuerySchema,
  response: pageOf(ApiDecisionSchema),
  errors: ['not_found'],
});

export const DECISION_ROUTES = defineRoutes(listScenarioDecisions);
