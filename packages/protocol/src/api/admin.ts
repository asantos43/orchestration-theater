// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { defineRoute, defineRoutes } from './route.js';

/**
 * Administration of the API itself (plan docs/17 P3). A route here changes how the daemon
 * serves, not what it orchestrates.
 */

/**
 * What `POST /v1/api-token/rotate` answers. The new token is never in the answer: the daemon
 * writes it to `api-token` (mode 0600) in its data folder and a local client reads it there.
 * `rotated` is always `true` (a failure is an error answer). [proposta]
 */
export const ApiTokenRotatedSchema = z.strictObject({ rotated: z.literal(true) });
export type ApiTokenRotated = z.infer<typeof ApiTokenRotatedSchema>;

/**
 * `ot api rotate-token` on a running daemon. [proposta] The token stops working at once: the very
 * request that rotates it is the last one the old token opens. The streams open under the old
 * token are closed by the daemon (P4, P7). A route and not "the command writes the file and the
 * daemon rereads it" so no file watching is needed and the swap is one atomic step in the daemon.
 */
export const rotateApiToken = defineRoute({
  id: 'rotateApiToken',
  method: 'POST',
  path: '/v1/api-token/rotate',
  summary: 'Swap the API token: the old one stops working at once; the new one is in api-token',
  response: ApiTokenRotatedSchema,
});

export const ADMIN_ROUTES = defineRoutes(rotateApiToken);
