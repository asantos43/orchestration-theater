// SPDX-License-Identifier: MPL-2.0
import {
  DIRECTIVE_KINDS,
  DIRECTIVE_SCOPES,
  DIRECTIVE_STATES,
  DirectiveRecordSchema,
} from '@otheater/core';
import { z } from 'zod';
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
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

/**
 * The validity of an order as the Producer writes it (the daemon's `ValidityText`): `from` (absent:
 * when it is given), `until` (`null`: until revoked) and `for` (a duration counted from the start;
 * for an extension, from the current end). The dates are read in the time zone of the order.
 */
export const OrderValiditySchema = z.strictObject({
  from: z.string().min(1).optional(),
  until: z.string().min(1).nullable().optional(),
  for: z.string().min(1).optional(),
});
export type OrderValidity = z.infer<typeof OrderValiditySchema>;

const OrderIdParamsSchema = z.strictObject({ orderId: z.string().min(1).max(64) });
const OrderResultSchema = z.strictObject({ order: ApiOrderSchema });
const orderErrors = ['not_found', 'conflict'] as const;

/** Gives an order (`ot order add`). [proposta] Its origin is recorded as `tui`: a client of the API. */
export const CreateOrderBodySchema = z.strictObject({
  text: z.string().min(1).max(8000),
  scope: z.enum(DIRECTIVE_SCOPES),
  scenarioId: z.string().min(1).max(256).optional(),
  kind: z.enum(DIRECTIVE_KINDS).optional(),
  roles: z.array(z.string().min(1).max(64)).max(32).optional(),
  ruleKey: z.string().min(1).max(256).optional(),
  ruleValue: z.json().optional(),
  suspendsId: z.string().min(1).max(64).optional(),
  replacesId: z.string().min(1).max(64).optional(),
  timezone: z.string().min(1).max(64).optional(),
  validity: OrderValiditySchema.optional(),
});
export type CreateOrderBody = z.input<typeof CreateOrderBodySchema>;

export const createOrder = defineRoute({
  id: 'createOrder',
  method: 'POST',
  path: '/v1/orders',
  summary: 'Gives an order (an instruction, a rule or a suspension); idempotent by Idempotency-Key',
  headers: IdempotencyHeadersSchema,
  body: CreateOrderBodySchema,
  response: OrderResultSchema,
  errors: orderErrors,
});

export const ExtendOrderBodySchema = z.strictObject({ validity: OrderValiditySchema });
export type ExtendOrderBody = z.input<typeof ExtendOrderBodySchema>;

export const extendOrder = defineRoute({
  id: 'extendOrder',
  method: 'POST',
  path: '/v1/orders/:orderId/extend',
  summary: 'Changes the validity of an order (`for` counts from the current end)',
  params: OrderIdParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: ExtendOrderBodySchema,
  response: OrderResultSchema,
  errors: orderErrors,
});

/**
 * Suspends a global order in one scenario (the order is not touched: a local `suspension` order
 * is given). [proposta] `text` defaults to a line that names the suspended order.
 */
export const SuspendOrderBodySchema = z.strictObject({
  scenarioId: z.string().min(1).max(256),
  text: z.string().min(1).max(8000).optional(),
  validity: OrderValiditySchema.optional(),
});
export type SuspendOrderBody = z.input<typeof SuspendOrderBodySchema>;

export const suspendOrder = defineRoute({
  id: 'suspendOrder',
  method: 'POST',
  path: '/v1/orders/:orderId/suspend',
  summary: 'Suspends a global order in one scenario by giving a local suspension order',
  params: OrderIdParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: SuspendOrderBodySchema,
  response: OrderResultSchema,
  errors: orderErrors,
});

export const RevokeOrderBodySchema = z.strictObject({ reason: z.string().min(1).max(2000) });
export type RevokeOrderBody = z.input<typeof RevokeOrderBodySchema>;

export const revokeOrder = defineRoute({
  id: 'revokeOrder',
  method: 'POST',
  path: '/v1/orders/:orderId/revoke',
  summary: 'Revokes an order, with the reason',
  params: OrderIdParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: RevokeOrderBodySchema,
  response: OrderResultSchema,
  errors: orderErrors,
});

export const ORDER_ROUTES = defineRoutes(
  listOrders,
  getOrder,
  createOrder,
  extendOrder,
  suspendOrder,
  revokeOrder,
);
