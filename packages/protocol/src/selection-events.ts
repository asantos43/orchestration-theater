// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payload of the `executor.selected` event (architecture 5.7, "Algoritmo", step 5; Phase 5, P15).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; a strict object.
 * [proposta] The event name is the architecture's; the fields below are not. Every Executor is its
 * complete name `<model>-<effort>@<client>/<profile>`, and a profile is `<client>/<profile>`.
 * The reasons mirror `SKIP_REASONS` of `@otheater/core` (the protocol does not import it): the
 * eight of 5.7 (`quota`, `budget`, `draining`, `invalid`, `no_slot`, `ram`, `context`,
 * `same_provider`) and three the algorithm needs [proposta]: `unhealthy`, `same_model` (`other_model`
 * cross-review) and `retry` (an Executor the retry with diversity left behind).
 */

const executor = z.string().min(1).max(256);
const epochMs = z.int().min(0);

export const EXECUTOR_SELECTED_SKIP_REASONS = [
  'quota',
  'budget',
  'draining',
  'invalid',
  'no_slot',
  'ram',
  'context',
  'same_provider',
  'same_model',
  'unhealthy',
  'retry',
] as const;

export const EXECUTOR_SELECTED_STRATEGIES = ['ordered', 'most_headroom', 'round_robin'] as const;
export const EXECUTOR_SELECTED_CROSS_CHECK_MODES = [
  'prefer_other_provider',
  'require_other_provider',
  'other_model',
  'off',
] as const;

/** An Executor the selection passed over, and why. */
export const ExecutorSkippedSchema = z.strictObject({
  executor,
  profile: z.string().min(1).max(256),
  reason: z.enum(EXECUTOR_SELECTED_SKIP_REASONS),
  /** What the reason is about (`exhausted`, `unknown`, `near_limit`, a window size...). */
  detail: z.string().max(512).nullable(),
  /** When the cause ends (a quota or a spending cap that says it); null otherwise. */
  untilReset: epochMs.nullable(),
});

/**
 * `executor.selected`: the selection of an Executor for a role, with the Executors it passed over
 * and why (5.7). `outcome: selected` carries the Executor; `outcome: waiting` means nobody was
 * available and `waiting` says what the role waits for (`next`: whichever of `on` frees first;
 * `wait`: the reset of the one in `on`; an empty `on`: nothing that time can fix). `skipped` is
 * always present, empty when the first Executor of the list was taken.
 */
export const ExecutorSelectedPayloadSchema = z
  .strictObject({
    role: z.string().min(1).max(64),
    /** The play the demand belongs to; null outside a play (the chat of a scenario). */
    playId: z.string().min(1).max(256).nullable(),
    outcome: z.enum(['selected', 'waiting']),
    /** The Executor chosen; null when `outcome` is `waiting`. */
    executor: executor.nullable(),
    profile: z.string().min(1).max(256).nullable(),
    strategy: z.enum(EXECUTOR_SELECTED_STRATEGIES),
    /** The Executor of the attempt before, when this selection is a retry with diversity. */
    retriedAfter: executor.nullable(),
    crossCheck: z.strictObject({
      mode: z.enum(EXECUTOR_SELECTED_CROSS_CHECK_MODES),
      /** The role is a cross-reviewer and there was work to compare with. */
      applied: z.boolean(),
      /** The provider of whoever did the work. */
      workedProvider: z.string().min(1).max(128).nullable(),
      /**
       * The selection went back to the provider of the work: nobody else was available
       * (`prefer_other_provider`, or a strict mode under `selection.strict_unavailable:
       * fallback_prefer`).
       */
      fellBack: z.boolean(),
      /**
       * A strict mode left the role with nobody although an Executor it set aside was available
       * (N135): the role waits.
       */
      blocked: z.boolean(),
    }),
    skipped: z.array(ExecutorSkippedSchema).max(256),
    waiting: z
      .strictObject({
        mode: z.enum(['next', 'wait']),
        on: z.array(executor).max(256),
        /** The earliest known end of the wait; null when no source says. */
        until: epochMs.nullable(),
        /**
         * N135, `selection.strict_unavailable: wait_notify`: the wait is the strict cross-review's
         * and the Producer is to be told. False with `wait` and for any other wait.
         */
        notify: z.boolean(),
      })
      .nullable(),
    occurredAt: epochMs,
  })
  .superRefine((payload, ctx) => {
    const selected = payload.outcome === 'selected';
    if (selected !== (payload.executor !== null) || selected !== (payload.profile !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['executor'],
        message: 'executor and profile are set exactly when outcome is "selected"',
      });
    }
    if (selected !== (payload.waiting === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['waiting'],
        message: 'waiting is set exactly when outcome is "waiting"',
      });
    }
  });

