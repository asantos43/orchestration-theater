// SPDX-License-Identifier: MPL-2.0
import { BlackboardEntrySchema } from '@otheater/core';
import { z } from 'zod';
import { PageQuerySchema, pageOf } from './page.js';
import { PlayParamsSchema } from './plays.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The blackboard of a play: what the roles wrote, by key, with versions (P5 of docs/17).
 * [proposta] The store scopes the blackboard by play (`playId`), so the routes hang from the play,
 * not from the scenario; the key goes in the query because a key may hold any character.
 */

export const ApiBlackboardEntrySchema = BlackboardEntrySchema;
export type ApiBlackboardEntry = z.infer<typeof ApiBlackboardEntrySchema>;

const KeySchema = z.string().min(1).max(256);

export const listBlackboard = defineRoute({
  id: 'listBlackboard',
  method: 'GET',
  path: '/v1/plays/:playId/blackboard',
  summary: 'The latest version of each key of the blackboard of a play, by key, by cursor',
  params: PlayParamsSchema,
  query: PageQuerySchema,
  response: pageOf(ApiBlackboardEntrySchema),
  errors: ['not_found'],
});

export const getBlackboardEntry = defineRoute({
  id: 'getBlackboardEntry',
  method: 'GET',
  path: '/v1/plays/:playId/blackboard/entry',
  summary: 'One key of the blackboard of a play: the latest version, or the one asked for',
  params: PlayParamsSchema,
  query: z.strictObject({ key: KeySchema, version: z.coerce.number().int().min(1).optional() }),
  response: ApiBlackboardEntrySchema,
  errors: ['not_found'],
});

export const listBlackboardHistory = defineRoute({
  id: 'listBlackboardHistory',
  method: 'GET',
  path: '/v1/plays/:playId/blackboard/history',
  summary: 'The versions of one key of the blackboard of a play, oldest first, by cursor',
  params: PlayParamsSchema,
  query: PageQuerySchema.extend({ key: KeySchema }),
  response: pageOf(ApiBlackboardEntrySchema),
  errors: ['not_found'],
});

export const BLACKBOARD_ROUTES = defineRoutes(
  listBlackboard,
  getBlackboardEntry,
  listBlackboardHistory,
);
