// SPDX-License-Identifier: MPL-2.0
import {
  SCENARIO_RECORD_KINDS,
  SCENARIO_STATES,
  JsonObjectSchema,
  ScenarioRecordSchema,
  ScenarioRepoRecordSchema,
} from '@otheater/core';
import { z } from 'zod';
import { ScenarioIdSchema } from './ids.js';
import { PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The scenarios (projects, tasks and chats) as the REST API reads them (P5 of docs/17). [proposta]
 * Every shape is the record of the store without what a list does not need; the heavy and the
 * sensitive parts (`conventions`, `configOverride`) come only in the detail, and `configOverride`
 * comes with the values a secret could hold redacted.
 */

/** The `:scenarioId` of the routes of one scenario. */
export const ScenarioParamsSchema = z.strictObject({ scenarioId: ScenarioIdSchema });

/** A scenario in a list. */
export const ApiScenarioSchema = ScenarioRecordSchema.omit({
  conventions: true,
  configOverride: true,
});
export type ApiScenario = z.infer<typeof ApiScenarioSchema>;

/** A scenario with what the detail adds: the repositories, the overrides and the counts. */
export const ApiScenarioDetailSchema = z.strictObject({
  scenario: ApiScenarioSchema,
  conventions: JsonObjectSchema.nullable(),
  /** The keys this scenario overrides, with the values a secret could hold redacted. */
  configOverride: JsonObjectSchema,
  repos: z.array(ScenarioRepoRecordSchema),
  counts: z.strictObject({
    openPlays: z.int().min(0),
    pendingDecisions: z.int().min(0),
    attachments: z.int().min(0),
  }),
});
export type ApiScenarioDetail = z.infer<typeof ApiScenarioDetailSchema>;

export const ListScenariosQuerySchema = PageQuerySchema.extend({
  kind: z.enum(SCENARIO_RECORD_KINDS).optional(),
  state: z.enum(SCENARIO_STATES).optional(),
});
export type ListScenariosQuery = z.input<typeof ListScenariosQuerySchema>;

export const ApiScenarioPageSchema = pageOf(ApiScenarioSchema);

export const listScenarios = defineRoute({
  id: 'listScenarios',
  method: 'GET',
  path: '/v1/scenarios',
  summary: 'Scenarios (projects, tasks, chats), oldest first, by cursor; filter by kind and state',
  query: ListScenariosQuerySchema,
  response: ApiScenarioPageSchema,
});

export const getScenario = defineRoute({
  id: 'getScenario',
  method: 'GET',
  path: '/v1/scenarios/:scenarioId',
  summary: 'One scenario with its repositories, overrides and counts of open plays and decisions',
  params: ScenarioParamsSchema,
  response: ApiScenarioDetailSchema,
  errors: ['not_found'],
});

export const SCENARIO_ROUTES = defineRoutes(listScenarios, getScenario);
