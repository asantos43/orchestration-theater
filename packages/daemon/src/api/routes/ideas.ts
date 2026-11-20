// SPDX-License-Identifier: MPL-2.0
import { NotFound } from '@otheater/core';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';

export function registerIdeaRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store } = deps;

  handlers.register('listIdeas', async ({ query }) => {
    const rows = await store.ideas.list({
      ...(query.scenarioId === undefined ? {} : { scenarioId: query.scenarioId }),
      ...(query.playId === undefined ? {} : { playId: query.playId }),
      ...(query.groupId === undefined ? {} : { groupId: query.groupId }),
      ...(query.state === undefined ? {} : { states: [query.state] }),
    });
    return paginate(rows, (item) => [item.seq], query);
  });

  handlers.register('getIdea', async ({ params }) => {
    const idea = await store.ideas.get(params.ideaId);
    if (idea === undefined) throw new NotFound(`There is no idea "${params.ideaId}"`);
    return idea;
  });
}
