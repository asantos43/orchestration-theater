// SPDX-License-Identifier: MPL-2.0
import { defineEventType } from '@otheater/core';
import { z } from 'zod';
import { MENU_OPTIONS, PLAY_STATES } from './definitions.js';
import { JUDGMENT_POINT_IDS } from './judgment.js';

const text = z.string().min(1);
const demandId = text.max(256);
const reason = z.string().optional();

/**
 * The events the play machine takes (architecture 5.4): everything that happens to a play comes
 * in as one of these, from an effect that finished, a deadline, the Director or the Producer.
 * Strict objects: a typo in a field is an error.
 */
export const PlayEventSchema = z.discriminatedUnion('type', [
  /** The Producer opened the play. `dispenseCritic` waives the Critic for the whole play (5.4). */
  z.strictObject({
    type: z.literal('START'),
    dispenseCritic: z.strictObject({ reason: text }).optional(),
  }),
  /** The Producer cancels the play. [proposta] Allowed in every state that is not final. */
  z.strictObject({ type: z.literal('CANCEL'), reason }),
  z.strictObject({ type: z.literal('PLAN_SUBMITTED'), hasOpenQuestions: z.boolean() }),
  z.strictObject({ type: z.literal('QUESTIONS_ANSWERED') }),
  z.strictObject({ type: z.literal('PLAN_REVIEWED'), approved: z.boolean(), reason }),
  /** The script went through the validation in code; `demandIds` is required when it passed. */
  z
    .strictObject({
      type: z.literal('SCRIPT_VALIDATED'),
      valid: z.boolean(),
      demandIds: z.array(demandId).min(1).optional(),
      /**
       * [proposta] N84: the demands of the new script that equal the ones already approved and are
       * kept as they are (`rescript.reuse`). They must be in `demandIds`.
       */
      keptDemandIds: z.array(demandId).optional(),
      reason,
    })
    .refine((event) => !event.valid || event.demandIds !== undefined, {
      message: 'a valid script names its demands',
      path: ['demandIds'],
    })
    .refine(
      (event) =>
        event.demandIds === undefined || new Set(event.demandIds).size === event.demandIds.length,
      {
        message: 'the demand ids are not unique',
        path: ['demandIds'],
      },
    )
    .refine(
      (event) =>
        event.keptDemandIds === undefined ||
        event.keptDemandIds.every((id) => event.demandIds?.includes(id) === true),
      { message: 'a kept demand is one of the demands of the script', path: ['keptDemandIds'] },
    ),
  z.strictObject({ type: z.literal('SCRIPT_REVIEWED'), approved: z.boolean(), reason }),
  /**
   * N82: rebasing a dependent onto the new branch of its dependency conflicted (the daemon already
   * aborted the rebase). `mode` is `integration.rebase_conflict`, read by the effect.
   */
  z.strictObject({
    type: z.literal('REBASE_CONFLICT'),
    demandId,
    mode: z.enum(['redo', 'script_failure', 'resolve_attempt']),
    files: z.array(text),
    reason,
  }),
  /** A demand got an Actor. `timeoutMin` comes from the script; the default and the ceiling are in `limits`. */
  z.strictObject({
    type: z.literal('DEMAND_STARTED'),
    demandId,
    timeoutMin: z.int().min(1).optional(),
  }),
  /** The demand passed `verify` in its worktree. */
  z.strictObject({ type: z.literal('DEMAND_APPROVED'), demandId }),
  /** The attempt failed (`verify` failed, the session failed). Counts in `attempts_per_demand`. */
  z.strictObject({ type: z.literal('ATTEMPT_FAILED'), demandId, reason }),
  /** The Actor closed with `blocked`: the demand is not enough, a script failure (5.4). */
  z.strictObject({ type: z.literal('DEMAND_BLOCKED'), demandId, reason }),
  /** Judgment point 2: the Actor ran out of time. Also what the deadline of a demand sends. */
  z.strictObject({ type: z.literal('ACTOR_TIMED_OUT'), demandId }),
  /** Judgment point 6: the model refused, or a permission error. */
  z.strictObject({ type: z.literal('ACTOR_REFUSED'), demandId }),
  /** Judgment point 7: an attempt went over the limit of resumes. */
  z.strictObject({ type: z.literal('RESUMES_EXCEEDED'), demandId }),
  /** Judgment point 8: a demand was redone and others depend on it. */
  z.strictObject({
    type: z.literal('DEPENDENCY_REDONE'),
    demandId,
    dependentIds: z.array(demandId).min(1),
  }),
  /** The answer of the Director to a judgment point (validated against the schema of the point). */
  z.strictObject({
    type: z.literal('JUDGED'),
    point: z.enum(JUDGMENT_POINT_IDS),
    demandId: demandId.optional(),
    answer: z.record(z.string(), z.json()),
  }),
  /** The merge of the demands into the integration branch finished; `ok: false` is a conflict. */
  z.strictObject({ type: z.literal('INTEGRATED'), ok: z.boolean(), reason }),
  z.strictObject({ type: z.literal('CRITIQUED'), approved: z.boolean(), reason }),
  /** The session spent `limits.submit_retries` and the output of `submit*` is still invalid (N79). */
  z.strictObject({ type: z.literal('SUBMIT_FAILED'), demandId: demandId.optional(), reason }),
  /**
   * N83: in DELIVERING, merging the moved base into the integration branch conflicted, or a
   * `verify` failed after it. `mode` is `update` (back to SCRIPTING) or `ask` (the Producer chooses).
   */
  z.strictObject({
    type: z.literal('BASE_DRIFT'),
    mode: z.enum(['update', 'ask']),
    files: z.array(text),
    reason,
  }),
  z.strictObject({ type: z.literal('DELIVERED') }),
  /** The Producer chose an option of the fixed menu. */
  z
    .strictObject({
      type: z.literal('PRODUCER_CHOSE'),
      option: z.enum(MENU_OPTIONS),
      /** `redefine_need`: the new need. */
      need: text.optional(),
      /** `accept_as_is`: why the Producer waives the Critic (recorded as a decision). */
      reason: text.optional(),
    })
    .refine((event) => event.option !== 'redefine_need' || event.need !== undefined, {
      message: 'redefine_need carries the new need',
      path: ['need'],
    })
    .refine((event) => event.option !== 'accept_as_is' || event.reason !== undefined, {
      message: 'accept_as_is carries the reason',
      path: ['reason'],
    }),
]);
export type PlayEvent = z.infer<typeof PlayEventSchema>;
export type PlayEventType = PlayEvent['type'];

