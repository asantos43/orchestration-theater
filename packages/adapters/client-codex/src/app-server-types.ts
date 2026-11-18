// SPDX-License-Identifier: MPL-2.0

/**
 * The part of the `codex app-server` protocol the quota probe uses: a reduced declaration of the
 * shapes `account/rateLimits/read` and `account/rateLimits/updated` carry. Written by hand from the
 * output of `codex app-server generate-ts` (codex-cli 0.170.0, run once on 2026-11-18 with an empty
 * `CODEX_HOME`, so no login and no network were involved) [V]. Only the fields the probe reads are
 * typed; everything else the server sends is `unknown`. The protocol is marked experimental by the
 * client itself, so the parser (`rate-limits.ts`) trusts none of this: it checks every field.
 */

/** Method names of the app-server (JSON-RPC, one JSON object per line on stdio) [V]. */
export const APP_SERVER_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  readRateLimits: 'account/rateLimits/read',
  rateLimitsUpdated: 'account/rateLimits/updated',
} as const;

/** `PlanType` of the client (20 values in 0.170.0). Kept as text: a new plan must not break the probe. */
export type CodexPlanType = string;

/** The `RateLimitReachedType` values of 0.170.0; any text is accepted, a non-null value means "reached". */
export type CodexRateLimitReachedType =
  | 'rate_limit_reached'
  | 'workspace_owner_credits_depleted'
  | 'workspace_member_credits_depleted'
  | 'workspace_owner_usage_limit_reached'
  | 'workspace_member_usage_limit_reached';

/** One window: `usedPercent` of the window, its length in minutes, and its reset in epoch SECONDS [V]. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

/** A bucket of limits. The historical single-bucket view of the read answer is this shape. */
export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: CodexPlanType | null;
  rateLimitReachedType: CodexRateLimitReachedType | null;
}

/** Params of `account/rateLimits/read`; both fields are optional in the protocol. */
export interface CodexGetRateLimitsParams {
  /** Skips the separate lookup of reset-credit details: for background polls. */
  excludeResetCreditDetails?: boolean;
}

/** The answer of `account/rateLimits/read` (fields the probe does not read are left out). */
export interface CodexGetRateLimitsResponse {
  /** The backward-compatible single-bucket view: the one the probe reads. */
  rateLimits: CodexRateLimitSnapshot;
  /** The multi-bucket view, keyed by the metered `limit_id` (`codex`). Only a fallback here. */
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot | undefined> | null;
}

/**
 * Params of `account/rateLimits/updated`: a sparse snapshot. The protocol says a client merges the
 * values it finds into the last read, or reads again.
 */
export interface CodexRateLimitsUpdatedParams {
  rateLimits: CodexRateLimitSnapshot;
}
