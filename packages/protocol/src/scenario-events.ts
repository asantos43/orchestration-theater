// SPDX-License-Identifier: MPL-2.0
import { ATTACHMENT_SOURCES } from '@otheater/core';
import { z } from 'zod';
import { InterruptionCauseSchema } from './session-events.js';

/**
 * Payloads of the `scenario.*` events (architecture 5.20, "Eventos"). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. Every payload is a strict object;
 * the scenario also travels in the envelope (`scenarioId`).
 * [proposta] The fields below, in camelCase like the other payloads of the daemon. The import and
 * the promotion of a scenario (also listed by 5.20) belong to later steps and have no event yet.
 */

const scenarioId = z.string().min(1);

/** The states of the `chat` flow (architecture 5.20): the long-lived play of the generic chat. */
export const CHAT_FLOW_STATES = ['IDLE', 'CONSULTING', 'AWAITING_PRODUCER'] as const;
export type ChatFlowState = (typeof CHAT_FLOW_STATES)[number];

/** `scenario.created`: a scenario of a registered type was opened (`ot chat`, `ot new`...). */
export const ScenarioCreatedPayloadSchema = z.strictObject({
  scenarioId,
  type: z.string().min(1),
  flow: z.string().min(1),
  name: z.string().min(1),
  folder: z.string().min(1),
});

/** `scenario.attachment_added`: a file, a pasted text or a path became attachment `A<n>`. */
export const ScenarioAttachmentAddedPayloadSchema = z.strictObject({
  scenarioId,
  /** `A<n>`. */
  attachmentId: z.string().regex(/^A[1-9][0-9]*$/),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.int().min(0),
  hash: z.string().min(1),
  source: z.enum(ATTACHMENT_SOURCES),
});

/** `scenario.director_slept`: the Director idled for `idleMs` and its session was closed. */
export const ScenarioDirectorSleptPayloadSchema = z.strictObject({
  scenarioId,
  /** The `scenarios.director_idle_after` the Director slept under. */
  idleMs: z.int().min(1),
});

/** `scenario.director_woke`: a session opened again; the state summary went in its first prompt. */
export const ScenarioDirectorWokePayloadSchema = z.strictObject({
  scenarioId,
  /** Epoch ms the Director fell asleep at, `null` when it was never recorded. */
  sleptAt: z.int().min(0).nullable(),
});

/**
 * `scenario.chat_transitioned`: the `chat` flow of a scenario moved (IDLE, CONSULTING,
 * AWAITING_PRODUCER). A consultation records which Executor was chosen and why.
 */
export const ScenarioChatTransitionedPayloadSchema = z.strictObject({
  scenarioId,
  from: z.enum(CHAT_FLOW_STATES),
  to: z.enum(CHAT_FLOW_STATES),
  /** The decision of the consultation, when the move is one. */
  decisionId: z.string().min(1).nullable(),
  /** Why the move happened: `consult`, `consult_answered`, `consult_failed`, `ask_producer`... */
  cause: z.string().min(1),
  /** The Executor the consultation uses (`client/profile`), for `consult`. */
  executor: z.string().min(1).nullable(),
  /** Why that Executor (the Director's reason, a forced choice, the only one with image...). */
  reason: z.string().nullable(),
});

/**
 * `scenario.system_message`: a message of the daemon for the chat of a scenario (architecture
 * 5.21, step 8). [proposta] Three kinds: `recovery`, what the reconciliation of a start-up did in this
 * scenario, `handoff` (Phase 5, P18), an attempt that passed the baton to another Executor, and
 * `selection_wait` (P16b, N135), a role that waits for an Executor the strict cross-review keeps out.
 * The payload is data, not text: each interface writes the words in the language of the Producer
 * (5.22), so the log stays in English.
 */