/**
 * What the machine receives: the event plus the moment it was taken in (epoch ms, from the core
 * `Clock`). The machine never reads the time itself, so a transition is a pure function.
 */
export type MachineEvent = PlayEvent & { readonly at: number };

const countersSchema = z.record(z.string(), z.int().min(0));

/** `play.created`: the play exists, in NEED, before its first event. [proposta] */
export const PlayCreatedPayloadSchema = z.strictObject({
  flowId: text,
  flowVersion: z.int().min(1),
  need: text,
  parentPlayId: text.nullable(),
});

/**
 * `play.transitioned`: one transition of the machine, written in the same transaction as the
 * snapshot (5.4, 5.21). [proposta] `effects` lists the types of the effects the transition
 * asked for, so the log tells what was about to start even if the daemon died before it did.
 */
export const PlayTransitionedPayloadSchema = z.strictObject({
  event: text,
  from: z.enum(PLAY_STATES),
  to: z.enum(PLAY_STATES),
  counters: countersSchema,
  effects: z.array(text),
});

export const PLAY_CREATED_EVENT = defineEventType({
  type: 'play.created',
  schemaVersion: 1,
  payload: PlayCreatedPayloadSchema,
});

export const PLAY_TRANSITIONED_EVENT = defineEventType({
  type: 'play.transitioned',
  schemaVersion: 1,
  payload: PlayTransitionedPayloadSchema,
});

/** The event types the play machine writes; the daemon registers them at start-up (5.18). */
export const PLAY_EVENT_DEFINITIONS = [PLAY_CREATED_EVENT, PLAY_TRANSITIONED_EVENT] as const;
