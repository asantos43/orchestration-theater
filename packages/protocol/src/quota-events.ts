// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the `quota.*` events (architecture 5.6, "Estado por perfil" and "Retomada quando a
 * cota ou o teto voltam"; Phase 5, P5). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at
 * `schemaVersion` 1. Every payload is a strict object.
 * [proposta] The event names and the fields below; the architecture only names `quota.restored`.
 * The profile is always its complete id `<client>/<profile>`, as in the configuration keys.
 */

const profile = z.string().min(1).max(256);
const epochMs = z.int().min(0);

/** The states of a profile (architecture 5.6): `ok | near_limit | exhausted | unknown`. */
export const QUOTA_STATES = ['ok', 'near_limit', 'exhausted', 'unknown'] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];

/** Why a profile is `exhausted` (architecture 5.6): the plan quota, or the API spending cap. */
export const QUOTA_CAUSES = ['quota', 'budget'] as const;
export type QuotaCause = (typeof QUOTA_CAUSES)[number];

/** What the service holds of one window of a profile. */
export const QuotaWindowPayloadSchema = z.strictObject({
  window: z.string().min(1).max(64),
  usedPercent: z.number().min(0),
  /** When the window resets; null when the source does not say. */
  resetsAt: epochMs.nullable(),
  /** When the source saw it. */
  observedAt: epochMs,
});

/**
 * `quota.updated`: the reading of a profile changed (a probe, a signal of a session, a limit
 * error) or its state did. `source` says where it came from (`probe`, `client_signal`,
 * `limit_hit:<source>`, `time` when only the clock moved the state: a reset or a stale reading).
 */
export const QuotaUpdatedPayloadSchema = z.strictObject({
  profile,
  state: z.enum(QUOTA_STATES),
  source: z.string().min(1).max(256),
  windows: z.array(QuotaWindowPayloadSchema),
  planType: z.string().min(1).max(64).optional(),
});

/** `quota.near_limit`: the profile entered `near_limit` (a window passed `quota.near_limit_at`). */
export const QuotaNearLimitPayloadSchema = z.strictObject({
  profile,
  window: z.string().min(1).max(64),
  usedPercent: z.number().min(0),
  resetsAt: epochMs.nullable(),
  /** `quota.near_limit_at` as a percent (80 for 0.8). */
  thresholdPercent: z.number().min(0).max(100),
});

/** `quota.exhausted`: the profile entered `exhausted`; `untilReset` is null when no source says it. */
export const QuotaExhaustedPayloadSchema = z.strictObject({
  profile,
  cause: z.enum(QUOTA_CAUSES),
  untilReset: epochMs.nullable(),
  source: z.string().min(1).max(256),
});

/**
 * `quota.restored`: the profile left `exhausted`. `reason` is `reset` (the time came), `reading`
 * (a fresh reading shows room) or `recheck` (no reset time was known and the recheck interval
 * passed with no signal that costs nothing, so the profile is `unknown`; P9). `state` is where it
 * stands now.
 */
export const RESTORED_REASONS = ['reset', 'reading', 'recheck'] as const;
export const RESTORED_STATES = ['ok', 'near_limit', 'unknown'] as const;
/**
 * Why a spending cap let the profile go (P11b, [proposta]): the reasons of a quota, and `config`,
 * when `budget.on_cap_change: release` found the cap raised or removed in the configuration.
 */
export const BUDGET_RESTORED_REASONS = [...RESTORED_REASONS, 'config'] as const;

export const QuotaRestoredPayloadSchema = z.strictObject({
  profile,
  cause: z.enum(QUOTA_CAUSES),
  state: z.enum(RESTORED_STATES),
  reason: z.enum(RESTORED_REASONS),
});

/**
 * `budget.restored` (P9, [proposta]): the profile left `exhausted` with the cause `budget`, because
 * the period of the spending cap turned (or a fresh reading shows room). The same move as
 * `quota.restored` for the cause `quota`; the cause is the name of the event, so it is not a field.
 */
export const BudgetRestoredPayloadSchema = z.strictObject({
  profile,
  state: z.enum(RESTORED_STATES),
  reason: z.enum(BUDGET_RESTORED_REASONS),
});

