// SPDX-License-Identifier: MPL-2.0
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';

/**
 * The read routes of the telemetry panels (Phase 8, P10; [proposta]): the spans the daemon made for
 * a play, and the state of the receiver, the base and the export. Both only read and record no
 * event. An unknown play is a 404 through the `NotFound` of the core.
 */
export function registerTelemetryRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { playSpans, telemetryStatus } = deps;

  handlers.register('getPlaySpans', async ({ params, query }) => {
    if (playSpans === undefined) {
      throw new ApiFailure(
        'unavailable',
        'This daemon runs without the telemetry base, so it has no spans',
      );
    }
    return playSpans.read(params.playId, { limit: query.limit });
  });

  handlers.register('getTelemetryStatus', async () => {
    if (telemetryStatus === undefined) {
      throw new ApiFailure('unavailable', 'This daemon does not report the telemetry state');
    }
    return telemetryStatus.read();
  });
}
