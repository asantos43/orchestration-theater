// SPDX-License-Identifier: MPL-2.0
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';

/**
 * The read route of the ATIF export of a play (Phase 8, P5; N219): the play folded into an ATIF
 * v1.8 trajectory when it is asked for. It writes no file and records no event; the files are the
 * business of `atif.export.*` and of `ot trajectory export`. An unknown play or attempt is a 404
 * through the `NotFound` of the core.
 */
export function registerAtifRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { atif } = deps;

  handlers.register('getPlayAtif', async ({ params, query }) => {
    if (atif === undefined) {
      throw new ApiFailure('unavailable', 'This daemon runs without the ATIF exporter');
    }
    return atif.trajectory(params.playId, {
      ...(query.content === undefined ? {} : { content: query.content }),
      ...(query.attemptId === undefined ? {} : { attemptId: query.attemptId }),
    });
  });
}
