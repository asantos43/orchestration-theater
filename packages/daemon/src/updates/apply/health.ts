// SPDX-License-Identifier: MPL-2.0
import { ApiHealthSchema } from '@otheater/protocol';
import { readApiToken, readDiscovery } from '../../api/files.js';
import { dataPaths } from '../../paths.js';

/**
 * What one look at the daemon found (Phase 10, P8):
 * - `ok`: the new daemon answers `GET /v1/health` with 200, and it is the one that was asked for;
 * - `unhealthy`: it answers, but not with 200 (the reconciliation of the start-up has not ended, or
 *   ended with an error);
 * - `down`: no daemon answers (no `api.json`, a stale one, a refused connection), or the one that
 *   answers is not the new one (same pid as the old, or another version).
 */
export type HealthReading = 'ok' | 'unhealthy' | 'down';

export interface HealthExpectation {
  /** The version that must answer. */
  readonly version: string;
  /** The pid of the daemon that went away: an answer from it is not the new daemon's. 0: any. */
  readonly notPid: number;
}

export type HealthProbe = (expect: HealthExpectation) => Promise<HealthReading>;

export interface HealthProbeOptions {
  readonly dataDir: string;
  readonly fetch?: typeof fetch | undefined;
  /** How long one request may take. Default 5 s. */
  readonly requestTimeoutMs?: number | undefined;
  readonly alive?: ((pid: number) => boolean) | undefined;
}

/** The real probe: reads `api.json` and the token from the data folder, as a client does. */
export function createHealthProbe(options: HealthProbeOptions): HealthProbe {
  const paths = dataPaths(options.dataDir);
  const request = options.fetch ?? fetch;
  return async (expect) => {
    const reading = await readDiscovery(paths.apiDiscovery, options.alive);
    if (reading.kind !== 'live') return 'down';
    if (expect.notPid > 0 && reading.info.pid === expect.notPid) return 'down';
    const token = await readApiToken(paths.apiToken);
    if (token === undefined) return 'down';
    let response: Response;
    try {
      response = await request(`${reading.info.url}/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 5000),
      });
    } catch {
      return 'down';
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return 'unhealthy';
    }
    try {
      const health = ApiHealthSchema.parse(await response.json());
      return health.version === expect.version && health.pid === reading.info.pid ? 'ok' : 'down';
    } catch {
      return 'unhealthy';
    }
  };
}
