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
