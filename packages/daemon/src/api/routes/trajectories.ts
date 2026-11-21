// SPDX-License-Identifier: MPL-2.0
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { decodeCursor, encodeCursor } from './paging.js';

/**
 * The read routes of the trajectory of a play (P14 of docs/18): the events it is built from, by
 * the cursor of the log (the key of a page is the id of the last event examined, so a page may
 * come with fewer than `limit` items and still have a next one), and the diff of a demand.
 */
export function registerTrajectoryRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { trajectory } = deps;

  handlers.register('listPlayTrajectory', async ({ params, query }) => {
    if (trajectory === undefined) throw unavailable();
    const after = query.after === undefined ? 0 : Number(decodeCursor(query.after, [0])[0]);
    const page = await trajectory.events(params.playId, after, query.limit);
    return {
      items: page.items,
      nextCursor: page.nextId === null ? null : encodeCursor([page.nextId]),
    };
  });

  handlers.register('getDemandDiff', async ({ params }) => {
    if (trajectory === undefined) throw unavailable();
    return trajectory.diff(params.playId, params.demandId);
  });
}

function unavailable(): ApiFailure {
  return new ApiFailure('unavailable', 'This daemon runs without the trajectory service');
}
