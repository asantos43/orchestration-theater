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

/** What `POST /v1/daemon/stop` answers: the daemon answers first, then stops. */
export const DaemonStoppingSchema = z.strictObject({ stopping: z.literal(true) });
export type DaemonStopping = z.infer<typeof DaemonStoppingSchema>;

/**
 * `ot service stop` and `ot uninstall` (N323). [proposta] The clean stop of a daemon that the
 * service manager could not stop (on Windows, ending the scheduled task does not reach the daemon):
 * the daemon sends the answer, then shuts down as on a signal. A stop already under way is not an
 * error; the caller waits for the instance lock to be free to know the daemon is gone.
 */
export const stopDaemon = defineRoute({
  id: 'stopDaemon',
  method: 'POST',
  path: '/v1/daemon/stop',
  summary: 'Stop the daemon: it answers first, then shuts down as on a signal',
  response: DaemonStoppingSchema,
});

export const ADMIN_ROUTES = defineRoutes(rotateApiToken, stopDaemon);