/** The periods of a spending cap (architecture 5.6): the calendar day and the calendar month. */
export const BUDGET_PERIODS = ['day', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/**
 * `budget.warning` (P11, [proposta]): the spending of a profile (or of one Executor) in a period
 * passed one of the `warn_at` fractions of its cap. It is written once per threshold and period.
 * `executor` is the Executor name when the cap that warned is `executors.<id>.budget`, and null
 * when it is the profile's. `thresholdFraction` is the `warn_at` entry that was crossed (0.8 for
 * 80%); `spentUsd` and `limitUsd` are US$; `periodEndsAt` is when the period turns and the count
 * starts over.
 */
export const BudgetWarningPayloadSchema = z.strictObject({
  profile,
  executor: z.string().min(1).max(256).nullable(),
  period: z.enum(BUDGET_PERIODS),
  thresholdFraction: z.number().gt(0).max(1),
  spentUsd: z.number().min(0),
  limitUsd: z.number().gt(0),
  periodEndsAt: epochMs,
});

/**
 * `budget.exceeded` (P11b, [proposta]): the spending of a cap passed its limit. It is written once
 * per cap and period (and per limit, so a cap that was raised and spent again is told again).
 * `executor` is the Executor name when the cap is `executors.<id>.budget` (the profile is then the
 * one it belongs to) and null when it is the profile's own cap, which also puts the profile in
 * `exhausted(budget)`. `spentUsd` and `limitUsd` are US$ (`spentUsd` is below the limit when
 * `budget.unknown_cost: block` made the cap spent); `endsAt` is when the period turns and the
 * count starts over.
 */
export const BudgetExceededPayloadSchema = z.strictObject({
  profile,
  executor: z.string().min(1).max(256).nullable(),
  period: z.enum(BUDGET_PERIODS),
  spentUsd: z.number().min(0),
  limitUsd: z.number().gt(0),
  endsAt: epochMs,
});

/**
 * `budget.unknown_cost` (P11b, N139 revista em 2026-11-18): a turn of a capped profile or Executor
 * had no known cost under `budget.unknown_cost: ignore`, so the cap did not count it. It is written
 * once per model per life of the daemon, alongside the `warn` line of the log; `pricing.<model>`
 * in the configuration gives the model a price. `executor` is the Executor of the turn and
 * `profile` its profile. The daemon cannot tell a model without a price from a turn without tokens:
 * both leave the cost unknown.
 */
export const BudgetUnknownCostPayloadSchema = z.strictObject({
  model: z.string().min(1).max(256),
  profile,
  executor: z.string().min(1).max(256),
  mode: z.enum(['ignore']),
});

/** Short text an event may carry: already masked and cut by the daemon, never a stack. */
const detail = z.string().min(1).max(512);

/**
 * Why a probe of the quota could not read a profile (Phase 5, P24, N146, [proposta]): `no_key` (a
 * MiniMax profile with no key in the vault), `rate_limited` (HTTP 429; `backoffMs` says how long the
 * probe stays quiet), `unauthorized` (HTTP 401 or 403: the key was not accepted), `no_reading` (the
 * answer is an envelope that is not a success), `unknown_format` (an answer the parser does not
 * know), `read_failed` (any other failure of a read, the first one or the poll), `watch_failed` (the
 * probe could not start watching) and `push_unsupported` (`quota.probe.delivery: push` and the probe
 * cannot watch, so it is not used).
 */
export const QUOTA_PROBE_FAILURES = [
  'no_key',
  'rate_limited',
  'unauthorized',
  'no_reading',
  'unknown_format',
  'read_failed',
  'watch_failed',
  'push_unsupported',
] as const;
export type QuotaProbeFailure = (typeof QUOTA_PROBE_FAILURES)[number];

/**
 * `quota.probe_failed` (P24, N146, [proposta]): a probe gave no reading of a profile, so the state of
 * the profile did not move (it goes `unknown` when the reading grows stale). It is the event beside
 * the `warn` line of the log: one per failure the log writes (the MiniMax probe thins both out the
 * same way). `status` is the HTTP status or the code of the envelope when there is one, `backoffMs`
 * the wait of `rate_limited`, and `detail` what failed, masked and cut: never the key.
 */
export const QuotaProbeFailedPayloadSchema = z.strictObject({
  profile,
  reason: z.enum(QUOTA_PROBE_FAILURES),
  status: z.int().optional(),
  backoffMs: z.int().min(0).optional(),
  detail: detail.optional(),
});

/**
 * What the quota service dropped (P24, N146, [proposta]): `invalid_signal` (a `_otheater/quota/signal`
 * that is not valid), `no_profile` (a signal or a limit error of a session that belongs to no known
 * profile), `bad_reading` (a reading of a probe that does not fit the schema), `usage_not_taken` (the
 * probe could not take a usage), `missed_update` and `missed_limit_error` (the service failed while
 * it took an update or a limit error of a session, so the quota may be behind the truth).
 */
export const QUOTA_SIGNAL_DROPS = [
  'invalid_signal',
  'no_profile',
  'bad_reading',
  'usage_not_taken',
  'missed_update',
  'missed_limit_error',
] as const;
export type QuotaSignalDrop = (typeof QUOTA_SIGNAL_DROPS)[number];

/**
 * `quota.signal_dropped` (P24, N146, [proposta]): a signal, a reading or a limit error did not reach
 * the quota state. `profile` and `sessionId` are null when the drop does not know them (an invalid
 * signal has no session worth naming; a reading has no session).
 */
export const QuotaSignalDroppedPayloadSchema = z.strictObject({
  profile: profile.nullable(),
  sessionId: z.string().min(1).max(256).nullable(),
  reason: z.enum(QUOTA_SIGNAL_DROPS),
  detail: detail.optional(),
});
