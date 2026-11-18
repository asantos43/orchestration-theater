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
 * `quota.restored`: the profile left `exhausted`. `reason` is `reset` (the time came) or `reading`
 * (a fresh reading shows room). `state` is where it stands now.
 */
export const QuotaRestoredPayloadSchema = z.strictObject({
  profile,
  cause: z.enum(QUOTA_CAUSES),
  state: z.enum(['ok', 'near_limit', 'unknown']),
  reason: z.enum(['reset', 'reading']),
});
