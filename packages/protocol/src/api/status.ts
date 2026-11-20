// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { DaemonStatusSchema } from '../api.js';
import { DaemonIdSchema } from './ids.js';
import { API_VERSION, defineRoute, defineRoutes } from './route.js';

/**
 * What `GET /v1/status` returns: what `ot daemon` shows ({@link DaemonStatusSchema}, unchanged)
 * plus the id of the daemon (N168) and the version of the contract it speaks.
 */
export const ApiStatusSchema = DaemonStatusSchema.extend({
  daemonId: DaemonIdSchema,
  /** `API_VERSION` of the daemon: the number in the `/v<n>` prefix. */
  apiVersion: z.int().min(1),
});
export type ApiStatus = z.infer<typeof ApiStatusSchema>;

export const getStatus = defineRoute({
  id: 'getStatus',
  method: 'GET',
  path: '/v1/status',
  summary: 'State of the daemon: pid, version, data folder, state, daemon id and API version',
  response: ApiStatusSchema,
});

export const STATUS_ROUTES = defineRoutes(getStatus);

/** True when a client of this build can talk to a daemon of `apiVersion`. */
export function isSupportedApiVersion(apiVersion: number): boolean {
  return apiVersion === API_VERSION;
}
