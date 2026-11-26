// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { DaemonStatusSchema } from '../api.js';
import { DaemonIdSchema } from './ids.js';
import { API_VERSION, defineRoute, defineRoutes } from './route.js';

/**
 * What `GET /v1/status` returns: what `ot daemon` shows ({@link DaemonStatusSchema}, unchanged)
 * plus the id of the daemon (N168) and the version of the contract it speaks.
 */
/**
 * What the daemon runs with as to the layers of guarantee (N334, 2026-11-26; [proposta]): whether
 * layer 3 (the sandbox) is there, and the `security.unenforced` the daemon started with (it is read
 * at the start: a write of the file waits for a restart). The interface says "reduced protection"
 * when `layer3` is `false` and `unenforced` is not `refuse`, and "the Director will not open" when
 * `layer3` is `false` and `unenforced` is `refuse`.
 */
export const ApiSecurityStatusSchema = z.strictObject({
  layer3: z.boolean(),
  unenforced: z.enum(['refuse', 'warn', 'allow']),
});
export type ApiSecurityStatus = z.infer<typeof ApiSecurityStatusSchema>;

export const ApiStatusSchema = DaemonStatusSchema.extend({
  daemonId: DaemonIdSchema,
  /** `API_VERSION` of the daemon: the number in the `/v<n>` prefix. */
  apiVersion: z.int().min(1),
  /** Absent from a daemon older than N334. */
  security: ApiSecurityStatusSchema.optional(),
});
export type ApiStatus = z.infer<typeof ApiStatusSchema>;

export const getStatus = defineRoute({
  id: 'getStatus',
  method: 'GET',
  path: '/v1/status',
  summary:
    'State of the daemon: pid, version, data folder, state, daemon id, API version, and layer 3 and security.unenforced',
  response: ApiStatusSchema,
});

export const STATUS_ROUTES = defineRoutes(getStatus);

/** True when a client of this build can talk to a daemon of `apiVersion`. */
export function isSupportedApiVersion(apiVersion: number): boolean {
  return apiVersion === API_VERSION;
}
