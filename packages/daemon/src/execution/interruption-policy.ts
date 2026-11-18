// SPDX-License-Identifier: MPL-2.0
import type { WhenExhausted } from '@otheater/core';
import type { InterruptionCause, ResumeForm } from '@otheater/protocol';
import type { ON_PROFILE_REMOVED_MODES } from '../config.js';

/**
 * The policy by cause of architecture 5.16 ("Política por causa"), as a pure function: the facts
 * of one interruption and the rules of the configuration in, the action out. No clock, no store,
 * no client: the same input always gives the same answer, so the table is tested one row per cause
 * and the runner only carries the action out.
 *
 * Who executes what (Phase 5): `resume_native` is the runner's own (`session/load`, with the
 * backoff); `handoff` belongs to P18 and `wait_for_reset` to P19 (the runner waits for the restore
 * hook, then reloads the session in the same profile); `finish_session` and `ask_producer` belong
 * to the spending cap (P11); `director_judgment` is the Director's decision point (5.4).
 */

/** What the daemon does about an interruption. */
export const INTERRUPTION_ACTIONS = [
  /** Reload the conversation (`session/load`) after `delayMs`, in the same profile. */
  'resume_native',
  /** Wait until `resetsAt`, then resume natively in the same profile (P19). */
  'wait_for_reset',
  /** New session in the next available Executor of the role, with a continuation package (P18). */
  'handoff',
  /** Let the session end by itself and stop new ones (`in_flight: finish`; P11). */
  'finish_session',
  /** Stop and ask the Producer (`in_flight: stop`; P11). */
  'ask_producer',
  /** The Director decides (5.4): reformulate, change Executor or ask the Producer. */
  'director_judgment',
] as const;
export type InterruptionAction = (typeof INTERRUPTION_ACTIONS)[number];

/** `profiles.<id>.budget.in_flight` (5.6): what a session in progress does when the cap is hit. */
export const IN_FLIGHT_MODES = ['handoff', 'finish', 'stop'] as const;
export type InFlightMode = (typeof IN_FLIGHT_MODES)[number];

/** `resume.client_crash_counts` [proposta]: when a client drop counts as an attempt of the demand. */
export const CLIENT_CRASH_COUNT_MODES = ['repeat', 'never', 'always'] as const;
export type ClientCrashCounts = (typeof CLIENT_CRASH_COUNT_MODES)[number];

/** `resume.transient_exhausted` [proposta]: what follows the last step of `transient_backoff`. */
export const TRANSIENT_EXHAUSTED_MODES = ['last', 'handoff'] as const;
export type TransientExhausted = (typeof TRANSIENT_EXHAUSTED_MODES)[number];

/**
 * `resume.on_profile_removed` [proposta] (P21b, N152): what an attempt does when the profile of its
 * session is removed. `handoff` passes the baton to the next Executor of the role; `park` leaves
 * the attempt `interrupted` for the Director to decide.
 */
export type OnProfileRemoved = (typeof ON_PROFILE_REMOVED_MODES)[number];

/** The values of `resume.*` the policy reads (durations in milliseconds). */
export interface InterruptionRules {
  /** `resume.max_resumes`: past it, the case goes to the Director's judgment point. */
  readonly maxResumes: number;
  /** `resume.quota_wait_max`: a reset nearer than this, with the rule `wait`, is waited for. */
  readonly quotaWaitMaxMs: number;
  /** `resume.transient_backoff`. */
  readonly transientBackoffMs: readonly number[];
  readonly transientExhausted: TransientExhausted;
  readonly clientCrashCounts: ClientCrashCounts;
  /** `resume.stuck.same_error_times`. */
  readonly stuckSameErrorTimes: number;
  /** `resume.on_profile_removed` (P21b). */
  readonly onProfileRemoved: OnProfileRemoved;
}