export const ScenarioRecoveryNoticeSchema = z.strictObject({
  scenarioId,
  kind: z.literal('recovery'),
  /** What the start-up took up again: plays (machine restored) and attempts (conversation reloaded). */
  resumed: z.array(z.strictObject({ kind: z.enum(['play', 'attempt']), id: z.string().min(1) })),
  /** Effects with an intent and no end that the verifier checked from outside. */
  settled: z.array(
    z.strictObject({
      effectType: z.string().min(1),
      playId: z.string().min(1),
      outcome: z.enum(['done', 'not_done']),
    }),
  ),
  /** What waits for the Producer: an effect nobody could check, a play that could not be restored. */
  waiting: z.array(
    z.strictObject({
      kind: z.enum(['effect', 'play']),
      /** The idempotency key of the effect, or the id of the play. */
      id: z.string().min(1),
      playId: z.string().min(1).nullable(),
      effectType: z.string().min(1).nullable(),
    }),
  ),
});

/**
 * The `handoff` kind: the session of `fromExecutor` stopped for `cause` and the attempt goes on
 * with `toExecutor`, in a new session that opens with the continuation package (5.16). Ids and
 * the cause only: no text of the package, no path, no credential.
 */
export const ScenarioHandoffNoticeSchema = z.strictObject({
  scenarioId,
  kind: z.literal('handoff'),
  playId: z.string().min(1),
  attemptId: z.string().min(1),
  role: z.string().min(1).nullable(),
  /** The interruption cause (`quota_exhausted`, `client_crash`...). */
  cause: z.string().min(1),
  /** Executor id (`<model>[-<effort>]@<client>/<profile>`) that passed the baton. */
  fromExecutor: z.string().min(1),
  /** Executor id that took it. */
  toExecutor: z.string().min(1),
});

/**
 * The `selection_wait` kind (P16b, N135 and N143; [proposta]): a role waits for an Executor the
 * strict cross-review keeps out (`selection.cross_check: require_other_provider | other_model`
 * with `selection.strict_unavailable: wait_notify`). Ids and reasons only; `workedProvider` is the
 * provider of the work under review that the role must not share.
 */
