// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payload of the `usage.recorded` event (architecture 5.6, "Custo em moeda"; Phase 5, P10).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; a strict object.
 * [proposta] The event name and the fields below; the architecture only says the consumption is
 * recorded per turn. The profile is its complete id `<client>/<profile>`, as in the configuration.
 */

const epochMs = z.int().min(0);
const tokens = z.int().min(0).nullable();

/** Where the cost of a turn came from: the client reported it, or the daemon priced the tokens. */
export const USAGE_RECORDED_COST_SOURCES = ['client', 'pricing_table'] as const;
/** `real` is what the account was charged; `api_equivalent` is what the tokens would cost by API. */
export const USAGE_RECORDED_COST_KINDS = ['real', 'api_equivalent'] as const;

/**
 * `usage.recorded`: a turn (or a model call) was written to the `usage` table. A token count the
 * client did not report is null, and a cost nobody could work out is null in `costUsd`, `costKind`,
 * `costSource` and `pricingVersion` together: an unknown cost is never US$ 0.
 */
export const UsageRecordedPayloadSchema = z.strictObject({
  /** The `U<n>` id of the row in `usage`. */
  usageId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(256),
  /** The play the turn belongs to; null for a session outside a play. */
  playId: z.string().min(1).max(256).nullable(),
  profile: z.string().min(1).max(256),
  /** The Executor (`<model>-<effort>@<client>/<profile>`) that ran the turn. */
  executor: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  inputTokens: tokens,
  outputTokens: tokens,
  /** Tokens read from the provider cache. */
  cachedTokens: tokens,
  costUsd: z.number().min(0).nullable(),
  costKind: z.enum(USAGE_RECORDED_COST_KINDS).nullable(),
  costSource: z.enum(USAGE_RECORDED_COST_SOURCES).nullable(),
  /** Version of the price table, when `costSource` is `pricing_table`. */
  pricingVersion: z.string().min(1).max(64).nullable(),
  occurredAt: epochMs,
});

/**
 * What a `usage.notice` tells (Phase 5, P24, N146, [proposta]): `bad_token_count` and `bad_cost` (a
 * report with a count or a cost that is not a valid number; the turn is not recorded), `no_profile`
 * (a report of a session that belongs to no known profile), `provider_billing_unavailable`
 * (`usage.cost_source: provider_billing` has no adapter yet, so the service works as
 * `client_then_pricing`), `unknown_profile_kind` (a profile the store does not know; its usage is
 * taken as a subscription) and `cap_question_failed` (asking the Producer about a spent spending cap
 * failed, so the cap is skipped as in an unattended run).
 */
export const USAGE_NOTICE_KINDS = [
  'bad_token_count',
  'bad_cost',
  'no_profile',
  'provider_billing_unavailable',
  'unknown_profile_kind',
  'cap_question_failed',
] as const;
export type UsageNoticeKind = (typeof USAGE_NOTICE_KINDS)[number];

/**
 * `usage.notice` (P24, N146, [proposta]): a situation of the consumption that the daemon used to
 * only log. `sessionId` and `profile` are what the situation knows (null when it knows neither);
 * `detail` is masked and cut text, never a secret.
 */
export const UsageNoticePayloadSchema = z.strictObject({
  kind: z.enum(USAGE_NOTICE_KINDS),
  sessionId: z.string().min(1).max(256).nullable(),
  profile: z.string().min(1).max(256).nullable(),
  detail: z.string().min(1).max(512).optional(),
});
