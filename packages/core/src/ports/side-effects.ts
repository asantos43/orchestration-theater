// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, JsonObjectSchema, RecordIdSchema } from './store-schemas.js';

/**
 * State of a side effect (architecture 5.21 and section 7). `pending` is written before the
 * effect, then it resolves to `done`, `not_done` (checked: it did not happen) or `ambiguous` (a
 * "before" with no "after" that nobody could settle yet). [proposta] `failed`: the effect ran
 * and the tool reported an error.
 */
export const SIDE_EFFECT_STATES = ['pending', 'done', 'failed', 'not_done', 'ambiguous'] as const;
export type SideEffectState = (typeof SIDE_EFFECT_STATES)[number];

/** The states a side effect resolves to. */
export const SIDE_EFFECT_RESOLUTIONS = ['done', 'failed', 'not_done', 'ambiguous'] as const;
export type SideEffectResolution = (typeof SIDE_EFFECT_RESOLUTIONS)[number];

/** How an ambiguity was settled (5.21). [proposta] */
export const SIDE_EFFECT_VERIFIERS = ['verifier', 'producer'] as const;
export type SideEffectVerifier = (typeof SIDE_EFFECT_VERIFIERS)[number];

/** One row of `side_effects`, keyed by its idempotency key (`attempt + step`, 5.21). */
export const SideEffectRecordSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(512),
  /** The tool or kind of effect (`git_commit`, `git_push`, `open_pr`...). */
  type: z.string().min(1),
  /** What it acts on (a branch, a path, a PR...). */
  target: z.string().min(1),
  attemptId: RecordIdSchema.nullable(),
  /** Summary of the parameters, enough for a verifier to check the outcome. */
  params: JsonObjectSchema.nullable(),
  /** The recorded result, once resolved. */
  result: JsonObjectSchema.nullable(),
  state: z.enum(SIDE_EFFECT_STATES),
  /** Who settled an ambiguity, when one was settled. */
  verifier: z.enum(SIDE_EFFECT_VERIFIERS).nullable(),
  /** The moment before the effect. */
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** The moment after the effect (any resolution but `ambiguous`). */
  resolvedAt: EpochMsSchema.nullable(),
});
export type SideEffectRecord = z.infer<typeof SideEffectRecordSchema>;

export const NewSideEffectSchema = SideEffectRecordSchema.omit({
  result: true,
  state: true,
  verifier: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
}).partial({ attemptId: true, params: true });
export type NewSideEffect = z.infer<typeof NewSideEffectSchema>;

export const SideEffectResolutionInputSchema = z.strictObject({
  state: z.enum(SIDE_EFFECT_RESOLUTIONS),
  result: JsonObjectSchema.nullable().optional(),
  verifier: z.enum(SIDE_EFFECT_VERIFIERS).nullable().optional(),
});
export type SideEffectResolutionInput = z.infer<typeof SideEffectResolutionInputSchema>;

export interface SideEffectListFilter {
  readonly states?: readonly SideEffectState[];
  readonly types?: readonly string[];
  readonly attemptId?: string;
}

/**
 * Registry of side effects, part of `Store`. Contract (`describeSideEffectConformance`):
 * - `intend` records the effect as `pending` before it runs; an existing key rejects with
 *   `Conflict` (the key is unique, so a repeated step finds its earlier record with `get`).
 * - `resolve` settles an `pending` or `ambiguous` effect (`NotFound` for an unknown key,
 *   `Conflict` for one already `done`, `failed` or `not_done`); it stamps `resolvedAt` unless the
 *   resolution is `ambiguous`.
 * - `list` is ordered by `createdAt`, then key; `list({ states: ['pending'] })` is what the
 *   reconciliation of a restart reads (5.21).
 */
export interface SideEffectRegistry {
  intend(input: NewSideEffect): Promise<SideEffectRecord>;
  get(idempotencyKey: string): Promise<SideEffectRecord | undefined>;
  list(filter?: SideEffectListFilter): Promise<readonly SideEffectRecord[]>;
  resolve(idempotencyKey: string, resolution: SideEffectResolutionInput): Promise<SideEffectRecord>;
}
