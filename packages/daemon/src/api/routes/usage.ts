// SPDX-License-Identifier: MPL-2.0
import type { UsageListFilter } from '@otheater/core';
import type { ApiBudget, ApiBudgetCap, ApiUsage, ApiUsageTotals } from '@otheater/protocol';
import { budgetSettingsOf } from '../../budget/index.js';
import type { UsageTotals } from '../../usage/index.js';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';

const totalsOf = (totals: UsageTotals): ApiUsageTotals => ({ ...totals });

export function registerUsageRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store, config, usage, budget } = deps;

  handlers.register('getUsage', async ({ query }) => {
    const filter: UsageListFilter = {
      ...(query.profileId === undefined ? {} : { profileId: query.profileId }),
      ...(query.executorId === undefined ? {} : { executorId: query.executorId }),
      ...(query.playId === undefined ? {} : { playId: query.playId }),
      ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.until === undefined ? {} : { until: query.until }),
    };
    const totals = totalsOf(await usage.totals(filter));
    const groups =
      query.by === undefined
        ? null
        : (await usage.breakdown(query.by, filter)).map((group) => ({
            key: group.key,
            totals: totalsOf(group.totals),
          }));
    const body: ApiUsage = { totals, by: query.by ?? null, groups };
    return body;
  });

  handlers.register('getBudget', async () => {
    const settings = budgetSettingsOf(config);
    // A cap is read through an Executor (the profile's caps come with it): every Executor of the
    // table and of the configuration, and every one that has a cap of its own.
    const executorIds = new Set<string>(Object.keys(config.executors.entries));
    for (const row of await store.executors.list()) executorIds.add(row.id);
    for (const id of Object.keys(config.executors.budgets)) executorIds.add(id);

    const caps = new Map<string, ApiBudgetCap>();
    for (const executorId of [...executorIds].sort()) {
      for (const cap of (await budget.headroom(executorId)).caps) {
        const key = `${cap.scope}\u0000${cap.id ?? ''}\u0000${cap.period}`;
        // Field by field: the service's reading carries more than the API gives (`warnAt`).
        if (!caps.has(key)) {
          caps.set(key, {
            scope: cap.scope,
            id: cap.id,
            period: cap.period,
            limitUsd: cap.limitUsd,
            spentUsd: cap.spentUsd,
            remainingUsd: cap.remainingUsd,
            endsAt: cap.endsAt,
            unknownCostTurns: cap.unknownCostTurns,
            blockedByUnknownCost: cap.blockedByUnknownCost,
          });
        }
      }
    }
    const exceeded: ApiBudget['exceeded'] = [];
    for (const profile of await store.profiles.list()) {
      const breach = budget.exceededOf(profile.id);
      if (breach !== undefined) {
        exceeded.push({
          profile: breach.profile,
          resetsAt: breach.resetsAt,
          onExceeded: breach.onExceeded,
        });
      }
    }
    const body: ApiBudget = {
      timezone: settings.timezone,
      unknownCost: settings.unknownCost,
      onCapChange: settings.onCapChange,
      caps: [...caps.values()],
      exceeded,
    };
    return body;
  });
}
