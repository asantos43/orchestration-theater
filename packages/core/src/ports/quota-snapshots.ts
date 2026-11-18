// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema } from './store-schemas.js';

/**
 * The `quota_snapshots` table (architecture section 7, 5.6): the last quota reading of each
 * window of each profile, so the quota state survives a restart. [proposta] It keeps the latest
 * reading only (an upsert per profile and window), not a history.
 */

const text = z.string().min(1);

/** One row of `quota_snapshots`, keyed by `profileId` and `window`. */
export const QuotaSnapshotRecordSchema = z.strictObject({
  profileId: text,
  /** Window name as the probe reports it (`5h`, `7d`, `primary`...). */
  window: text,
  usedPercent: z.number().min(0),
  /** When the window resets; null when the signal does not say. */
  resetsAt: EpochMsSchema.nullable(),
  /** Where the reading came from (`probe`, `client_signal`, `estimate`...). */
  source: text,
  /** When the source saw it. */
  observedAt: EpochMsSchema,
  /** When the row was written. */
  updatedAt: EpochMsSchema,
});
export type QuotaSnapshotRecord = z.infer<typeof QuotaSnapshotRecordSchema>;

/** What a caller writes; `observedAt` defaults to the clock of the store. */
export const NewQuotaSnapshotSchema = QuotaSnapshotRecordSchema.omit({
  resetsAt: true,
  observedAt: true,
  updatedAt: true,
}).extend({
  resetsAt: EpochMsSchema.nullable().optional(),
  observedAt: EpochMsSchema.optional(),
});
export type NewQuotaSnapshot = z.infer<typeof NewQuotaSnapshotSchema>;

export interface QuotaSnapshotListFilter {
  readonly profileId?: string;
  /** Only these windows. Omitted means all. */
  readonly windows?: readonly string[];
}

/**
 * Registry of quota snapshots, part of `Store`. Contract (`describeQuotaSnapshotConformance`):
 * - `put` validates (`InvalidInput`) and writes the reading of one window of one profile: it
 *   creates the row, or replaces the one that was there (the latest reading wins). A missing
 *   `resetsAt` is null, a missing `observedAt` is now.
 * - `get(profileId, window)` and `list`; `list` is ordered by profile, then window.
 */
export interface QuotaSnapshotRegistry {
  put(input: NewQuotaSnapshot): Promise<QuotaSnapshotRecord>;
  get(profileId: string, window: string): Promise<QuotaSnapshotRecord | undefined>;
  list(filter?: QuotaSnapshotListFilter): Promise<readonly QuotaSnapshotRecord[]>;
}
