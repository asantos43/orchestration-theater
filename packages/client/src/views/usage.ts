// SPDX-License-Identifier: MPL-2.0
import type { ApiBudget, ApiBudgetCap, ApiUsage, ApiUsageTotals } from '@otheater/protocol';

/**
 * What the Usage tab shows of `GET /v1/usage` and `GET /v1/budget` (P13 of docs/18). Pure: the
 * numbers are formatted here, the words are the interface's. The telemetry panels are of Phase 8.
 */

export interface UsageRow {
  /** The profile, Executor, play or session; `undefined` for the turns of no play. */
  readonly key: string | undefined;
  readonly totals: ApiUsageTotals;
}

export interface UsageView {
  readonly totals: ApiUsageTotals;
  readonly by: ApiUsage['by'];
  readonly rows: readonly UsageRow[];
}

/** Rows sorted by what was spent (real dollars, then the API equivalent), then by key. */
export function usageView(usage: ApiUsage): UsageView {
  const rows = (usage.groups ?? [])
    .map((group): UsageRow => ({ key: group.key ?? undefined, totals: group.totals }))
    .sort(
      (a, b) =>
        b.totals.realUsd - a.totals.realUsd ||
        b.totals.apiEquivalentUsd - a.totals.apiEquivalentUsd ||
        (a.key ?? '').localeCompare(b.key ?? ''),
    );
  return { totals: usage.totals, by: usage.by, rows };
}

export interface CapRow {
  readonly scope: ApiBudgetCap['scope'];
  readonly id: string | undefined;
  readonly period: ApiBudgetCap['period'];
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  /** Percent of the cap spent, 0 to 100 (a cap of zero is 100). */
  readonly percent: number;
  readonly endsAt: number | undefined;
  readonly blockedByUnknownCost: boolean;
  readonly exceeded: boolean;
}

export interface BudgetView {
  readonly timezone: string;
  readonly caps: readonly CapRow[];
  /** Profiles whose caps are spent now. */
  readonly exceeded: readonly { readonly profile: string; readonly resetsAt: number }[];
}

export function budgetView(budget: ApiBudget): BudgetView {
  const caps = budget.caps.map((cap): CapRow => {
    const percent =
      cap.limitUsd <= 0
        ? 100
        : Math.max(0, Math.min(100, Math.round((cap.spentUsd / cap.limitUsd) * 100)));
    return {
      scope: cap.scope,
      id: cap.id ?? undefined,
      period: cap.period,
      limitUsd: cap.limitUsd,
      spentUsd: cap.spentUsd,
      remainingUsd: cap.remainingUsd,
      percent,
      endsAt: cap.endsAt ?? undefined,
      blockedByUnknownCost: cap.blockedByUnknownCost,
      exceeded: cap.remainingUsd <= 0,
    };
  });
  return {
    timezone: budget.timezone,
    caps,
    exceeded: budget.exceeded.map((item) => ({ profile: item.profile, resetsAt: item.resetsAt })),
  };
}

/** `812`, `12.3k`, `1.2M`: the token counts of a table cell. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/** `US$ 0.0123`: four decimals under a dollar (small turns are worth seeing), two above. */
export function formatUsd(value: number): string {
  return `US$ ${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}
