// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The spending cap of an API profile in the configuration (architecture 5.6, "Teto de gasto em
 * API"; Phase 5, P11): `profiles.<client>/<profile>.budget`, `executors.<id>.budget` and the
 * `budget` section. The architecture fixes the keys `daily_usd`, `monthly_usd`, `warn_at`,
 * `on_exceeded` and `in_flight` and their modes; the `budget` section (`timezone`, `unknown_cost`,
 * `ask_timeout`) and the `warn_at` of an Executor are [proposta].
 *
 * Only the spending of an API profile counts (`costKind: real`): a subscription has no money
 * cost, so a cap written for one never triggers (its estimate is `api_equivalent`).
 */

/** `profiles.<id>.budget.on_exceeded` (5.6): what happens to a demand when the cap is spent. */
export const BUDGET_ON_EXCEEDED_MODES = ['skip', 'wait', 'ask'] as const;
export type BudgetOnExceeded = (typeof BUDGET_ON_EXCEEDED_MODES)[number];

/** `profiles.<id>.budget.in_flight` (5.6): what a session in progress does when the cap is hit. */
export const BUDGET_IN_FLIGHT_MODES = ['handoff', 'finish', 'stop'] as const;
export type BudgetInFlight = (typeof BUDGET_IN_FLIGHT_MODES)[number];

/**
 * `budget.unknown_cost` [proposta]: what a turn whose cost nobody knew does to the cap. `ignore`
 * sums only the costs that are known (the spending is then a lower bound, as P10 reports it);
 * `block` takes any unknown-cost turn of the period as a breach of the profile's cap, because the
 * cap can no longer be shown to hold.
 */
export const BUDGET_UNKNOWN_COST_MODES = ['ignore', 'block'] as const;
export type BudgetUnknownCost = (typeof BUDGET_UNKNOWN_COST_MODES)[number];

/**
 * `budget.on_cap_change` [proposta, owner's answer of 2026-11-18]: what a cap that is `exhausted`
 * does when the configuration is read again and the profile's cap is raised above the spending of
 * the period, or removed. `release` (default) lets the profile go at once, with `budget.restored`
 * and the reason `config`; `keep` holds it until the period turns.
 */
export const BUDGET_ON_CAP_CHANGE_MODES = ['release', 'keep'] as const;
export type BudgetOnCapChange = (typeof BUDGET_ON_CAP_CHANGE_MODES)[number];

const oneOf = (key: string, values: readonly string[]) => ({
  error: (issue: { input?: unknown }) =>
    `${key}: ${JSON.stringify(issue.input)} is not accepted; use ${values.map((v) => `"${v}"`).join(', ')}`,
});

const UsdSchema = z.number({ error: 'a cap in US$, such as 5 or 12.5' }).gt(0);

/**
 * `warn_at`: the fractions of the cap that warn (0.8 is 80%). `[]` turns the warning off. Sorted
 * and without repeats.
 */
const WarnAtSchema = z
  .array(z.number().gt(0).max(1), {
    error: 'warn_at: a list of fractions of the cap, such as [0.8]',
  })
  .transform((fractions) => [...new Set(fractions)].sort((a, b) => a - b));

/** The part of a cap an Executor and a profile have in common. */
const limitKeys = {
  daily_usd: UsdSchema.optional(),
  monthly_usd: UsdSchema.optional(),
  warn_at: WarnAtSchema.default([0.8]),
};

/** `executors.<id>.budget`: inside the cap of its profile; the most restrictive wins (5.6). */
export const ExecutorBudgetSchema = z.strictObject(limitKeys);
export type ExecutorBudgetConfig = z.output<typeof ExecutorBudgetSchema>;

/** `profiles.<client>/<profile>.budget`. */
export const ProfileBudgetSchema = z.strictObject({
  ...limitKeys,
  on_exceeded: z
    .enum(BUDGET_ON_EXCEEDED_MODES, oneOf('on_exceeded', BUDGET_ON_EXCEEDED_MODES))
    .default('skip'),
  in_flight: z
    .enum(BUDGET_IN_FLIGHT_MODES, oneOf('in_flight', BUDGET_IN_FLIGHT_MODES))
    .default('handoff'),
});
export type ProfileBudgetConfig = z.output<typeof ProfileBudgetSchema>;
