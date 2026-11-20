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
 * restart of the daemon or machine, timeout, stuck agent, model refusal, permission error and, last,
 * the removal of the profile of the session (P21b, N152).
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
  'profile_removed',
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
  /**
   * How the policy of 5.16 continues it, when it does (Phase 5, P18, [proposta]): `native` or
   * `handoff`. Absent when nothing continues the session (the attempt is parked).
   */
  form: ResumeFormSchema.optional(),
  /** Executor of the interrupted session, with `form`. */
  from: ExecutorPayloadSchema.optional(),
  /** Executor that takes over, with `form`: the same as `from` on a native resume. */
  to: ExecutorPayloadSchema.optional(),
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

/** Short error text an event may carry: already masked by the daemon, never a stack. */
const errorText = z.string().max(512);

/**
 * How the summary of the trajectory in a continuation package was made (Phase 5, P18b, N146).
 * `deterministic`: only the summary of the events (the setting, or no model asked for);
 * `model`: the cheap model of N126 wrote one next to it; `model_failed`: it was asked for and
 * failed or answered nothing, so the package went on with the deterministic summary alone;
 * `model_unavailable`: it was asked for and no port was wired to answer.
 */
export const PACKAGE_SUMMARIES = [
  'deterministic',
  'model',
  'model_failed',
  'model_unavailable',
] as const;
export const PackageSummarySchema = z.enum(PACKAGE_SUMMARIES);
export type PackageSummary = z.infer<typeof PackageSummarySchema>;

/**
 * `session.handoff`: the baton passed (architecture 5.16; Phase 5, P18b, N146 and N147). Written
 * when the runner has chosen the next Executor and built the continuation package, after
 * `session.interrupted` and before the new session opens (`session.opened`, `session.resumed`).
 * It is the hook for plugins: they do not need to read the chat message. [proposta] The name and
 * the fields. `sessionId` is not here because the new session does not exist yet; the interrupted
 * one is `previousSessionId`. The package facts are the ones of `AttemptOutcome.handoffs`.
 */
export const SessionHandoffPayloadSchema = z.strictObject({
  /** The session the baton came from; absent when the previous Executor never opened one. */
  previousSessionId: id.optional(),
  role: id.optional(),
  cause: InterruptionCauseSchema,
  /** Executor that gives the baton. */
  from: ExecutorPayloadSchema,
  /** Executor that takes it. */
  to: ExecutorPayloadSchema,
  /** The policy counted the interruption as an attempt of the demand; the handoff itself spends none. */
  countedAsAttempt: z.boolean(),
  /** Size of the package, the first prompt of the new session, in characters. */
  packageChars: z.int().min(0),
  /** How much of the package was cut to fit `resume.package.max_chars` (0: nothing; the last: a hard cut). */
  packageLevel: z.int().min(0),
  /** The package lost its middle (`packageLevel` at its last value). */
  packageCut: z.boolean(),
  summary: PackageSummarySchema,
  /** Why the cheap model did not contribute, when `summary` is `model_failed`; masked. */
  summaryError: errorText.optional(),
  ...correlation,
});

/**
 * `session.handoff_failed`: the policy chose a handoff and nobody took it, so the attempt stays
 * parked (`interrupted`; architecture 5.16, P18b, N146 and N147). `reason` is the one of
 * `AttemptOutcome.handoffWait`: `no_port`, `no_role`, `no_other_executor`, `waiting`,
 * `selection_failed`, `package_failed` (a custom port may say another). `on` and `until` are the
 * wait of the selector: the Executors whose availability may come back (empty when none will) and
 * the earliest known end of the wait (null when no source says). [proposta] The name and the fields.
 */
export const SessionHandoffFailedPayloadSchema = z.strictObject({
  /** The session that was interrupted; absent when the error came before any session. */
  sessionId: id.optional(),
  role: id.optional(),
  cause: InterruptionCauseSchema,
  /** Executor that wanted to give the baton. */
  from: ExecutorPayloadSchema,
  reason: z.string().min(1).max(64),
  on: z.array(z.string().min(1).max(256)),
  until: z.int().min(0).nullable(),
  /** What failed, for `selection_failed` and `package_failed`; masked (`scrubPackageText`) and cut. */
  error: errorText.optional(),
  ...correlation,
});

/** Why an attempt waits for a quota or a spending cap to come back (P19; the two causes of the wait). */
export const RESET_WAIT_CAUSES = ['quota_exhausted', 'spend_cap'] as const;
export const ResetWaitCauseSchema = z.enum(RESET_WAIT_CAUSES);
export type ResetWaitCause = z.infer<typeof ResetWaitCauseSchema>;

/**
 * `attempt.reset_wait_started`: the attempt went to `AWAITING_RESUME` to wait for the quota or the
 * spending cap of its own profile (architecture 5.16, "Retomada quando a cota ou o teto voltam";
 * Phase 5, P19, N146). Written with the record of the state, after `session.interrupted`. The wait
 * ends with `attempt.reset_wait_ended`. [proposta] The name and the fields.
 */