/**
 * What a role waits on, one entry per Executor set aside (the `RoleWait.on` of the daemon): the
 * Executor, its profile and why it is out for now. Shared by the four wait events below.
 */
export const SelectionWaitOnSchema = z.strictObject({
  executor,
  profile: z.string().min(1).max(256),
  reason: z.enum(EXECUTOR_SELECTED_SKIP_REASONS),
});

/** How a wait ended: an Executor was chosen, nobody can come back by waiting, or it was cancelled. */
export const SELECTION_WAIT_OUTCOMES = ['selected', 'unavailable', 'cancelled'] as const;
export type SelectionWaitOutcome = (typeof SELECTION_WAIT_OUTCOMES)[number];

const waitText = z.string().min(1).max(1024);
const roleName = z.string().min(1).max(64);
const idText = z.string().min(1).max(256);

/**
 * `scenario.director_waiting` (Phase 5, P16b, N141; [proposta] the name and the fields): the
 * Director of a scenario has no Executor (`selection.director_wait: wait`) and its session is held
 * until one is free. `executor.selected` with `outcome: waiting` says the same from the selection's
 * side, for any role; this one is the Director's, so a hook or a plugin can follow it by scenario.
 */
export const ScenarioDirectorWaitingPayloadSchema = z.strictObject({
  scenarioId: idText,
  on: z.array(SelectionWaitOnSchema).max(256),
  /** The earliest known end of the wait; null when no source says. */
  until: epochMs.nullable(),
  /** "waiting for quota of claude-code/a" (English: the log is not translated). */
  message: waitText,
  since: epochMs,
});

/** `scenario.director_resumed`: the Director's wait ended; `executor` is who it opens with. */
export const ScenarioDirectorResumedPayloadSchema = z.strictObject({
  scenarioId: idText,
  outcome: z.enum(SELECTION_WAIT_OUTCOMES),
  /** The Executor chosen; null unless `outcome` is `selected`. */
  executor: executor.nullable(),
  waitedMs: z.int().min(0),
});

/**
 * `demand.waiting` (P16b, N142; [proposta]): a demand of a play has no Executor and waits.
 * `holdsSlot` is `selection.waiting_holds_slot`: whether it still counts as in flight in its play.
 */
export const DemandWaitingPayloadSchema = z.strictObject({
  scenarioId: idText.nullable(),
  playId: idText,
  demandId: idText,
  role: roleName,
  on: z.array(SelectionWaitOnSchema).max(256),
  until: epochMs.nullable(),
  message: waitText,
  since: epochMs,
  holdsSlot: z.boolean(),
});

/** `demand.resumed`: the wait of a demand ended (`selected`: the demand goes on with `executor`). */
export const DemandResumedPayloadSchema = z.strictObject({
  scenarioId: idText.nullable(),
  playId: idText,
  demandId: idText,
  role: roleName,
  outcome: z.enum(SELECTION_WAIT_OUTCOMES),
  executor: executor.nullable(),
  waitedMs: z.int().min(0),
  holdsSlot: z.boolean(),
});
