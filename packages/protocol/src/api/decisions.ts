// SPDX-License-Identifier: MPL-2.0
import { DECISION_STATES, DecisionRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
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

/**
 * Answers a pending decision of the Producer (P6 of docs/17): a question of the Director
 * (`{answers}`), the menu of a play that ran out of a counter (`{option, need?, reason?}`), a group
 * of ideas that waits for approval (`{option: approve|edit|refuse}`) or an effect the start-up could
 * not check (`{option: done|not_done}`). [proposta] The body wraps the answer in `answer`, the way
 * the chat socket does; the daemon checks it against the kind of the decision and answers
 * `invalid_input` for a shape that kind does not take.
 */
export const AnswerDecisionBodySchema = z.strictObject({
  answer: z.record(z.string(), z.json()),
});
export type AnswerDecisionBody = z.input<typeof AnswerDecisionBodySchema>;

export const AnswerDecisionResultSchema = z.strictObject({ decision: ApiDecisionSchema });
export type AnswerDecisionResult = z.infer<typeof AnswerDecisionResultSchema>;

export const answerDecision = defineRoute({
  id: 'answerDecision',
  method: 'POST',
  path: '/v1/decisions/:decisionId/answer',
  summary: 'Answers a pending decision of the Producer; idempotent by Idempotency-Key',
  params: z.strictObject({ decisionId: z.string().min(1).max(256) }),
  headers: IdempotencyHeadersSchema,
  body: AnswerDecisionBodySchema,
  response: AnswerDecisionResultSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

export const DECISION_ROUTES = defineRoutes(listScenarioDecisions, answerDecision);
