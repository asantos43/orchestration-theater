// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { BUDGET_PERIODS } from '../quota-events.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * Consumption and the spending cap (P5 of docs/17). [proposta] Money is in US$. `realUsd` is what
 * the accounts were charged (API profiles); `apiEquivalentUsd` is what a subscription's tokens would
 * cost by API, an estimate that is never added to `realUsd`. A cost nobody knew is counted in
 * `unknownCostTurns`, never added as zero.
 */

export const ApiUsageTotalsSchema = z.strictObject({
  turns: z.int().min(0),
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  cachedTokens: z.int().min(0),
  realUsd: z.number().min(0),
  apiEquivalentUsd: z.number().min(0),
  unknownCostTurns: z.int().min(0),
  /** False when `unknownCostTurns` is above zero: the sums are then a lower bound. */
  complete: z.boolean(),
});
export type ApiUsageTotals = z.infer<typeof ApiUsageTotalsSchema>;

export const USAGE_GROUP_BY = ['session', 'play', 'profile', 'executor'] as const;

export const ApiUsageSchema = z.strictObject({
  totals: ApiUsageTotalsSchema,
  /** The same sums split by `by`; null when `by` was not asked. The groups add up to `totals`. */
  by: z.enum(USAGE_GROUP_BY).nullable(),
  groups: z
    .array(
      z.strictObject({
        /** The session, play, profile or Executor; null for the turns of no play. */
        key: z.string().nullable(),
        totals: ApiUsageTotalsSchema,
      }),
    )
    .nullable(),
});
export type ApiUsage = z.infer<typeof ApiUsageSchema>;

/** An instant as epoch milliseconds. */
const EpochQuerySchema = z.coerce.number().int().min(0);

export const UsageQuerySchema = z.strictObject({
  by: z.enum(USAGE_GROUP_BY).optional(),
  profileId: z.string().min(1).max(256).optional(),
  executorId: z.string().min(1).max(256).optional(),
  playId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  /** Turns at or after this moment (epoch ms). */
  since: EpochQuerySchema.optional(),
  /** Turns at or before this moment (epoch ms). */
  until: EpochQuerySchema.optional(),
});
export type UsageQuery = z.input<typeof UsageQuerySchema>;

export const getUsage = defineRoute({
  id: 'getUsage',
  method: 'GET',
  path: '/v1/usage',
  summary: 'Consumption totals, optionally split by session, play, profile or Executor',
  query: UsageQuerySchema,
  response: ApiUsageSchema,
});

export const ApiBudgetCapSchema = z.strictObject({
  scope: z.enum(['profile', 'executor', 'run']),
  /** The profile id or the Executor name; null for the run budget. */
  id: z.string().nullable(),
  period: z.enum([...BUDGET_PERIODS, 'run']),
  limitUsd: z.number().min(0),
  spentUsd: z.number().min(0),
  remainingUsd: z.number().min(0),
  /** When the period turns and the count starts over (epoch ms); null for the run budget. */
  endsAt: z.int().min(0).nullable(),
  unknownCostTurns: z.int().min(0),
  blockedByUnknownCost: z.boolean(),
});
export type ApiBudgetCap = z.infer<typeof ApiBudgetCapSchema>;

export const ApiBudgetSchema = z.strictObject({
  timezone: z.string().min(1),
  unknownCost: z.string().min(1),
  onCapChange: z.string().min(1),
  /** Every cap in force, with what was spent in its period. */
  caps: z.array(ApiBudgetCapSchema),
  /** The profiles whose caps are spent now. */
  exceeded: z.array(
    z.strictObject({
      profile: z.string().min(1),
      resetsAt: z.int().min(0),
      onExceeded: z.string().min(1),
    }),
  ),
});
export type ApiBudget = z.infer<typeof ApiBudgetSchema>;

export const getBudget = defineRoute({
  id: 'getBudget',
  method: 'GET',
  path: '/v1/budget',
  summary: 'The spending caps (per profile and per Executor) with what each has spent',
  response: ApiBudgetSchema,
});

export const USAGE_ROUTES = defineRoutes(getUsage, getBudget);