export const ScenarioSelectionWaitNoticeSchema = z.strictObject({
  scenarioId,
  kind: z.literal('selection_wait'),
  role: z.string().min(1).max(64),
  playId: z.string().min(1).nullable(),
  demandId: z.string().min(1).nullable(),
  /** `require_other_provider` or `other_model`. */
  crossCheck: z.string().min(1),
  workedProvider: z.string().min(1).nullable(),
  /** The Executors set aside and why. */
  on: z.array(
    z.strictObject({
      executor: z.string().min(1),
      profile: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  /** The earliest known end of the wait; null when no source says. */
  until: z.int().min(0).nullable(),
});

/**
 * The `reset_wait` kind (Phase 5, P19, [proposta]): the attempt of a role waits for the quota or the
 * spending cap of its own profile to come back, and resumes natively when it does (5.16). Ids,
 * the cause and the dates only.
 */
export const ScenarioResetWaitNoticeSchema = z.strictObject({
  scenarioId,
  kind: z.literal('reset_wait'),
  playId: z.string().min(1),
  attemptId: z.string().min(1),
  role: z.string().min(1).nullable(),
  /** `quota_exhausted` or `spend_cap`. */
  cause: z.string().min(1),
  /** Executor id of the profile that waits. */
  executor: z.string().min(1),
  /** When the profile is due back, epoch ms; null when no source says. */
  resetsAt: z.int().min(0).nullable(),
});

/** How a failover of the Director ended, for the Producer (`director_failover` kind). */
export const DIRECTOR_FAILOVER_OUTCOMES = ['switched', 'waiting', 'unavailable'] as const;
export type DirectorFailoverOutcome = (typeof DIRECTOR_FAILOVER_OUTCOMES)[number];

/**
 * The `director_failover` kind (Phase 5, P20; [proposta] the name and the fields): the session of
 * the Director failed for `cause` (the P17 cause: `quota_exhausted`, `spend_cap`, `transient`,
 * `client_crash`) and the daemon replaced it, so the work goes on.
 * - `switched`: a new session is open with `toExecutor`; its first prompt carries the state summary
 *   and the prompt that was in progress is back in the queue (`requeued`).
 * - `waiting`: nobody is available (`selection.director_wait: wait`), the queue waits and resumes
 *   by itself when an Executor is free (`scenario.director_resumed` says which one). `resetsAt` is
 *   the earliest known end of the wait, when a source says.
 * - `unavailable`: nobody can take it (`selection.director_wait: fail`, or no Executor of the
 *   role is left that did not fail): the queue stops until the next prompt tries again.
 * `fromExecutor` is null when the session had no Executor on record (a Director that came from
 * before this field). `detail` is the error text, masked and cut.
 */
export const ScenarioDirectorFailoverNoticeSchema = z.strictObject({
  scenarioId,
  kind: z.literal('director_failover'),
  outcome: z.enum(DIRECTOR_FAILOVER_OUTCOMES),
  cause: InterruptionCauseSchema,
  fromExecutor: z.string().min(1).max(256).nullable(),
  /** The Executor of the new session; null unless `outcome` is `switched`. */
  toExecutor: z.string().min(1).max(256).nullable(),
  /** The prompt of the queue that was in progress and went back to it; null when none was. */
  requeued: z.string().min(1).max(256).nullable(),
  resetsAt: z.int().min(0).nullable(),
  detail: z.string().min(1).max(512).nullable(),
});

export const ScenarioSystemMessagePayloadSchema = z.discriminatedUnion('kind', [
  ScenarioRecoveryNoticeSchema,
  ScenarioHandoffNoticeSchema,
  ScenarioSelectionWaitNoticeSchema,
  ScenarioResetWaitNoticeSchema,
  ScenarioDirectorFailoverNoticeSchema,
]);

/** What a `play.notice` tells (P16b, [proposta]): a situation of the play the daemon used to only log. */
export const PLAY_NOTICE_KINDS = [
  /** An effect of the machine that nothing carries out yet (judgment point 2). */
  'effect_not_implemented',
  /** The Vcs adapter cannot rebase, so the dependents were not moved. */
  'rebase_unsupported',
  /** The diff of the earlier attempt could not be read; the new one starts without it. */
  'old_diff_unreadable',
  /** The base moved and `delivery.base_drift: deliver_and_warn` delivers anyway. */
  'delivery_base_moved',
  /** Nobody answered the delivery question; the play goes on with the PR. */
  'delivery_unanswered',
  /** P24: a play that was open when the daemon started could not be resumed (`detail`: why, masked). */
  'play_not_resumed',
  /** P24: an effect of the machine failed to start; the state is saved and `resume` asks again (`detail`: the effect type and why). */
  'effect_not_started',
  /** P24: the handler of the end of a play failed (`detail`: why, masked). */
  'finish_not_handled',
  /** P24: the deadline of a demand fired and could not be delivered to the machine (`detail`: the demand and why). */
  'deadline_not_delivered',
  /** P19: the rules of exhaustion of the role and the budget could not be read; the attempt goes on with the defaults (`next`, `handoff`) (`detail`: why, masked). */
  'exhaustion_not_read',
] as const;
export type PlayNoticeKind = (typeof PLAY_NOTICE_KINDS)[number];

/**
 * `play.notice`: a situation of a play that is neither a wait nor a failure, written down so hooks
 * and plugins can read it (the owner's order of 2026-11-18). [proposta] `detail` is a short text
 * in English for the log (an effect type, an adapter id, a cause), never a path or a credential.
 */
export const PlayNoticePayloadSchema = z.strictObject({
  scenarioId: scenarioId.nullable(),
  playId: z.string().min(1),
  kind: z.enum(PLAY_NOTICE_KINDS),
  detail: z.string().max(500).nullable(),
});
