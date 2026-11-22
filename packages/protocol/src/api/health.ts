// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The health check of the daemon (Phase 10, P8; architecture 5.21). [proposta] `GET /v1/health`
 * answers 200 only when the reconciliation of the start-up ended without error and the API
 * answers; while it has not, or while the daemon is stopping, it answers 503 `unavailable`
 * (`recovering` while the gate is shut). The applier of an update asks it of the new daemon, and
 * it reads `version` and `pid` to be sure the answer is not the old daemon's.
 */
export const ApiHealthSchema = z.strictObject({
  status: z.literal('ok'),
  version: z.string().min(1).max(64),
  pid: z.int().min(1),
});
export type ApiHealth = z.infer<typeof ApiHealthSchema>;

export const getHealth = defineRoute({
  id: 'getHealth',
  method: 'GET',
  path: '/v1/health',
  summary:
    'Health of the daemon: 200 once the reconciliation of the start-up ended without error; 503 before that or while stopping',
  response: ApiHealthSchema,
  errors: ['unavailable', 'recovering'],
});

export const HEALTH_ROUTES = defineRoutes(getHealth);
