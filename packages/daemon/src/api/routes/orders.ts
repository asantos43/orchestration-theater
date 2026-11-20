// SPDX-License-Identifier: MPL-2.0
import { NotFound, type DirectiveState } from '@otheater/core';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';

export function registerOrderRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store } = deps;

  handlers.register('listOrders', async ({ query }) => {
    // `ended` is what is no longer in force: expired by the clock, or revoked.
    const states: readonly DirectiveState[] | undefined =
      query.state === undefined
        ? undefined
        : query.state === 'ended'
          ? ['expired', 'revoked']
          : [query.state];
    const rows = await store.directives.list({
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      ...(query.kind === undefined ? {} : { kinds: [query.kind] }),
      ...(query.scenarioId === undefined ? {} : { scenarioId: query.scenarioId }),
      ...(states === undefined ? {} : { states }),
    });
    return paginate(rows, (item) => [item.seq], query);
  });

  handlers.register('getOrder', async ({ params }) => {
    const order = await store.directives.get(params.orderId);
    if (order === undefined) throw new NotFound(`There is no order "${params.orderId}"`);
    return order;
  });
}