/** What is known about one interruption. */
export interface InterruptionFacts {
  readonly cause: InterruptionCause;
  /** The instant of the decision (epoch ms). */
  readonly now: number;
  /** When the quota or the cap comes back, if a source said so (`QuotaService`); else `null`. */
  readonly resetsAt: number | null;
  /** `roles.<role>.when_exhausted`: wait for the reset, or move to the next Executor. */
  readonly whenExhausted: WhenExhausted;
  readonly inFlight: InFlightMode;
  /**
   * `profiles.<id>.budget.on_exceeded` resolved to `wait` (P19): with `in_flight: handoff`, a spending
   * cap that comes back within `resume.quota_wait_max` is waited for instead of passing the baton.
   * Absent: the baton goes (`skip`, the default).
   */
  readonly waitForCap?: boolean;
  /** The conversation can be reloaded in place (`session/load`): it exists and its files do. */
  readonly reloadable: boolean;
  /**
   * The drop was no failure of the client: another session's cancel ended the shared process
   * (`pool.shared_cancel`) and the free allowance (`resume.max_free_resumes`) has room.
   */
  readonly free: boolean;
  /** Native resumes this attempt already made. */
  readonly resumes: number;
  /** How many times in a row the same interruption came up, this one included. */
  readonly repeated: number;
  /** Client drops this attempt had before this one, free ones excluded. */
  readonly priorCrashes: number;
}

/** The answer: what to do, in which form, and whether it costs an attempt of the demand. */
export interface InterruptionDecision {
  /** The cause the interruption is recorded under; differs from the input when it was reclassified. */
  readonly cause: InterruptionCause;
  readonly action: InterruptionAction;
  /** How the work continues, when that is known (`interruptions.resume_form`). */
  readonly form: ResumeForm | null;
  /** Whether the interruption consumes an attempt of the demand (5.16, last column). */
  readonly countsAsAttempt: boolean;
  /** Wait before a native resume, in milliseconds. */
  readonly delayMs: number;
  /** When the quota or the cap comes back, epoch ms, if known. */
  readonly resetsAt: number | null;
  /** A handoff must go to an Executor other than the one that was running (stuck agent). */
  readonly differentExecutor: boolean;
  /** Short text for the log and the chat; never decide on it. */
  readonly reason: string;
}

const LOOPING_CAUSES: readonly InterruptionCause[] = [
  'quota_exhausted',
  'spend_cap',
  'transient',
  'client_crash',
];

export function decideInterruption(
  facts: InterruptionFacts,
  rules: InterruptionRules,
): InterruptionDecision {
  const base = {
    cause: facts.cause,
    delayMs: 0,
    resetsAt: facts.resetsAt,
    differentExecutor: false,
    countsAsAttempt: false,
  };
  const make = (
    action: InterruptionAction,
    form: ResumeForm | null,
    reason: string,
    extra: Partial<InterruptionDecision> = {},
  ): InterruptionDecision => ({ ...base, action, form, reason, ...extra });

  switch (facts.cause) {
    case 'timeout':
      // The Director evaluates the partial result; what continues is a handoff. Costs an attempt.
      return make('director_judgment', 'handoff', 'the demand reached its time limit', {
        countsAsAttempt: true,
      });
    case 'refusal':
      return make('director_judgment', null, 'the model refused to continue', {
        countsAsAttempt: true,
      });
    case 'permission':
      return make('director_judgment', null, 'a permission was denied', { countsAsAttempt: true });
    case 'stuck':
      return stuck(make, 'the agent is stuck or in a loop');
    case 'daemon_restart':
      // Never an attempt, never limited by `max_resumes`: a restart is no failure of the agent.
      return facts.reloadable
        ? make('resume_native', 'native', 'the conversation files are there')
        : make('handoff', 'handoff', 'the conversation cannot be reloaded');
    case 'profile_removed':
      // An external cause (P21b, N152): no attempt spent, no `max_resumes`, never a native resume
      // on the profile that left and never the wait for its reset. The conversation stays where it
      // was; the work goes on elsewhere, in a different Executor than the one that left.
      return rules.onProfileRemoved === 'park'
        ? make(
            'director_judgment',
            null,
            'its profile was removed; resume.on_profile_removed is park',
          )
        : make(
            'handoff',
            'handoff',
            'its profile is being removed; the work goes to the next Executor of the role',
            { differentExecutor: true },
          );
    default:
      break;
  }

  // The causes that can come back again and again: the resume limit comes first, then a repeat.
  if (LOOPING_CAUSES.includes(facts.cause) && !facts.free && facts.resumes >= rules.maxResumes) {
    return make(
      'director_judgment',
      null,
      `${String(facts.resumes)} resumes made, the limit is ${String(rules.maxResumes)}`,
      { countsAsAttempt: countsAsAttempt(facts, rules) },
    );
  }
  const decision = byCause(facts, rules, make);
  const resumesInPlace =
    decision.action === 'resume_native' || decision.action === 'wait_for_reset';
  if (resumesInPlace && !facts.free && facts.repeated >= rules.stuckSameErrorTimes) {
    return stuck(make, `the same interruption came up ${String(facts.repeated)} times`);
  }
  return decision;
}

