// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema } from './store-schemas.js';

/**
 * The `executors` table (architecture section 7, 5.7): the Executors the roles can name, each one
 * a model and an effort on a profile. [proposta] The columns below.
 */

/** `invalid` while the profile is missing or removed, or the model is not accepted any more. */
export const EXECUTOR_VALIDITIES = ['valid', 'invalid'] as const;
export type ExecutorValidity = (typeof EXECUTOR_VALIDITIES)[number];

const text = z.string().min(1);

/** What may stand in an Executor id around the `-` and the `@`: no whitespace and no `@`. */
const idPart = z.string().regex(/^[^\s@]+$/);

/** `<model>-<effort>@<client>/<profile>`, or `<model>@<client>/<profile>` without effort (5.7). */
export function formatExecutorId(parts: {
  readonly model: string;
  readonly effort: string | null;
  readonly profileId: string;
}): string {
  const head = parts.effort === null ? parts.model : `${parts.model}-${parts.effort}`;
  return `${head}@${parts.profileId}`;
}

/** One row of `executors`. */
export const ExecutorRecordSchema = z.strictObject({
  /** See {@link formatExecutorId}; assigned by the store. */
  id: text,
  /** The profile (`<client>/<name>`), kept even after the profile is removed. */
  profileId: text,
  model: idPart,
  /** Null for a model with no effort control. */
  effort: idPart.nullable(),
  /** Provider of the model (`anthropic`, `openai`, `minimax`...), not of the account. */
  provider: text,
  validity: z.enum(EXECUTOR_VALIDITIES),
  /** Why it is `invalid` (`profile_removed`, `model_unknown`...); null while `valid`. */
  invalidReason: text.nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type ExecutorRecord = z.infer<typeof ExecutorRecordSchema>;

/** What a caller writes; the store assigns `id`, `valid` and the dates. */
export const NewExecutorSchema = ExecutorRecordSchema.pick({
  profileId: true,
  model: true,
  effort: true,
  provider: true,
});
export type NewExecutor = z.infer<typeof NewExecutorSchema>;

/** Fields `update` may change. */
export const ExecutorPatchSchema = z.strictObject({
  provider: text.optional(),
  validity: z.enum(EXECUTOR_VALIDITIES).optional(),
  invalidReason: text.nullable().optional(),
});
export type ExecutorPatch = z.infer<typeof ExecutorPatchSchema>;

export interface ExecutorListFilter {
  readonly profileId?: string;
  readonly provider?: string;
  readonly validity?: ExecutorValidity;
}

/**
 * Registry of Executors, part of `Store`. Contract (`describeExecutorConformance`):
 * - `create` validates (`InvalidInput`), assigns the id of {@link formatExecutorId} and stores the
 *   Executor `valid`; `Conflict` when the id exists. It does not check that the profile exists:
 *   an Executor of a missing profile is only `invalid` (5.7), never rejected on read.
 * - `get` and `list`; `list` is ordered by id.
 * - `update(id, patch)`: `NotFound` for an unknown id, `InvalidInput` for a bad patch.
 *   `validity: 'invalid'` takes the reason of the patch (or keeps the current one); `valid`
 *   clears the reason.
 */
export interface ExecutorRegistry {
  create(input: NewExecutor): Promise<ExecutorRecord>;
  get(id: string): Promise<ExecutorRecord | undefined>;
  list(filter?: ExecutorListFilter): Promise<readonly ExecutorRecord[]>;
  update(id: string, patch: ExecutorPatch): Promise<ExecutorRecord>;
}
