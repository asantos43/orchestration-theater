// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { DaemonIdSchema } from './ids.js';

/**
 * Discovery of a local daemon (decisions N165, N166 and N168; plan docs/17, P3 and P9). The daemon
 * writes these files in its data folder; a client on the same machine reads them to find the URL,
 * the id and the token. Shared here so the server (P3) and the client (P9) agree on one shape.
 */

/** Published by the running daemon (mode 0600) and removed when it stops cleanly. */
export const API_DISCOVERY_FILE = 'api.json';

/**
 * The API token (mode 0600). [proposta] Kept apart from `api.json` because its lifetime differs:
 * with `api.token: persistent` it survives restarts, and `api.json` does not.
 */
export const API_TOKEN_FILE = 'api-token';

/** The id of the daemon (N168): a UUID made on the first start, kept by backup and restore. */
export const DAEMON_ID_FILE = 'daemon-id';

/** What `api.json` holds. Never the token. */
export const ApiDiscoverySchema = z.strictObject({
  /** Base URL of the API, with no trailing slash and no path (`http://127.0.0.1:<port>`). */
  url: z.url({ protocol: /^https?$/ }),
  daemonId: DaemonIdSchema,
  /** Pid of the daemon that wrote the file: a file whose pid is gone is stale. */
  pid: z.int().min(1),
  /** `API_VERSION` the daemon speaks. */
  apiVersion: z.int().min(1),
});
export type ApiDiscovery = z.infer<typeof ApiDiscoverySchema>;