export const AttemptResetWaitStartedPayloadSchema = z.strictObject({
  /** The session that stopped and that a native resume loads again; absent when none opened. */
  sessionId: id.optional(),
  role: id.optional(),
  cause: ResetWaitCauseSchema,
  /** The Executor the attempt waits for: the resume is natural in the same profile. */
  executor: ExecutorPayloadSchema,
  /** When the quota or the cap is due back, epoch ms; null when no source says (a cap with no date). */
  resetsAt: z.int().min(0).nullable(),
  /** How long the wait may take at most, ms: the time to the reset plus `resume.quota_wait_grace`. */
  maxWaitMs: z.int().min(0),
  /** The wait comes from a daemon that restarted while the attempt was waiting. */
  afterRestart: z.boolean(),
  ...correlation,
});

/** How a wait for the reset ended (P19, [proposta]). */
export const RESET_WAIT_OUTCOMES = [
  /** `quota.restored` or `budget.restored` arrived: the session is loaded again, natively. */
  'restored',
  /** The time limit of the demand ran out during the wait (`resume.quota_wait_deadline: count`). */
  'timeout',
  /** The attempt was stopped or cancelled during the wait; the record stays waiting. */
  'stopped',
  /** No word came by the reset plus `resume.quota_wait_grace` and the profile is still exhausted: the baton goes (or the attempt parks). */
  'missed',
  /** The profile of the attempt is being removed (P21): the wait ends and the leave takes over. */
  'left',
] as const;
export const ResetWaitOutcomeSchema = z.enum(RESET_WAIT_OUTCOMES);
export type ResetWaitOutcome = z.infer<typeof ResetWaitOutcomeSchema>;

/**
 * `attempt.reset_wait_ended`: the wait of `attempt.reset_wait_started` is over (P19, N146).
 * `restored` is followed by `session.resumed` with `form: native`; the other outcomes by a handoff
 * (`session.handoff`), a park (`session.handoff_failed`) or nothing, for `stopped`. [proposta]
 */
export const AttemptResetWaitEndedPayloadSchema = z.strictObject({
  sessionId: id.optional(),
  cause: ResetWaitCauseSchema,
  outcome: ResetWaitOutcomeSchema,
  /** How long the attempt waited, ms (on the clock of the daemon). */
  waitedMs: z.int().min(0),
  ...correlation,
});

/**
 * `attempt.checkpoint_failed`: a `wip(checkpoint)` commit could not be made (P18b, N146), so the
 * work since the last checkpoint is not protected. [proposta]
 */
export const AttemptCheckpointFailedPayloadSchema = z.strictObject({
  reason: CheckpointReasonSchema,
  branch: z.string().min(1),
  error: errorText,
  ...correlation,
});

/**
 * `attempt.aborted`: an error nobody planned for (the store, say) ended the attempt as `failed`
 * and the process tree was killed (P18b, N146). [proposta]
 */
export const AttemptAbortedPayloadSchema = z.strictObject({
  sessionId: id.optional(),
  error: errorText,
  ...correlation,
});

/**
 * `session.processes_left`: the process tree of a session was killed and some processes are still
 * alive (P18b, N146). `pids` are the ones that remain. [proposta]
 */
export const SessionProcessesLeftPayloadSchema = z.strictObject({
  sessionId: id.optional(),
  pids: z.array(z.int().min(0)).min(1),
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

/**
 * `session.turn_timeout`: one turn of a session outlived `limits.turn_timeout` (N184). [proposta]
 * `action` is `limits.on_turn_timeout` at that moment: `cancel` (the session is cancelled and the
 * turn counts as failed) or `notice` (nothing is cancelled, the event is the only trace).
 */
export const SessionTurnTimeoutPayloadSchema = z.strictObject({
  sessionId: id,
  /** `limits.turn_timeout`, in milliseconds. */
  limitMs: z.int().min(1),
  /** How long the turn had run when the limit was met, in milliseconds. */
  elapsedMs: z.int().min(0),
  action: z.enum(['cancel', 'notice']),
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

/**
 * `attempt.submitted`: the agent delivered a valid `submit*` through the framework MCP server
 * (architecture 5.3). The output is the validated payload of the tool. [proposta] `submission` is
 * how many calls the tool took (1 = valid at the first try); `tool` is the name of the `submit*`
 * tool and `role` the role whose token made the call.
 */
export const AttemptSubmittedPayloadSchema = z.strictObject({
  tool: id,
  role: id,
  output: z.json(),
  calls: z.int().min(1),
  ...correlation,
});

/**
 * `attempt.submit_failed`: the agent sent an invalid `submit*` once more than `limits.submit_retries`
 * allows (the N+1-th invalid call counts as failure, N79). [proposta] `errors` is the text of the
 * last validation error, `calls` the number of invalid calls.
 */
export const AttemptSubmitFailedPayloadSchema = z.strictObject({
  tool: id,
  role: id,
  errors: z.string().min(1).max(4000),
  calls: z.int().min(1),
  ...correlation,
});
