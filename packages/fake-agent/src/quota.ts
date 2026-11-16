// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/** Extension notification the agent shells send when a client reports quota data (arch. 5.6). */
export const QUOTA_SIGNAL_METHOD = '_otheater/quota/signal';

/**
 * JSON-RPC error code of a quota-exhausted prompt failure. [proposal] The code sits in the
 * implementation-defined server error range (-32000..-32099); the typed error travels in `data`.
 */
export const QUOTA_EXHAUSTED_CODE = -32001;

/** Payload of {@link QUOTA_SIGNAL_METHOD}, mirroring the `QuotaSignal` type of architecture 5.6. */
export const quotaSignalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('window'),
    window: z.string(),
    usedPercent: z.number(),
    resetsAt: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('usage'),
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number().optional(),
  }),
  z.strictObject({
    kind: z.literal('limit_hit'),
    resetsAt: z.string().optional(),
    source: z.string(),
  }),
]);

export type QuotaSignal = z.infer<typeof quotaSignalSchema>;

/**
 * Params of the notification. [proposal] The `sessionId` is added so the daemon can map the signal
 * to a profile; the signal itself carries no profile (arch. 5.6).
 */
export const quotaSignalParamsSchema = z.strictObject({
  sessionId: z.string(),
  signal: quotaSignalSchema,
});

export type QuotaSignalParams = z.infer<typeof quotaSignalParamsSchema>;

/** `data` of the JSON-RPC error returned when the quota is exhausted. [proposal] */
export const quotaExhaustedDataSchema = z.strictObject({
  type: z.literal('QuotaExhausted'),
  resetsAt: z.string().optional(),
});

export type QuotaExhaustedData = z.infer<typeof quotaExhaustedDataSchema>;
