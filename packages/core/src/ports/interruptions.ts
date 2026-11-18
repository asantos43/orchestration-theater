// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, RecordIdSchema } from './store-schemas.js';

/**
 * The `interruptions` table (architecture section 7, 5.16): one row per time a session stopped
 * before its end. [proposta] The columns below.
 */

/**
 * Classified causes of an interruption (5.16). The wire vocabulary is `INTERRUPTION_CAUSES` of
 * `@otheater/protocol`; core cannot import it (protocol depends on core), so a test in protocol
 * checks that the two lists are equal.
 */
export const INTERRUPTION_CAUSE_NAMES = [
  'quota_exhausted',
  'spend_cap',
  'transient',
  'client_crash',
  'daemon_restart',
  'timeout',
  'stuck',
  'refusal',
  'permission',
] as const;
export type InterruptionCauseName = (typeof INTERRUPTION_CAUSE_NAMES)[number];

/** The two ways to resume (5.16); same note as {@link INTERRUPTION_CAUSE_NAMES} (`RESUME_FORMS`). */
export const RESUME_FORM_NAMES = ['native', 'handoff'] as const;
export type ResumeFormName = (typeof RESUME_FORM_NAMES)[number];

/** Interruption ids are `X<n>`, numbered across the whole store from 1. */
export const INTERRUPTION_ID_PATTERN = /^X[1-9][0-9]*$/;

const text = z.string().min(1);

/** One row of `interruptions`. */
export const InterruptionRecordSchema = z.strictObject({
  /** `X<n>`, assigned by the store. */
  id: z.string().regex(INTERRUPTION_ID_PATTERN),
  /** The `n` of the id: the arrival order. */
  seq: z.int().min(1),
  sessionId: RecordIdSchema,
  playId: RecordIdSchema.nullable(),
  cause: z.enum(INTERRUPTION_CAUSE_NAMES),
  /** What the classifier saw (names of signals, short texts); never a credential or a prompt. */
  signals: z.array(text),
  /** How the session was (or will be) resumed; null while undecided. */
  resumeForm: z.enum(RESUME_FORM_NAMES).nullable(),
  /** Executor id that was running when it stopped. */
  fromExecutor: text.nullable(),
  /** Executor id that took over; null while undecided or when the same one resumed. */
  toExecutor: text.nullable(),
  /** Whether the interruption counted as an attempt of the stage (5.16). */
  countedAsAttempt: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type InterruptionRecord = z.infer<typeof InterruptionRecordSchema>;

/** What a caller writes; the store assigns `id`, `seq` and the dates. */
export const NewInterruptionSchema = InterruptionRecordSchema.pick({
  sessionId: true,
  playId: true,
  cause: true,
  signals: true,
  resumeForm: true,
  fromExecutor: true,
  toExecutor: true,
  countedAsAttempt: true,
}).partial({
  playId: true,
  signals: true,
  resumeForm: true,
  fromExecutor: true,
  toExecutor: true,
  countedAsAttempt: true,
});
export type NewInterruption = z.infer<typeof NewInterruptionSchema>;

/** Fields `update` may change: what is decided after the interruption was recorded. */
export const InterruptionPatchSchema = z.strictObject({
  resumeForm: z.enum(RESUME_FORM_NAMES).nullable().optional(),
  toExecutor: text.nullable().optional(),
  countedAsAttempt: z.boolean().optional(),
  signals: z.array(text).optional(),
});
export type InterruptionPatch = z.infer<typeof InterruptionPatchSchema>;

export interface InterruptionListFilter {
  readonly sessionId?: string;
  readonly playId?: string;
  /** Only interruptions with one of these causes. Omitted means all. */
  readonly causes?: readonly InterruptionCauseName[];
}

/**
 * Registry of interruptions, part of `Store`. Contract (`describeInterruptionConformance`):
 * - `create` validates (`InvalidInput`), assigns `X<n>` (1, 2, 3... across the store); a missing
 *   `signals` is empty, `countedAsAttempt` is false, the other optional fields are null.
 * - `get` and `list`; `list` is ordered by `seq`.
 * - `update(id, patch)`: `NotFound` for an unknown id, `InvalidInput` for a bad patch; fields
 *   left out keep their value, `null` clears `resumeForm` and `toExecutor`.
 */
export interface InterruptionRegistry {
  create(input: NewInterruption): Promise<InterruptionRecord>;
  get(id: string): Promise<InterruptionRecord | undefined>;
  list(filter?: InterruptionListFilter): Promise<readonly InterruptionRecord[]>;
  update(id: string, patch: InterruptionPatch): Promise<InterruptionRecord>;
}
