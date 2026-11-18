// SPDX-License-Identifier: MPL-2.0
import type {
  BudgetInFlight,
  BudgetOnCapChange,
  BudgetOnExceeded,
  BudgetUnknownCost,
} from '../budget-config.js';
import type { DaemonConfig } from '../config.js';

/** The caps of one subject (a profile or an Executor): what is spent per day and per month. */
export interface BudgetLimits {
  /** US$ per calendar day; `undefined` when the day has no cap. */
  readonly dailyUsd: number | undefined;
  /** US$ per calendar month; `undefined` when the month has no cap. */
  readonly monthlyUsd: number | undefined;
  /** The fractions of the caps that warn, ascending (0.8 is 80%); empty turns the warning off. */
  readonly warnAt: readonly number[];
}

/** What the `BudgetService` takes of one `profiles.<id>.budget`. */
export interface ProfileBudget extends BudgetLimits {
  readonly onExceeded: BudgetOnExceeded;
  readonly inFlight: BudgetInFlight;
}

/** What the `BudgetService` takes of the `profiles`, `executors` and `budget` sections (5.6; P11). */
export interface BudgetSettings {
  /** `budget.timezone`: the zone whose midnight and day 1 turn the period. */
  readonly timezone: string;
  /** `budget.unknown_cost`. */
  readonly unknownCost: BudgetUnknownCost;
  /** `budget.on_cap_change`. */
  readonly onCapChange: BudgetOnCapChange;
  /** `budget.ask_timeout` in ms: how long `on_exceeded: ask` waits before it becomes `skip`. */
  readonly askTimeoutMs: number;
  /** `profiles.<id>.budget`, by complete profile id. */
  readonly profiles: ReadonlyMap<string, ProfileBudget>;
  /** `executors.<id>.budget`, by Executor name. */
  readonly executors: ReadonlyMap<string, BudgetLimits>;
}

export function budgetSettingsOf(
  config: Pick<DaemonConfig, 'profiles' | 'executors' | 'budget'>,
): BudgetSettings {
  const profiles = new Map<string, ProfileBudget>();
  for (const [id, entry] of Object.entries(config.profiles.entries)) {
    const budget = entry.budget;
    if (budget === undefined) continue;
    profiles.set(id, {
      dailyUsd: budget.daily_usd,
      monthlyUsd: budget.monthly_usd,
      warnAt: budget.warn_at,
      onExceeded: budget.on_exceeded,
      inFlight: budget.in_flight,
    });
  }
  const executors = new Map<string, BudgetLimits>();
  for (const [id, budget] of Object.entries(config.executors.budgets)) {
    executors.set(id, {
      dailyUsd: budget.daily_usd,
      monthlyUsd: budget.monthly_usd,
      warnAt: budget.warn_at,
    });
  }
  return {
    timezone: config.budget.timezone,
    unknownCost: config.budget.unknown_cost,
    onCapChange: config.budget.on_cap_change,
    askTimeoutMs: config.budget.ask_timeout,
    profiles,
    executors,
  };
}
