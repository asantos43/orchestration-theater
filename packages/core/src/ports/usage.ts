// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, RecordIdSchema } from './store-schemas.js';

/**
 * The `usage` table (architecture section 7, 5.6): what each turn consumed, by session, profile,
 * Executor and model. [proposta] The columns below. A window of consumption (5h, 7d, a month) is
 * a range of `occurredAt` asked of `list`, not a column.
 */

/** Where the cost came from: the client reported it, or the daemon priced the tokens. */
export const USAGE_COST_SOURCES = ['client', 'pricing_table'] as const;
export type UsageCostSource = (typeof USAGE_COST_SOURCES)[number];

/** `real` is what the account was charged; `api_equivalent` is what the tokens would cost by API. */
export const USAGE_COST_KINDS = ['real', 'api_equivalent'] as const;
export type UsageCostKind = (typeof USAGE_COST_KINDS)[number];

/** Usage ids are `U<n>`, numbered across the whole store from 1. */
export const USAGE_ID_PATTERN = /^U[1-9][0-9]*$/;

const text = z.string().min(1);
const tokens = z.int().min(0);

/**
 * The cost of a turn. A cost that is not known is no cost at all (`cost` null), never zero.
 * `pricingVersion` is required when the source is `pricing_table`.
 */
export const UsageCostSchema = z.strictObject({
  usd: z.number().min(0),
  kind: z.enum(USAGE_COST_KINDS),
  source: z.enum(USAGE_COST_SOURCES),
  pricingVersion: text.optional(),
});
export type UsageCost = z.infer<typeof UsageCostSchema>;

/** One row of `usage`. */
export const UsageRecordSchema = z.strictObject({
  /** `U<n>`, assigned by the store. */
  id: z.string().regex(USAGE_ID_PATTERN),
  seq: z.int().min(1),
  sessionId: RecordIdSchema,
  playId: RecordIdSchema.nullable(),
  profileId: text,
  executorId: text,
  model: text,
  /** Token counts; null when the client did not report them (never a made-up zero). */
  inputTokens: tokens.nullable(),
  outputTokens: tokens.nullable(),
  cachedTokens: tokens.nullable(),
  /** Null while the cost is unknown; then `costKind`, `costSource` and `pricingVersion` are null too. */
  costUsd: z.number().min(0).nullable(),
  costKind: z.enum(USAGE_COST_KINDS).nullable(),
  costSource: z.enum(USAGE_COST_SOURCES).nullable(),
  /** Version of the price table, when `costSource` is `pricing_table`. */
  pricingVersion: text.nullable(),
  /** When the turn happened. */
  occurredAt: EpochMsSchema,
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/** What a caller writes; the store assigns `id`, `seq` and the dates (`occurredAt` defaults to now). */
export const NewUsageSchema = z.strictObject({
  sessionId: RecordIdSchema,
  playId: RecordIdSchema.optional(),
  profileId: text,
  executorId: text,
  model: text,
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  cachedTokens: tokens.optional(),
  cost: UsageCostSchema.optional(),
  occurredAt: EpochMsSchema.optional(),
});
export type NewUsage = z.infer<typeof NewUsageSchema>;

/** Fields `update` may change: what is known only after the turn (tokens, the priced cost). */
export const UsagePatchSchema = z.strictObject({
  inputTokens: tokens.optional(),
  outputTokens: tokens.optional(),
  cachedTokens: tokens.optional(),
  cost: UsageCostSchema.optional(),
});
export type UsagePatch = z.infer<typeof UsagePatchSchema>;

export interface UsageListFilter {
  readonly sessionId?: string;
  readonly playId?: string;
  readonly profileId?: string;
  readonly executorId?: string;
  /** Turns that happened at or after this moment (epoch ms). */
  readonly since?: number;
  /** Turns that happened at or before this moment (epoch ms). */
  readonly until?: number;
}

/**
 * Registry of usage, part of `Store`. Contract (`describeUsageConformance`):
 * - `record` validates (`InvalidInput`) and assigns `U<n>`; a token count or a cost left out is
 *   null (unknown, never zero); `pricingVersion` is required with the source `pricing_table`.
 * - `get` and `list`; `list` is ordered by `occurredAt`, then `seq`.
 * - `update(id, patch)`: `NotFound` for an unknown id, `InvalidInput` for a bad patch; fields
 *   left out keep their value.
 */
export interface UsageRegistry {
  record(input: NewUsage): Promise<UsageRecord>;
  get(id: string): Promise<UsageRecord | undefined>;
  list(filter?: UsageListFilter): Promise<readonly UsageRecord[]>;
  update(id: string, patch: UsagePatch): Promise<UsageRecord>;
}
