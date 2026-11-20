// SPDX-License-Identifier: MPL-2.0
import {
  DIRECTIVE_KINDS,
  DIRECTIVE_SCOPES,
  DIRECTIVE_STATES,
  DirectiveRecordSchema,
} from '@otheater/core';
import { z } from 'zod';
import { PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The Producer's orders (directives, architecture 5.17): in force, scheduled and ended (P5 of
 * docs/17). [proposta] `state=ended` is `expired` and `revoked` together. The order is the one
 * of the store (`seq`), which never changes, so a page never loses an order to a write.
 */

export const ApiOrderSchema = DirectiveRecordSchema;
export type ApiOrder = z.infer<typeof ApiOrderSchema>;

export const ORDER_STATE_FILTERS = [...DIRECTIVE_STATES, 'ended'] as const;

export const ListOrdersQuerySchema = PageQuerySchema.extend({
  state: z.enum(ORDER_STATE_FILTERS).optional(),
  scope: z.enum(DIRECTIVE_SCOPES).optional(),
  kind: z.enum(DIRECTIVE_KINDS).optional(),
  scenarioId: z.string().min(1).max(256).optional(),
});
export type ListOrdersQuery = z.input<typeof ListOrdersQuerySchema>;

export const listOrders = defineRoute({
  id: 'listOrders',
  method: 'GET',
  path: '/v1/orders',
  summary: 'Orders (in force, scheduled, ended) in the order they were given, by cursor',
  query: ListOrdersQuerySchema,
  response: pageOf(ApiOrderSchema),
});

export const getOrder = defineRoute({
  id: 'getOrder',
  method: 'GET',
  path: '/v1/orders/:orderId',
  summary: 'One order',
  params: z.strictObject({ orderId: z.string().min(1).max(64) }),
  response: ApiOrderSchema,
  errors: ['not_found'],
});

export const ORDER_ROUTES = defineRoutes(listOrders, getOrder);
