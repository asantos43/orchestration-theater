// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, JsonObjectSchema } from './store-schemas.js';

/**
 * The `setup_runs` table (architecture 5.7, N121): one row per run of the setup assistant, kept
 * so a run survives the TUI closing and a daemon restart. The row holds only the answers the
 * person gave and what each step derived from them; never a credential (the assistant never
 * takes one). [proposta] The columns below.
 */

/** The flows of the assistant (5.7): the first run, adding an account and changing the preset. */
export const SETUP_FLOWS = ['first_run', 'add_account', 'change_preset'] as const;
export type SetupFlow = (typeof SETUP_FLOWS)[number];

/** `active` waits for the next step; `confirmed` wrote the config; `cancelled` wrote nothing. */
export const SETUP_RUN_STATES = ['active', 'confirmed', 'cancelled'] as const;
export type SetupRunState = (typeof SETUP_RUN_STATES)[number];

/** Setup run ids are `SR<n>`, numbered across the whole store from 1. */
export const SETUP_RUN_ID_PATTERN = /^SR[1-9][0-9]*$/;

const text = z.string().min(1);

/** A step that was answered: what the person sent and what the step derived from it. */
export const SetupDoneStepSchema = z.strictObject({
  step: text,
  input: JsonObjectSchema,
  output: JsonObjectSchema,
});
export type SetupDoneStep = z.infer<typeof SetupDoneStepSchema>;

/** One row of `setup_runs`. */
export const SetupRunRecordSchema = z.strictObject({
  /** `SR<n>`, assigned by the store. */
  id: z.string().regex(SETUP_RUN_ID_PATTERN),
  seq: z.int().min(1),
  flow: z.enum(SETUP_FLOWS),
  state: z.enum(SETUP_RUN_STATES),
  /** The step the run waits at (the last name of the flow is its review). */
  step: text,
  /** The steps already answered, in order. */
  done: z.array(SetupDoneStepSchema),
  /** What the confirmation wrote (a summary with no secret); null until `confirmed`. */
  result: JsonObjectSchema.nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** When the run was confirmed or cancelled; null while `active`. */
  finishedAt: EpochMsSchema.nullable(),
});
export type SetupRunRecord = z.infer<typeof SetupRunRecordSchema>;

/** What a caller writes; the store assigns `id`, `seq`, the state (`active`) and the dates. */
export const NewSetupRunSchema = z.strictObject({
  flow: z.enum(SETUP_FLOWS),
  /** The first step of the flow. */
  step: text,
});
export type NewSetupRun = z.infer<typeof NewSetupRunSchema>;

/** Fields `update` may change; `state` ends the run (and `result` goes with `confirmed`). */
export const SetupRunPatchSchema = z.strictObject({
  step: text.optional(),
  done: z.array(SetupDoneStepSchema).optional(),
  state: z.enum(['confirmed', 'cancelled']).optional(),
  result: JsonObjectSchema.optional(),
});
export type SetupRunPatch = z.infer<typeof SetupRunPatchSchema>;

export interface SetupRunListFilter {
  readonly flow?: SetupFlow;
  /** Only runs in one of these states. Omitted means all. */
  readonly states?: readonly SetupRunState[];
}

/**
 * Registry of setup runs, part of `Store`. Contract (`describeSetupRunConformance`):
 * - `create` validates (`InvalidInput`), assigns `SR<n>` and stores the run `active`. There is at
 *   most one `active` run per flow: another one is a `Conflict` (the caller resumes it). A
 *   `confirmed` or `cancelled` one does not count.
 * - `get` and `list`; `list` is ordered by `seq`.
 * - `update(id, patch)`: `NotFound` for an unknown id, `InvalidInput` for a bad patch (`result`
 *   only goes with `state: 'confirmed'`), `Conflict` for any change to a run that is not `active`
 *   any more. A `state` in the patch sets `finishedAt`.
 */
export interface SetupRunRegistry {
  create(input: NewSetupRun): Promise<SetupRunRecord>;
  get(id: string): Promise<SetupRunRecord | undefined>;
  list(filter?: SetupRunListFilter): Promise<readonly SetupRunRecord[]>;
  update(id: string, patch: SetupRunPatch): Promise<SetupRunRecord>;
}
