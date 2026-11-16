// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { InvalidInput } from '../errors.js';

/**
 * Lifecycle of an attempt as the daemon records it (architecture 5.16, state machine
 * `EXECUTING -> INTERRUPTED(cause) -> AWAITING_RESUME -> RESUMING -> EXECUTING`). [proposta] The
 * terminal states are `completed`, `failed` and `timed_out`.
 */
export const ATTEMPT_STATES = [
  'executing',
  'interrupted',
  'awaiting_resume',
  'resuming',
  'completed',
  'failed',
  'timed_out',
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** States in which the attempt still has work to do (what start-up reconciliation looks at). */
export const ACTIVE_ATTEMPT_STATES: readonly AttemptState[] = [
  'executing',
  'interrupted',
  'awaiting_resume',
  'resuming',
];

/**
 * One row of the per-attempt registry (architecture 5.21: "gravar antes de agir"). It is what
 * lets a restarted daemon find the ACP session, the worktree and the last checkpoint of an attempt
 * that was running.
 */
export const AttemptRecordSchema = z.strictObject({
  /** Key. The same id the events of the attempt carry in `attemptId`. */
  attemptId: z.string().min(1),
  playId: z.string().min(1),
  demandId: z.string().min(1),
  /** Attempt number within the demand, from 1. */
  attempt: z.number().int().positive(),
  /** Client adapter id (`claude-code`, `codex`, `opencode`...). */
  client: z.string().min(1),
  profile: z.string().min(1),
  state: z.enum(ATTEMPT_STATES),
  /** Interruption cause while `interrupted`, `awaiting_resume` or `resuming`; else null. */
  cause: z.string().min(1).nullable(),
  /** ACP session id, once the session opened. */
  sessionId: z.string().min(1).nullable(),
  worktree: z.string().min(1),
  branch: z.string().min(1),
  /** Commit of the last checkpoint on the attempt branch, or null before the first. */
  lastCheckpoint: z.string().min(1).nullable(),
  /** Epoch ms of that checkpoint. */
  lastCheckpointAt: z.number().int().nonnegative().nullable(),
  /** Epoch ms of the last `session/update` seen. */
  lastEventAt: z.number().int().nonnegative().nullable(),
  /** Resumes done so far (counted against `resume.max_resumes`). */
  resumes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;

/** What a caller writes: the registry stamps `createdAt` and `updatedAt` itself. */
export type AttemptRecordInput = Omit<AttemptRecord, 'createdAt' | 'updatedAt'>;

export interface AttemptListFilter {
  /** Only attempts in one of these states. Omitted means all. */
  readonly states?: readonly AttemptState[];
}

/**
 * Registry of attempts, part of `Store` (it joins the transaction so the daemon can change an
 * attempt and record the event in one atomic step). Contract (checked by
 * `describeStoreConformance`):
 * - `put` inserts or replaces by `attemptId`; `createdAt` is kept on replacement, `updatedAt` is
 *   the current time. An invalid record rejects with `InvalidInput`.
 * - `get` resolves `undefined` for an unknown id; `list` is ordered by `createdAt` then `attemptId`.
 * - Inside a transaction, reads see the transaction's own writes; a rollback drops them.
 */
export interface AttemptRegistry {
  get(attemptId: string): Promise<AttemptRecord | undefined>;
  put(record: AttemptRecordInput): Promise<AttemptRecord>;
  list(filter?: AttemptListFilter): Promise<readonly AttemptRecord[]>;
}

/** Validates a record on its way in. Shared by every adapter so they reject the same things. */
export function parseAttemptInput(input: AttemptRecordInput): AttemptRecordInput {
  const parsed = AttemptRecordSchema.omit({ createdAt: true, updatedAt: true }).safeParse(input);
  if (!parsed.success) {
    throw new InvalidInput(`Invalid attempt record: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Comparison for `list`: `createdAt`, then `attemptId`. */
export function compareAttempts(a: AttemptRecord, b: AttemptRecord): number {
  return (
    a.createdAt - b.createdAt ||
    (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0)
  );
}