type Make = (
  action: InterruptionAction,
  form: ResumeForm | null,
  reason: string,
  extra?: Partial<InterruptionDecision>,
) => InterruptionDecision;

function stuck(make: Make, reason: string): InterruptionDecision {
  return make('handoff', 'handoff', reason, {
    cause: 'stuck',
    countsAsAttempt: true,
    differentExecutor: true,
  });
}

/** Whether a client drop costs an attempt: never the first one, unless the mode says so. */
function countsAsAttempt(facts: InterruptionFacts, rules: InterruptionRules): boolean {
  if (facts.cause !== 'client_crash' || facts.free) return false;
  switch (rules.clientCrashCounts) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'repeat':
      return facts.priorCrashes >= 1;
  }
}

function byCause(
  facts: InterruptionFacts,
  rules: InterruptionRules,
  make: Make,
): InterruptionDecision {
  switch (facts.cause) {
    case 'quota_exhausted':
      return quota(facts, rules, make);
    case 'spend_cap':
      return spendCap(facts, rules, make);
    case 'transient': {
      if (!facts.reloadable)
        return make('handoff', 'handoff', 'the conversation cannot be reloaded');
      const steps = rules.transientBackoffMs;
      if (rules.transientExhausted === 'handoff' && facts.resumes >= steps.length) {
        return make('handoff', 'handoff', 'the backoff steps are spent');
      }
      const delayMs =
        steps.length === 0 ? 0 : (steps[Math.min(facts.resumes, steps.length - 1)] ?? 0);
      return make('resume_native', 'native', 'a transient error; resuming after the backoff', {
        delayMs,
      });
    }
    case 'client_crash': {
      const counts = countsAsAttempt(facts, rules);
      return facts.reloadable
        ? make('resume_native', 'native', 'the client process dropped', { countsAsAttempt: counts })
        : make('handoff', 'handoff', 'the client process dropped and the conversation is gone', {
            countsAsAttempt: counts,
          });
    }
    default:
      // The other causes returned before; this keeps the switch exhaustive for the compiler.
      return make('director_judgment', null, 'no policy for this cause');
  }
}

function spendCap(
  facts: InterruptionFacts,
  rules: InterruptionRules,
  make: Make,
): InterruptionDecision {
  switch (facts.inFlight) {
    case 'handoff':
      if (facts.waitForCap === true && facts.reloadable && facts.resetsAt !== null) {
        const wait = Math.max(0, facts.resetsAt - facts.now);
        if (wait <= rules.quotaWaitMaxMs) {
          return make(
            'wait_for_reset',
            'native',
            'the spending cap was hit and comes back soon; on_exceeded is wait',
          );
        }
      }
      return make('handoff', 'handoff', 'the spending cap was hit; in_flight is handoff');
    case 'finish':
      return make('finish_session', null, 'the spending cap was hit; in_flight is finish');
    case 'stop':
      return make('ask_producer', null, 'the spending cap was hit; in_flight is stop');
  }
}

function quota(
  facts: InterruptionFacts,
  rules: InterruptionRules,
  make: Make,
): InterruptionDecision {
  if (facts.whenExhausted !== 'wait') {
    return make('handoff', 'handoff', 'the quota is spent and the role moves to the next Executor');
  }
  if (!facts.reloadable) {
    return make('handoff', 'handoff', 'the quota is spent and the conversation cannot be reloaded');
  }
  if (facts.resetsAt === null) {
    return make('handoff', 'handoff', 'the quota is spent and no source says when it comes back');
  }
  const wait = Math.max(0, facts.resetsAt - facts.now);
  if (wait > rules.quotaWaitMaxMs) {
    return make('handoff', 'handoff', 'the quota comes back later than resume.quota_wait_max');
  }
  return make('wait_for_reset', 'native', 'the quota comes back soon; waiting for the reset');
}
