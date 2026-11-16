// SPDX-License-Identifier: MPL-2.0
import { NormalizedUpdateSchema, StopReasonSchema } from '@otheater/core';
import { z } from 'zod';

/**
 * Payloads of the session and checkpoint events (architecture 5.11 and 5.16). They are registered
 * in `DAEMON_EVENT_TYPES` (events.ts) at `schemaVersion` 1. Every payload is a strict object.
 *
 * Correlation (N54): every payload may carry `playId`, `demandId` and `attemptId`, so a consumer
 * that only has the payload (the telemetry base, an exporter) can tie it to a play without joining
 * the envelope. They repeat the envelope fields `playId` and `attemptId` of the `EventLog`.
 * [proposta] All three are optional: a session of the direct chat (5.20) belongs to no play.
 */

const id = z.string().min(1).max(256);

const correlation = {
  playId: id.optional(),
  demandId: id.optional(),
  attemptId: id.optional(),
};

/**
 * An Executor as events carry it: client, profile, model, effort and mode, never a secret
 * (architecture 5.2, 5.7). [proposta] Flat fields rather than the `<client>/<profile>` id, so a
 * consumer filters without parsing.
 */
export const ExecutorPayloadSchema = z.strictObject({
  client: id,
  profile: id,
  model: id,
  effort: id.optional(),
  mode: id.optional(),
});
export type ExecutorPayload = z.infer<typeof ExecutorPayloadSchema>;

/**
 * Why a session stopped before its work was done (architecture 5.16, "Política por causa"). One
 * per row of the table, in the same order: quota, spending cap, transient error, client crash,
 * restart of the daemon or machine, timeout, stuck agent, model refusal, permission error.
 */
export const INTERRUPTION_CAUSES = [
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
export const InterruptionCauseSchema = z.enum(INTERRUPTION_CAUSES);
export type InterruptionCause = z.infer<typeof InterruptionCauseSchema>;

/** The two ways to resume (architecture 5.16, "Duas formas de retomar"). */
export const RESUME_FORMS = ['native', 'handoff'] as const;
export const ResumeFormSchema = z.enum(RESUME_FORMS);
export type ResumeForm = z.infer<typeof ResumeFormSchema>;

/** Why a checkpoint commit was made (architecture 5.16, "Checkpoints"). */
export const CHECKPOINT_REASONS = ['edit_batch', 'interval', 'interruption'] as const;
export const CheckpointReasonSchema = z.enum(CHECKPOINT_REASONS);
export type CheckpointReason = z.infer<typeof CheckpointReasonSchema>;

/** How a session ended normally or by decision. [proposta] */
export const SESSION_CLOSE_REASONS = ['completed', 'cancelled', 'failed', 'interrupted'] as const;
export const SessionCloseReasonSchema = z.enum(SESSION_CLOSE_REASONS);
export type SessionCloseReason = z.infer<typeof SessionCloseReasonSchema>;

/** `session.opened`: a conversation with an Executor started (or was reloaded, see `resumed`). */
export const SessionOpenedPayloadSchema = z.strictObject({
  sessionId: id,
  executor: ExecutorPayloadSchema,
  /** Transport id: `acp`, `headless`... */
  via: id,
  /** Absolute path of the worktree the session works in. */
  cwd: z.string().min(1).optional(),
  /** The session can be reloaded later (`session/load`). */
  canLoad: z.boolean(),
  ...correlation,
});

/** `session.update`: one normalized update, as the shell produced it (architecture 5.11). */
export const SessionUpdatePayloadSchema = z.strictObject({
  sessionId: id,
  update: NormalizedUpdateSchema,
  ...correlation,
});

/** `session.prompt_finished`: a prompt turn ended. */
export const SessionPromptFinishedPayloadSchema = z.strictObject({
  sessionId: id,
  stopReason: StopReasonSchema,
  durationMs: z.int().min(0).optional(),
  ...correlation,
});

/** `session.interrupted`: the session stopped before its work was done (architecture 5.16). */
export const SessionInterruptedPayloadSchema = z.strictObject({
  sessionId: id,
  cause: InterruptionCauseSchema,
  /** Free text for the chat message; never decide on it. */
  detail: z.string().optional(),
  /** When the quota or the cap comes back, epoch ms, if known. */
  resetsAt: z.int().min(0).optional(),
  /** Last checkpoint commit of the attempt, if any. */
  checkpointSha: z.string().min(1).optional(),
  ...correlation,
});

/** `session.resumed`: work continues after an interruption, natively or by handoff. */
export const SessionResumedPayloadSchema = z.strictObject({
  sessionId: id,
  /** The session that was interrupted. */
  previousSessionId: id.optional(),
  form: ResumeFormSchema,
  /** Executor of the interrupted session. */
  from: ExecutorPayloadSchema,
  /** Executor that continues; the same as `from` on a native resume. */
  to: ExecutorPayloadSchema,
  cause: InterruptionCauseSchema.optional(),
  ...correlation,
});

/**
 * `session.cancel_escalated`: cancelling a session ended the shared adapter process it ran on
 * (`pool.shared_cancel`, `escalate` or `always_kill`). The other sessions of that process lost
 * their connection and come back through the resume path (`session.interrupted`, `client_crash`).
 * [proposta] A new type instead of a new interruption cause, so the cause table of 5.16 stays as is.
 */
export const SessionCancelEscalatedPayloadSchema = z.strictObject({
  /** The session whose cancel ended the process. */
  sessionId: id,
  /** The mode that decided it; `release` never ends a process. */
  mode: z.enum(['escalate', 'always_kill']),
  /** Pid of the adapter process that was ended. */
  pid: z.int().min(0),
  /** Other sessions that were on the process and fell with it. */
  siblings: z.int().min(0),
  ...correlation,
});

/** `session.closed`: the session ended and its process was released. */
export const SessionClosedPayloadSchema = z.strictObject({
  sessionId: id,
  reason: SessionCloseReasonSchema,
  ...correlation,
});

/** `attempt.checkpoint`: a `wip(checkpoint)` commit on the branch of the attempt (5.16). */
export const AttemptCheckpointPayloadSchema = z.strictObject({
  sha: z.string().min(1),
  label: z.string().min(1).max(200),
  reason: CheckpointReasonSchema,
  branch: z.string().min(1).optional(),
  ...correlation,
});
