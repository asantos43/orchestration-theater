// SPDX-License-Identifier: MPL-2.0

/** Id and version of the play flow in the flow registry (architecture 5.4 and 5.18). */
export const PLAY_FLOW_ID = 'play';
/**
 * Version of the machine. A snapshot is only restored on the same version (5.4); change the
 * machine in a way that breaks a stored snapshot and this number goes up, with a migration.
 */
export const PLAY_FLOW_VERSION = 1;

/**
 * The states of the play (architecture 5.4). `NEED` is the state before the first transition: the
 * play exists with its need and waits for `START`. [proposta] `CANCELLED` is the end the menu
 * option "cancel" leads to; the architecture draws it without naming it.
 */
export const PLAY_STATES = [
  'NEED',
  'PLANNING',
  'CLARIFYING',
  'REVIEWING_PLAN',
  'SCRIPTING',
  'REVIEWING_SCRIPT',
  'EXECUTING',
  'INTEGRATING',
  'CRITIQUING',
  'DECIDING',
  'DELIVERING',
  'AWAITING_PRODUCER',
  'DONE',
  'CANCELLED',
] as const;
export type PlayState = (typeof PLAY_STATES)[number];

export const FINAL_PLAY_STATES = ['DONE', 'CANCELLED'] as const satisfies readonly PlayState[];

export function isFinalState(state: string): boolean {
  return (FINAL_PLAY_STATES as readonly string[]).includes(state);
}

/**
 * The loops that have a counter in `limits` (5.4). `attempts_per_demand` is kept per demand in the
 * counters of the play, as `attempts_per_demand:<demand id>`. `submit_retries` is counted by the
 * session that talks to the Executor (N79); the machine only learns when it is spent.
 */
export const COUNTER_KEYS = [
  'plan_reviews',
  'critic_rejections',
  'attempts_per_demand',
  'script_validations',
  'script_vetoes',
  'script_returns',
  'structural_restarts',
  'submit_retries',
] as const;
export type CounterKey = (typeof COUNTER_KEYS)[number];

/**
 * The fixed menu of AWAITING_PRODUCER (5.4, decided 2026-11-14, v0.32): a closed list that comes
 * from the code, with its own type of question that does not follow the 2 to 4 options limit of
 * `ask_producer`. The interface shows the ones that hold at the moment.
 */
export const MENU_OPTIONS = [
  'redefine_need',
  'raise_limit',
  'deliver_ready',
  'accept_as_is',
  /** [proposta] `delivery.base_drift: ask` only: go back to SCRIPTING on the new base, without counting. */
  'redo_on_new_base',
  /** [proposta] `delivery.base_drift: ask` only: open the PR with the conflicts listed. */
  'deliver_with_conflict',
  'cancel',
] as const;
export type MenuOption = (typeof MENU_OPTIONS)[number];

/**
 * The closed list of critical exceptions (5.4): they take the play to the Producer without waiting
 * for a counter.
 */
export const CRITICAL_EXCEPTIONS = [
  'impossible_need',
  'missing_access',
  'safety_risk',
  'out_of_scope_decision',
] as const;
export type CriticalException = (typeof CRITICAL_EXCEPTIONS)[number];

/** The kinds of failure the Director classifies a negative critique into (5.4, judgment point 1). */
export const FAILURE_KINDS = ['execution', 'script', 'structural', 'critical_exception'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Gravity order of a mixed critique: the most serious wins (5.4). */
export const FAILURE_SEVERITY: Readonly<Record<FailureKind, number>> = {
  execution: 1,
  script: 2,
  structural: 3,
  critical_exception: 4,
};

/** The moments the Critic is waived at (5.4): when the play opens, or after a rejection. */
export const WAIVER_MOMENTS = ['open', 'after_rejection'] as const;
export type WaiverMoment = (typeof WAIVER_MOMENTS)[number];

/** `kind` of the decision the Critic waiver is recorded as (DecisionRegistry). */
export const DISPENSE_CRITIC_KIND = 'dispense_critic';
