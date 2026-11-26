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
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
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

/**
 * Opens a scenario (the command of the Producer's `ot chat`, P6 of docs/17). [proposta] The body is
 * `OpenChatInput` of the daemon: the type (a key of the scenario type registry, default `project`),
 * the repository, the base branch, a name and `newProject`. It also wakes the Director of the
 * scenario, so the first reply is on its way when the answer arrives; `cursor` is where the replies
 * of the chat stand. `lastEventId` is the newest event of the log before the daemon did anything
 * for this call (N179, item 1): the chat socket opens with `resume` from it, so a reply the Director
 * produces before the socket is open still comes, once. [proposta]
 */
export const OpenScenarioBodySchema = z.strictObject({
  type: z.string().min(1).max(64).optional(),
  repo: z.string().min(1).max(4096).optional(),
  base: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(256).optional(),
  newProject: z.boolean().optional(),
});
export type OpenScenarioBody = z.input<typeof OpenScenarioBodySchema>;

export const OpenScenarioResultSchema = z.strictObject({
  scenario: ApiScenarioSchema,
  cursor: z.int().min(0),
  lastEventId: z.int().min(0),
});
export type OpenScenarioResult = z.infer<typeof OpenScenarioResultSchema>;

export const openScenario = defineRoute({
  id: 'openScenario',
  method: 'POST',
  path: '/v1/scenarios',
  summary: 'Opens a scenario (a project or a chat) and its Director; idempotent by Idempotency-Key',
  headers: IdempotencyHeadersSchema,
  body: OpenScenarioBodySchema,
  response: OpenScenarioResultSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

/**
 * The scenario types the daemon knows (architecture 5.20) and whether it can open a new scenario of
 * each one yet (2026-11-26, N329). [proposta] `creatable: false` is a type of the registry the daemon
 * cannot create yet (the task, until Phase 9b): an interface shows it turned off and turns it on by
 * itself when the daemon answers `true`.
 */
export const ApiScenarioTypeSchema = z.strictObject({
  id: z.string().min(1).max(64),
  creatable: z.boolean(),
});
export type ApiScenarioType = z.infer<typeof ApiScenarioTypeSchema>;

export const ApiScenarioTypeListSchema = z.strictObject({
  items: z.array(ApiScenarioTypeSchema),
});

export const listScenarioTypes = defineRoute({
  id: 'listScenarioTypes',
  method: 'GET',
  path: '/v1/scenario-types',
  summary: 'The scenario types (project, task, chat) and whether a new one of each can be opened yet',
  response: ApiScenarioTypeListSchema,
});

export const SCENARIO_ROUTES = defineRoutes(
  listScenarios,
  getScenario,
  openScenario,
  listScenarioTypes,
);
