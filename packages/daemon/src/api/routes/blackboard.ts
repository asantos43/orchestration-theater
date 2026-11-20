// SPDX-License-Identifier: MPL-2.0
import { NotFound } from '@otheater/core';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';

export function registerBlackboardRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store } = deps;

  async function playExists(playId: string): Promise<void> {
    if ((await store.plays.get(playId)) === undefined) {
      throw new NotFound(`There is no play "${playId}"`);
    }
  }

  handlers.register('listBlackboard', async ({ params, query }) => {
    await playExists(params.playId);
    const rows = await store.blackboard.latest(params.playId);
    return paginate(rows, (item) => [item.key], query);
  });

  handlers.register('getBlackboardEntry', async ({ params, query }) => {
    await playExists(params.playId);
    const entry = await store.blackboard.get(params.playId, query.key, query.version);
    if (entry === undefined) {
      throw new NotFound(
        `The blackboard of play "${params.playId}" has no "${query.key}"${query.version === undefined ? '' : ` at version ${String(query.version)}`}`,
      );
    }
    return entry;
  });

  handlers.register('listBlackboardHistory', async ({ params, query }) => {
    await playExists(params.playId);
    const rows = await store.blackboard.history(params.playId, query.key);
    if (rows.length === 0) {
      throw new NotFound(`The blackboard of play "${params.playId}" has no "${query.key}"`);
    }
    return paginate(rows, (item) => [item.version], query);
  });
}
