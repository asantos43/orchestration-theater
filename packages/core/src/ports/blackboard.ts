// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { JsonValueSchema } from './event-log.js';
import { EpochMsSchema, RecordIdSchema } from './store-schemas.js';

/**
 * One version of one blackboard key (architecture section 7: key, version, content). [proposta]
 * The blackboard of a play holds its plan, script, contracts and decisions, read on demand
 * (`read_blackboard`), and it is scoped by `playId`. A version is never overwritten or removed:
 * a new `put` of the same key is the next version.
 */
export const BlackboardEntrySchema = z.strictObject({
  playId: RecordIdSchema,
  key: z.string().min(1).max(256),
  /** 1 for the first `put` of the key, then 2, 3... */
  version: z.int().min(1),
  /** Any JSON value, including `null`. */
  value: JsonValueSchema,
  /** Who wrote it (a role, `producer`, `daemon`...), when known. */
  author: z.string().min(1).nullable(),
  createdAt: EpochMsSchema,
});
export type BlackboardEntry = z.infer<typeof BlackboardEntrySchema>;

export const NewBlackboardEntrySchema = BlackboardEntrySchema.omit({
  version: true,
  createdAt: true,
}).partial({ author: true });
export type NewBlackboardEntry = z.infer<typeof NewBlackboardEntrySchema>;

/**
 * The blackboard, part of `Store`. Contract (`describeBlackboardConformance`):
 * - `put` appends the next version of `(playId, key)` (1, 2, 3...; versions of other keys and
 *   plays are independent) and resolves with the entry; nothing is ever overwritten.
 * - `get` resolves the latest version, or the one asked for, and `undefined` when there is none.
 * - `history` lists every version of a key, oldest first.
 * - `latest` lists the newest version of every key of a play, ordered by key.
 * - Inside a transaction reads see its own writes; a rollback drops them.
 */
export interface Blackboard {
  put(input: NewBlackboardEntry): Promise<BlackboardEntry>;
  get(playId: string, key: string, version?: number): Promise<BlackboardEntry | undefined>;
  history(playId: string, key: string): Promise<readonly BlackboardEntry[]>;
  latest(playId: string): Promise<readonly BlackboardEntry[]>;
}
