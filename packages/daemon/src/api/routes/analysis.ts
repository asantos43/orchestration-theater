// SPDX-License-Identifier: MPL-2.0
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';

/**
 * The read route of the analysis of the system (Phase 8, P9; N55 and N217): the report over the
 * daily aggregates. It reads only the aggregates, never the raw telemetry, and records no event.
 * A bad period is a 400 through the `InvalidInput` of the core.
 */
export function registerAnalysisRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { analysis } = deps;

  handlers.register('getAnalysis', async ({ query }) => {
    if (analysis === undefined) {
      throw new ApiFailure(
        'unavailable',
        'This daemon runs without the telemetry base, so it has no aggregates',
      );
    }
    return analysis.report(query);
  });
}
