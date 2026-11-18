// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema } from './store-schemas.js';

/**
 * The `wakeups` table (architecture section 7, 5.6): the moments the daemon must wake up to
 * check a profile again (quota back, budget window open), kept so they survive a restart.
 * [proposta] The columns below.
 */

/** Why the daemon wakes: the quota of a profile may be back, or its budget window opened. */
export const WAKEUP_CAUSES = ['quota', 'budget'] as const;
export type WakeupCause = (typeof WAKEUP_CAUSES)[number];

/** `scheduled` waits for its moment; `fired` ran; `cancelled` is no longer needed. */
export const WAKEUP_STATES = ['scheduled', 'fired', 'cancelled'] as const;
export type WakeupState = (typeof WAKEUP_STATES)[number];

/** Wakeup ids are `W<n>`, numbered across the whole store from 1. */
export const WAKEUP_ID_PATTERN = /^W[1-9][0-9]*$/;

const text = z.string().min(1);

/** One row of `wakeups`. */
export const WakeupRecordSchema = z.strictObject({
  /** `W<n>`, assigned by the store. */
  id: z.string().regex(WAKEUP_ID_PATTERN),
  seq: z.int().min(1),
  profileId: text,
  cause: z.enum(WAKEUP_CAUSES),
  /** When to wake up, epoch ms. */
  at: EpochMsSchema,
  state: z.enum(WAKEUP_STATES),
  /** Id of the trigger registered with the OS (a systemd timer, a launchd job...); null until there is one. */
  osTriggerId: text.nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type WakeupRecord = z.infer<typeof WakeupRecordSchema>;

/** What a caller writes; the store assigns `id`, `seq`, the state (`scheduled`) and the dates. */
export const NewWakeupSchema = WakeupRecordSchema.pick({
  profileId: true,
  cause: true,
  at: true,
  osTriggerId: true,
}).partial({ osTriggerId: true });
export type NewWakeup = z.infer<typeof NewWakeupSchema>;

/** Fields `update` may change. `at` and `osTriggerId` only while the wakeup is `scheduled`. */
export const WakeupPatchSchema = z.strictObject({
  at: EpochMsSchema.optional(),
  osTriggerId: text.nullable().optional(),
  state: z.enum(['fired', 'cancelled']).optional(),
});
export type WakeupPatch = z.infer<typeof WakeupPatchSchema>;

export interface WakeupListFilter {
  readonly profileId?: string;
  readonly cause?: WakeupCause;
  /** Only wakeups in one of these states. Omitted means all. */
  readonly states?: readonly WakeupState[];
  /** Wakeups whose moment is at or before this one (epoch ms): the ones that are due. */
  readonly dueBy?: number;
}

/**
 * Registry of wakeups, part of `Store`. Contract (`describeWakeupConformance`):
 * - `create` validates (`InvalidInput`), assigns `W<n>` and stores the wakeup `scheduled`. There
 *   is at most one `scheduled` wakeup per profile and cause: another one is a `Conflict` (the
 *   caller moves the existing one with `update`). A `fired` or `cancelled` one does not count.
 * - `get` and `list`; `list` is ordered by `at`, then `seq`.
 * - `update(id, patch)`: `NotFound` for an unknown id, `InvalidInput` for a bad patch,
 *   `Conflict` for any change to a wakeup that is not `scheduled` any more.
 */
export interface WakeupRegistry {
  create(input: NewWakeup): Promise<WakeupRecord>;
  get(id: string): Promise<WakeupRecord | undefined>;
  list(filter?: WakeupListFilter): Promise<readonly WakeupRecord[]>;
  update(id: string, patch: WakeupPatch): Promise<WakeupRecord>;
}
