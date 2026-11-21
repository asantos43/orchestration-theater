// SPDX-License-Identifier: MPL-2.0
import type { ApiBudget, ApiUsage, ApiUsageTotals } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { budgetView, formatTokens, formatUsd, usageView } from './usage.js';

function totals(extra: Partial<ApiUsageTotals> = {}): ApiUsageTotals {
  return {
    turns: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    realUsd: 0,
    apiEquivalentUsd: 0,
    unknownCostTurns: 0,
    complete: true,
    ...extra,
  };
}

describe('usageView', () => {
  it('sorts the groups by real dollars, then by the API equivalent, then by key', () => {
    const usage: ApiUsage = {
      totals: totals({ turns: 4 }),
      by: 'profile',
      groups: [
        { key: 'b', totals: totals({ apiEquivalentUsd: 2 }) },
        { key: 'a', totals: totals({ apiEquivalentUsd: 2 }) },
        { key: null, totals: totals({ realUsd: 1 }) },
        { key: 'c', totals: totals() },
      ],
    };
    const view = usageView(usage);
    expect(view.rows.map((row) => row.key)).toEqual([undefined, 'a', 'b', 'c']);
    expect(view.by).toBe('profile');
  });

  it('has no rows when the totals are not split', () => {
    expect(usageView({ totals: totals(), by: null, groups: null }).rows).toEqual([]);
  });
});

describe('budgetView', () => {
  const budget: ApiBudget = {
    timezone: 'America/Sao_Paulo',
    unknownCost: 'block',
    onCapChange: 'keep',
    caps: [
      {
        scope: 'profile',
        id: 'main',
        period: 'day',
        limitUsd: 10,
        spentUsd: 2.5,
        remainingUsd: 7.5,
        endsAt: 99,
        unknownCostTurns: 0,
        blockedByUnknownCost: false,
      },
      {
        scope: 'run',
        id: null,
        period: 'run',
        limitUsd: 0,
        spentUsd: 0,
        remainingUsd: 0,
        endsAt: null,
        unknownCostTurns: 2,
        blockedByUnknownCost: true,
      },
    ],
    exceeded: [{ profile: 'main', resetsAt: 99, onExceeded: 'wait' }],
  };

  it('works out the percent and the exceeded flag of each cap', () => {
    const view = budgetView(budget);
    expect(view.caps[0]).toMatchObject({ id: 'main', percent: 25, exceeded: false, endsAt: 99 });
    expect(view.caps[1]).toMatchObject({
      id: undefined,
      percent: 100,
      exceeded: true,
      endsAt: undefined,
      blockedByUnknownCost: true,
    });
    expect(view.exceeded).toEqual([{ profile: 'main', resetsAt: 99 }]);
    expect(view.timezone).toBe('America/Sao_Paulo');
  });
});

describe('the number formats', () => {
  it('shortens big token counts and keeps small ones whole', () => {
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });

  it('shows four decimals under a dollar and two above', () => {
    expect(formatUsd(0.0123)).toBe('US$ 0.0123');
    expect(formatUsd(12.345)).toBe('US$ 12.35');
    expect(formatUsd(0)).toBe('US$ 0.0000');
  });
});
