// SPDX-License-Identifier: MPL-2.0
import type { Decider, JsonValue } from '@otheater/core';
import { and, assign, not, setup, stateIn } from 'xstate';
import type { PlayLimits } from '../config.js';
import {
  bumpCounter,
  countOf,
  counterName,
  exhaustedAfter,
  pendingDemands,
  withoutAnyAttempts,
  withoutAttempts,
  type OpenJudgment,
  type PlayContext,
  type ProducerReason,
} from './context.js';
import {
  DISPENSE_CRITIC_KIND,
  FAILURE_SEVERITY,
  PLAY_FLOW_ID,
  PLAY_FLOW_VERSION,
  type CounterKey,
  type CriticalException,
  type FailureKind,
  type MenuOption,
  type PlayState,
} from './definitions.js';
import { entryEffects, type PlayEffect } from './effects.js';
import type { MachineEvent } from './events.js';
import { parseAnswer, type CritiqueFailure, type JudgmentPointId } from './judgment.js';
import { isAvailable } from './menu.js';

/** What the play machine is created with. */
export interface PlayMachineInput {
  readonly playId: string;
  readonly need: string;
  readonly limits: PlayLimits;
}

/**
 * A decision the machine asks the runner to record in the same transaction as the transition
 * (DecisionRegistry): the waiver of the Critic, the answer of a judgment point, the choice of
 * the Producer in the menu. The id is deterministic (`<play id>:d<n>`).
 */
export interface PlayDecision {
  readonly id: string;
  /** `dispense_critic`, `classify_critique`, `menu_choice`, or the id of another judgment point. */
  readonly kind: string;
  readonly input: Record<string, JsonValue>;
  readonly answer: Record<string, JsonValue>;
  readonly decidedBy: Decider;
}

interface Args {
  readonly context: PlayContext;
  readonly event: MachineEvent;
}

/** The part of a critique the Director classified that the machine acts on (judgment point 1). */
export interface Classification {
  readonly kind: FailureKind;
  /** `execution`: the demands to run again (the union of the execution failures). */
  readonly affected: readonly string[];
  /** `critical_exception`: which one. */
  readonly exception: CriticalException | null;
  /** The notes of every failure: the lesser ones go on as context of the new cycle (5.4). */
  readonly feedback: string | null;
}

/**
 * Reads the answer of judgment point 1. In a mixed critique the most serious failure wins
 * (structural, then script, then execution; an exception beats all). `undefined` when the answer
 * does not fit the schema or names a demand that is not in the script.
 */
export function classifyCritique(
  context: PlayContext,
  answer: unknown,
): Classification | undefined {
  const parsed = parseAnswer('classify_critique', answer) as
    { failures: CritiqueFailure[] } | undefined;
  if (parsed === undefined) return undefined;
  const failures = parsed.failures;
  const known = new Set(context.demandIds);
  if (failures.some((f) => (f.demandIds ?? []).some((id) => !known.has(id)))) return undefined;
  const worst = failures.reduce((a, b) =>
    FAILURE_SEVERITY[b.kind] > FAILURE_SEVERITY[a.kind] ? b : a,
  ).kind;
  const ofWorst = failures.filter((f) => f.kind === worst);
  const notes = failures.map((f) => f.note).filter((n): n is string => n !== undefined && n !== '');
  return {
    kind: worst,
    affected: [...new Set(ofWorst.flatMap((f) => f.demandIds ?? []))],
    exception: ofWorst.find((f) => f.exception !== undefined)?.exception ?? null,
    feedback: notes.length === 0 ? null : notes.join('\n'),
  };
}

/** The states a "raise the limit" can go back to (where a spent loop or a failed stage was). */
const RESUMABLE_STATES = [
  'PLANNING',
  'REVIEWING_PLAN',
  'SCRIPTING',
  'REVIEWING_SCRIPT',
  'EXECUTING',
  'CRITIQUING',
  'DECIDING',
] as const satisfies readonly PlayState[];

type Action = ReturnType<typeof patch> | ReturnType<typeof emit> | ReturnType<typeof record>;

function emit(build: (args: Args) => PlayEffect[]) {
  return { type: 'emit' as const, params: (args: Args) => ({ effects: build(args) }) };
}

function patch(build: (args: Args) => Partial<PlayContext>) {
  return { type: 'apply' as const, params: (args: Args) => build(args) };
}

function record(build: (args: Args) => Omit<PlayDecision, 'id'>) {
  return {
    type: 'record' as const,
    params: (args: Args) => ({
      decision: {
        id: `${args.context.playId}:d${String(args.context.decisionSeq)}`,
        ...build(args),
      },
    }),
  };
}

/** Bumps the sequence, then records: the id of the decision is the new sequence. */
function recorded(build: (args: Args) => Omit<PlayDecision, 'id'>): Action[] {
  return [patch(({ context }) => ({ decisionSeq: context.decisionSeq + 1 })), record(build)];
}

function enter(state: PlayState) {
  return emit(({ context }) => entryEffects(state, context));
}

function abort(reason: string) {
  return emit(() => [{ type: 'abort_work', reason }]);
}

function reasonOf(event: MachineEvent): string | null {
  return 'reason' in event && typeof event.reason === 'string' && event.reason !== ''
    ? event.reason
    : null;
}

function demandOf(event: MachineEvent): string | null {
  return 'demandId' in event && typeof event.demandId === 'string' ? event.demandId : null;
}

function isKnownPending({ context, event }: Args): boolean {
  const id = demandOf(event);
  return id !== null && pendingDemands(context).includes(id);
}

function isKnownDemand({ context, event }: Args): boolean {
  const id = demandOf(event);
  return id !== null && context.demandIds.includes(id);
}

function submitRetriesOf(context: PlayContext): number {
  return context.limits.submit_retries + (context.limitBonus.submit_retries ?? 0);
}

/** Counts the failure, and sends the play to the Producer: the counter ran out (5.4). */
function toProducerLimit(
  counter: CounterKey,
  resumeTo: PlayState,
  demandOfEvent: (a: Args) => string | null = () => null,
) {
  return patch((args) => {
    const demandId = demandOfEvent(args);
    const reason: ProducerReason = { kind: 'limit', counter, demandId, resumeTo };
    return {
      counters: bumpCounter(args.context, counterName(counter, demandId)),
      producerReason: reason,
      deadlines: {},
      openJudgments: [],
    };
  });
}

function toProducerException(exception: (a: Args) => CriticalException) {
  return patch((args) => ({
    producerReason: { kind: 'exception', exception: exception(args) },
    deadlines: {},
    openJudgments: [],
  }));
}

function toProducerConsulted(point: JudgmentPointId) {
  return patch((args) => ({
    producerReason: { kind: 'consulted', point, demandId: demandOf(args.event) },
    deadlines: {},
    openJudgments: [],
  }));
}

interface LoopOptions {
  /** Selects the event; the loop only applies when it holds. */
  readonly when?: (a: Args) => boolean;
  /** Runs first, in both branches. */
  readonly before?: readonly Action[];
}

/**
 * A loop that goes back to `back` (a counted return) or, when its counter ran out, to the
 * Producer (5.4: "todo laço tem contador").
 */
function loop(counter: CounterKey, back: PlayState, options: LoopOptions = {}) {
  const when = options.when ?? (() => true);
  const before = options.before ?? [];
  return [
    {
      guard: (a: Args) => when(a) && exhaustedAfter(a.context, counter),
      target: 'AWAITING_PRODUCER' as const,
      actions: [...before, toProducerLimit(counter, back)],
    },
    {
      guard: when,
      target: back,
      reenter: true,
      actions: [
        ...before,
        patch((a) => ({ counters: bumpCounter(a.context, counter), feedback: reasonOf(a.event) })),
      ],
    },
  ];
}

/**
 * A failure of the script that does not go through the Critic (a blocked Actor, a conflict in
 * the integration): back to SCRIPTING on `script_returns`, or to the Producer.
 */
function scriptReturn(when: (a: Args) => boolean) {
  return loop('script_returns', 'SCRIPTING', { when, before: [abort('script_failure')] });
}

/**
 * A structural failure: the plan starts over on `structural_restarts` (the other counters start
 * over too, 5.4), or the play goes to the Producer.
 */
function structuralRestart(
  when: (a: Args) => boolean,
  before: readonly Action[],
  feedback: (a: Args) => string | null,
) {
  return [
    {
      guard: (a: Args) => when(a) && exhaustedAfter(a.context, 'structural_restarts'),
      target: 'AWAITING_PRODUCER' as const,
      actions: [...before, toProducerLimit('structural_restarts', 'PLANNING')],
    },
    {
      guard: when,
      target: 'PLANNING' as const,
      reenter: true,
      actions: [
        ...before,
        abort('structural_restart'),
        patch((a) => ({
          counters: { structural_restarts: countOf(a.context, 'structural_restarts') + 1 },
          demandIds: [],
          approvedDemands: [],
          deadlines: {},
          openJudgments: [],
          criticRejected: false,
          deliverOnlyApproved: false,
          producerReason: null,
          feedback: feedback(a),
          restart: true,
        })),
      ],
    },
  ];
}

/** The session ran out of `submit_retries`: the stage failed, so the play goes to the Producer. */
function submitFailed(state: PlayState) {
  return {
    target: 'AWAITING_PRODUCER' as const,
    actions: [toProducerLimit('submit_retries', state, ({ event }) => demandOf(event))],
  };
}

/** Removes the open judgments of a demand (the Director answered, or the demand moved on). */
function withoutJudgments(
  context: PlayContext,
  demandId: string,
  point?: JudgmentPointId,
): OpenJudgment[] {
  return context.openJudgments.filter(
    (j) => !(j.demandId === demandId && (point === undefined || j.point === point)),
  );
}

function withoutDeadline(context: PlayContext, demandId: string): Record<string, number> {
  return Object.fromEntries(Object.entries(context.deadlines).filter(([id]) => id !== demandId));
}

type Strategy = Extract<PlayEffect, { type: 'run_demands' }>['strategy'];

/**
 * A failed attempt of a demand: it counts in `attempts_per_demand` (5.4). With attempts left the
 * demand runs again; with none, the play goes to the Producer. `strategy` says how the next
 * attempt differs (a judgment point can ask for a handoff or another Executor).
 */
function failAttempt(
  guard: (a: Args) => boolean,
  strategy: Strategy,
  before: readonly Action[] = [],
) {
  return [
    {
      guard: (a: Args) =>
        guard(a) && exhaustedAfter(a.context, 'attempts_per_demand', demandOf(a.event) ?? ''),
      target: 'AWAITING_PRODUCER' as const,
      actions: [
        ...before,
        toProducerLimit('attempts_per_demand', 'EXECUTING', ({ event }) => demandOf(event)),
      ],
    },
    {
      guard,
      actions: [
        ...before,
        patch((a) => {
          const id = demandOf(a.event) ?? '';
          return {
            counters: bumpCounter(a.context, counterName('attempts_per_demand', id)),
            deadlines: withoutDeadline(a.context, id),
            openJudgments: withoutJudgments(a.context, id),
            feedback: reasonOf(a.event),
          };
        }),
        emit(({ context, event }) => [
          {
            type: 'run_demands',
            demandIds: [demandOf(event) ?? ''],
            strategy,
            retry: true,
            feedback: context.feedback,
            submitRetries: submitRetriesOf(context),
          },
        ]),
      ],
    },
  ];
}

/** An event that opens a judgment point in EXECUTING: the Director is asked, the demand waits. */
function openJudgment(point: JudgmentPointId) {
  return {
    guard: (a: Args) => {
      const id = demandOf(a.event);
      return (
        id !== null &&
        a.context.demandIds.includes(id) &&
        !a.context.openJudgments.some((j) => j.point === point && j.demandId === id)
      );
    },
    actions: [
      patch((a) => {
        const id = demandOf(a.event) ?? '';
        const dependentIds = a.event.type === 'DEPENDENCY_REDONE' ? a.event.dependentIds : [];
        const judgment: OpenJudgment = { point, demandId: id, dependentIds };
        return {
          deadlines: withoutDeadline(a.context, id),
          openJudgments: [...a.context.openJudgments, judgment],
        };
      }),
      emit(({ event }) => [
        {
          type: 'judge',
          point,
          demandId: demandOf(event),
          dependentIds: event.type === 'DEPENDENCY_REDONE' ? event.dependentIds : [],
        },
      ]),
    ],
  };
}

/** The answer of the Director matches a judgment that is open, and its `action` is the one given. */
function answeredWith(point: JudgmentPointId, action: string) {
  return ({ context, event }: Args): boolean => {
    if (event.type !== 'JUDGED' || event.point !== point) return false;
    const id = event.demandId;
    if (
      id === undefined ||
      !context.openJudgments.some((j) => j.point === point && j.demandId === id)
    ) {
      return false;
    }
    const answer = parseAnswer(point, event.answer) as { action: string } | undefined;
    return answer?.action === action;
  };
}

/** Closes the open judgment and records the decision (decided by the Director). */
function settle(point: JudgmentPointId): Action[] {
  return [
    patch(({ context, event }) => ({
      openJudgments: withoutJudgments(context, demandOf(event) ?? '', point),
    })),
    ...recorded(({ event }) => ({
      kind: point,
      input: { demandId: demandOf(event) ?? '' },
      answer: event.type === 'JUDGED' ? event.answer : {},
      decidedBy: 'director',
    })),
  ];
}

function dependentsOf(context: PlayContext, demandId: string): readonly string[] {
  return (
    context.openJudgments.find((j) => j.point === 'dependency_redone' && j.demandId === demandId)
      ?.dependentIds ?? []
  );
}

/** The judgment points of EXECUTING (2, 6, 7 and 8) and what each answer does. */
function executingJudgments() {
  return [
    // 2. the Actor ran out of time: the partial work goes through `verify` like any demand
    {
      guard: answeredWith('actor_timeout', 'accept_partial'),
      actions: [
        ...settle('actor_timeout'),
        emit(({ event }) => [
          { type: 'verify_demand', demandId: demandOf(event) ?? '', partial: true },
        ]),
      ],
    },
    // [proposta] handing the demand to another Actor is a new attempt: it counts
    ...failAttempt(answeredWith('actor_timeout', 'reassign'), 'handoff', settle('actor_timeout')),
    // 6. refusal or permission error
    ...failAttempt(
      answeredWith('refusal_or_permission', 'reformulate'),
      'reformulate',
      settle('refusal_or_permission'),
    ),
    ...failAttempt(
      answeredWith('refusal_or_permission', 'switch_executor'),
      'switch_executor',
      settle('refusal_or_permission'),
    ),
    {
      guard: answeredWith('refusal_or_permission', 'ask_producer'),
      target: 'AWAITING_PRODUCER' as const,
      actions: [
        ...settle('refusal_or_permission'),
        // [proposta] The Director asked: this is a consultation, not one of the 4 critical
        // exceptions (the list is closed), so the menu has no "raise the limit".
        toProducerConsulted('refusal_or_permission'),
        abort('consulted'),
      ],
    },
    // 7. resumes of an attempt above the limit
    ...failAttempt(
      answeredWith('resumes_exceeded', 'handoff'),
      'handoff',
      settle('resumes_exceeded'),
    ),
    ...failAttempt(
      answeredWith('resumes_exceeded', 'fail_attempt'),
      'same',
      settle('resumes_exceeded'),
    ),
    {
      guard: answeredWith('resumes_exceeded', 'ask_producer'),
      target: 'AWAITING_PRODUCER' as const,
      actions: [
        ...settle('resumes_exceeded'),
        toProducerConsulted('resumes_exceeded'),
        abort('consulted'),
      ],
    },
    // 8. a dependency was redone
    {
      guard: answeredWith('dependency_redone', 'rebase'),
      actions: [
        emit(({ context, event }) => {
          const id = demandOf(event) ?? '';
          return [
            { type: 'rebase_dependents', demandId: id, dependentIds: dependentsOf(context, id) },
          ];
        }),
        ...settle('dependency_redone'),
      ],
    },
    {
      guard: answeredWith('dependency_redone', 'redo'),
      actions: [
        // the dependents lose their approval and their attempts: they start over on the new base
        patch(({ context, event }) => {
          const dependents = dependentsOf(context, demandOf(event) ?? '');
          return {
            approvedDemands: context.approvedDemands.filter((id) => !dependents.includes(id)),
            counters: withoutAttempts(context.counters, dependents),
          };
        }),
        emit(({ context, event }) => [
          {
            type: 'run_demands',
            demandIds: dependentsOf(context, demandOf(event) ?? ''),
            strategy: 'redo',
            retry: false,
            feedback: null,
            submitRetries: submitRetriesOf(context),
          },
        ]),
        ...settle('dependency_redone'),
      ],
    },
  ];
}

function approve() {
  return patch(({ context, event }) => {
    const id = demandOf(event) ?? '';
    return {
      approvedDemands: [...context.approvedDemands, id],
      deadlines: withoutDeadline(context, id),
      openJudgments: withoutJudgments(context, id),
      feedback: null,
    };
  });
}

/** The demand passed `verify`; the last one moves the play on to INTEGRATING. */
function approval() {
  return [
    {
      guard: (a: Args) => isKnownPending(a) && pendingDemands(a.context).length === 1,
      target: 'INTEGRATING' as const,
      actions: [approve()],
    },
    { guard: isKnownPending, actions: [approve()] },
  ];
}

/** The demand loses its approval: it runs again (N82). */
function unapprove() {
  return patch(({ context, event }) => ({
    approvedDemands: context.approvedDemands.filter((id) => id !== demandOf(event)),
  }));
}

/**
 * N82, `integration.rebase_conflict`: rebasing a dependent onto the new branch of its dependency
 * conflicted (the daemon aborted the rebase). `redo` and `resolve_attempt` open a new attempt of the
 * dependent and count in `attempts_per_demand`; `script_failure` goes back to SCRIPTING.
 */
function rebaseConflict() {
  const withMode = (mode: string) => (a: Args) =>
    a.event.type === 'REBASE_CONFLICT' && a.event.mode === mode && isKnownDemand(a);
  return [
    ...scriptReturn(withMode('script_failure')),
    ...failAttempt(withMode('redo'), 'redo', [unapprove()]),
    ...failAttempt(withMode('resolve_attempt'), 'resolve', [unapprove()]),
  ];
}

/** The deadline of a demand: the timeout of the script, or the default, never above the ceiling. */
function deadlineFor({ context, event }: Args): number {
  const { demand_timeout, demand_timeout_max } = context.limits;
  const requested =
    event.type === 'DEMAND_STARTED' && event.timeoutMin !== undefined
      ? event.timeoutMin * 60_000
      : demand_timeout;
  return event.at + Math.min(requested, demand_timeout_max);
}

/** The Critic rejected: counts the rejection and keeps its reason for the next cycle. */
function rejected() {
  return patch(({ context, event }) => ({
    counters: bumpCounter(context, 'critic_rejections'),
    criticRejected: true,
    feedback: reasonOf(event),
  }));
}

/** The answer of the Director to point 1 says the worst failure is `kind`. */
function classified(kind: FailureKind) {
  return ({ context, event }: Args): boolean =>
    event.type === 'JUDGED' &&
    event.point === 'classify_critique' &&
    classifyCritique(context, event.answer)?.kind === kind;
}

function classification(args: Args): Classification {
  const found =
    args.event.type === 'JUDGED' ? classifyCritique(args.context, args.event.answer) : undefined;
  return found ?? { kind: 'execution', affected: [], exception: null, feedback: null };
}

/** Records the answer of the Director to point 1 (decided by the Director). */
function recordClassification(): Action[] {
  return recorded(({ event }) => ({
    kind: 'classify_critique',
    input: {},
    answer: event.type === 'JUDGED' ? event.answer : {},
    decidedBy: 'director',
  }));
}

/** DECIDING: what the Director's classification of the critique does (judgment point 1, 5.4). */
function decidingTransitions() {
  return [
    {
      guard: classified('critical_exception'),
      target: 'AWAITING_PRODUCER' as const,
      actions: [
        ...recordClassification(),
        toProducerException((a) => classification(a).exception ?? 'out_of_scope_decision'),
      ],
    },
    ...structuralRestart(
      classified('structural'),
      recordClassification(),
      (a) => classification(a).feedback,
    ),
    {
      // a script failure goes back to the Scriptwriter; the Author reviews the new script
      guard: classified('script'),
      target: 'SCRIPTING' as const,
      actions: [
        ...recordClassification(),
        patch((a) => ({ feedback: classification(a).feedback })),
      ],
    },
    {
      // an execution failure runs again only the demands it affects
      guard: classified('execution'),
      target: 'EXECUTING' as const,
      actions: [
        ...recordClassification(),
        patch((a) => {
          const { affected, feedback } = classification(a);
          return {
            approvedDemands: a.context.approvedDemands.filter((id) => !affected.includes(id)),
            counters: withoutAttempts(a.context.counters, affected),
            feedback,
          };
        }),
      ],
    },
  ];
}

interface RaiseTransition {
  readonly guard: (a: Args) => boolean;
  readonly target: PlayState;
  readonly reenter?: boolean;
  readonly actions: Action[];
}

/** The options of the fixed menu and what each does (5.4). */
function menuTransitions() {
  const chose = (option: MenuOption) => (a: Args) =>
    a.event.type === 'PRODUCER_CHOSE' &&
    a.event.option === option &&
    isAvailable(option, a.context);
  const choice = (option: MenuOption): Action[] =>
    recorded(({ context, event }) => ({
      kind: 'menu_choice',
      input: { reason: context.producerReason?.kind ?? 'none' },
      answer: {
        option,
        ...(event.type === 'PRODUCER_CHOSE' && event.need ? { need: event.need } : {}),
      },
      decidedBy: 'producer',
    }));
  const raise = RESUMABLE_STATES.flatMap((state): RaiseTransition[] => {
    const guard = (a: Args) =>
      chose('raise_limit')(a) &&
      a.context.producerReason?.kind === 'limit' &&
      a.context.producerReason.resumeTo === state;
    const raised: Action[] = [
      ...choice('raise_limit'),
      patch(({ context }) => {
        const reason = context.producerReason;
        if (reason?.kind !== 'limit') return {};
        return {
          limitBonus: {
            ...context.limitBonus,
            [reason.counter]: (context.limitBonus[reason.counter] ?? 0) + 1,
          },
          producerReason: null,
          feedback: null,
        };
      }),
    ];
    if (state !== 'EXECUTING') return [{ guard, target: state, reenter: true, actions: raised }];
    // the last demand may have finished while the play waited: nothing is left to run
    return [
      {
        guard: (a: Args) => guard(a) && pendingDemands(a.context).length === 0,
        target: 'INTEGRATING' as const,
        actions: raised,
      },
      { guard, target: state, reenter: true, actions: raised },
    ];
  });
  return [
    ...raise,
    {
      guard: chose('redefine_need'),
      target: 'PLANNING' as const,
      reenter: true,
      actions: [
        ...choice('redefine_need'),
        abort('need_redefined'),
        patch(({ event }) => ({
          need: event.type === 'PRODUCER_CHOSE' && event.need !== undefined ? event.need : '',
          counters: {},
          limitBonus: {},
          demandIds: [],
          approvedDemands: [],
          deadlines: {},
          openJudgments: [],
          criticRejected: false,
          deliverOnlyApproved: false,
          producerReason: null,
          feedback: null,
          restart: true,
        })),
      ],
    },
    {
      guard: chose('deliver_ready'),
      target: 'DELIVERING' as const,
      actions: [
        ...choice('deliver_ready'),
        abort('deliver_ready'),
        patch(() => ({ deliverOnlyApproved: true, producerReason: null })),
      ],
    },
    {
      guard: chose('accept_as_is'),
      target: 'DELIVERING' as const,
      actions: [
        abort('accept_as_is'),
        patch(() => ({ criticWaived: true, deliverOnlyApproved: false, producerReason: null })),
        ...recorded(({ event }) => ({
          kind: DISPENSE_CRITIC_KIND,
          input: { moment: 'after_rejection' },
          answer: {
            moment: 'after_rejection',
            reason: event.type === 'PRODUCER_CHOSE' ? (event.reason ?? '') : '',
          },
          decidedBy: 'producer',
        })),
      ],
    },
    {
      // [proposta] N83: redo on the new base is a return the Producer asked for, so it is not counted
      guard: chose('redo_on_new_base'),
      target: 'SCRIPTING' as const,
      reenter: true,
      actions: [
        ...choice('redo_on_new_base'),
        patch(({ context }) => ({
          feedback:
            context.producerReason?.kind === 'base_drift' ? context.producerReason.reason : null,
          producerReason: null,
        })),
      ],
    },
    {
      guard: chose('deliver_with_conflict'),
      target: 'DELIVERING' as const,
      actions: [
        ...choice('deliver_with_conflict'),
        patch(() => ({ driftAccepted: true, producerReason: null })),
      ],
    },
    {
      guard: chose('cancel'),
      target: 'CANCELLED' as const,
      actions: [...choice('cancel'), abort('cancelled'), patch(() => ({ producerReason: null }))],
    },
  ];
}

const FRESH_CONTEXT = {
  counters: {},
  limitBonus: {},
  criticWaived: false,
  criticRejected: false,
  demandIds: [],
  approvedDemands: [],
  deadlines: {},
  openJudgments: [],
  feedback: null,
  producerReason: null,
  deliverOnlyApproved: false,
  driftAccepted: false,
  restart: false,
  decisionSeq: 0,
} as const;

/**
 * The play machine (architecture 5.4): one state per stage of the flow, the loop counters of
 * `limits`, the fixed menu of AWAITING_PRODUCER, the waiver of the Critic and the judgment
 * points of the Director.
 *
 * The machine is a pure description. It has no `after`, no `invoke`, no history state and no
 * promise in flight: the long work (sessions, merges) is asked for through the `emit` action,
 * which only carries the {@link PlayEffect} to the runner, and the answer comes back as an event.
 * The runner drives it with `transition()` (pure), writes the snapshot, and only then dispatches
 * the effects (`PlayRunner`). Deadlines are data in the context (`deadlines`), armed by the runner
 * through the core `Clock`.
 */
export const playMachine = setup({
  types: {
    context: {} as PlayContext,
    events: {} as MachineEvent,
    input: {} as PlayMachineInput,
  },
  actions: {
    /** Carries effects to the runner; does nothing by itself. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only types the params
    emit: (_args, _params: { effects: readonly PlayEffect[] }) => undefined,
    /** Carries a decision to record in the same transaction; does nothing by itself. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only types the params
    record: (_args, _params: { decision: PlayDecision }) => undefined,
    /** Updates the context. */
    apply: assign((_args, params: Partial<PlayContext>) => params),
  },
}).createMachine({
  id: 'play',
  initial: 'NEED',
  context: ({ input }) => ({
    flowId: PLAY_FLOW_ID,
    flowVersion: PLAY_FLOW_VERSION,
    playId: input.playId,
    need: input.need,
    limits: input.limits,
    ...FRESH_CONTEXT,
  }),
  on: {
    // [proposta] The Producer can cancel the play at any moment, outside the menu too.
    CANCEL: {
      // not in a final state; the built-in `stateIn` guard is not typed against `setup`
      guard: and([not(stateIn('DONE')), not(stateIn('CANCELLED'))]) as never,
      target: '.CANCELLED',
      actions: [abort('cancelled')],
    },
  },
  states: {
    NEED: {
      on: {
        START: [
          {
            guard: ({ event }) => event.dispenseCritic !== undefined,
            target: 'PLANNING',
            actions: [
              patch(() => ({ criticWaived: true })),
              ...recorded(({ event }) => ({
                kind: DISPENSE_CRITIC_KIND,
                input: { moment: 'open' },
                answer: {
                  moment: 'open',
                  reason: event.type === 'START' ? (event.dispenseCritic?.reason ?? '') : '',
                },
                decidedBy: 'producer',
              })),
            ],
          },
          { target: 'PLANNING' },
        ],
      },
    },
    PLANNING: {
      entry: [enter('PLANNING')],
      on: {
        PLAN_SUBMITTED: [
          {
            guard: ({ event }) => event.hasOpenQuestions,
            target: 'CLARIFYING',
            actions: [patch(() => ({ feedback: null, restart: false }))],
          },
          {
            target: 'REVIEWING_PLAN',
            actions: [patch(() => ({ feedback: null, restart: false }))],
          },
        ],
        SUBMIT_FAILED: submitFailed('PLANNING'),
      },
    },
    CLARIFYING: {
      entry: [enter('CLARIFYING')],
      on: { QUESTIONS_ANSWERED: { target: 'REVIEWING_PLAN' } },
    },
    REVIEWING_PLAN: {
      entry: [enter('REVIEWING_PLAN')],
      on: {
        PLAN_REVIEWED: [
          {
            guard: ({ event }) => event.approved,
            target: 'SCRIPTING',
            actions: [patch(() => ({ feedback: null }))],
          },
          ...loop('plan_reviews', 'PLANNING', {
            when: ({ event }) => event.type === 'PLAN_REVIEWED' && !event.approved,
          }),
        ],
        SUBMIT_FAILED: submitFailed('REVIEWING_PLAN'),
      },
    },
    SCRIPTING: {
      entry: [enter('SCRIPTING')],
      on: {
        SCRIPT_VALIDATED: [
          {
            guard: ({ event }) => event.valid,
            target: 'REVIEWING_SCRIPT',
            actions: [
              patch(({ context, event }) => {
                const demandIds = event.type === 'SCRIPT_VALIDATED' ? (event.demandIds ?? []) : [];
                // N84: a demand the new script keeps as it is stays approved, if it was
                const kept = event.type === 'SCRIPT_VALIDATED' ? (event.keptDemandIds ?? []) : [];
                return {
                  demandIds,
                  approvedDemands: demandIds.filter(
                    (id) => kept.includes(id) && context.approvedDemands.includes(id),
                  ),
                  deadlines: {},
                  openJudgments: [],
                  counters: withoutAnyAttempts(context.counters),
                  feedback: null,
                  driftAccepted: false,
                };
              }),
            ],
          },
          ...loop('script_validations', 'SCRIPTING', {
            when: ({ event }) => event.type === 'SCRIPT_VALIDATED' && !event.valid,
          }),
        ],
        SUBMIT_FAILED: submitFailed('SCRIPTING'),
      },
    },
    REVIEWING_SCRIPT: {
      entry: [enter('REVIEWING_SCRIPT')],
      on: {
        SCRIPT_REVIEWED: [
          {
            // N84: every demand was kept from the previous script, so nothing is left to run
            guard: ({ context, event }) => event.approved && pendingDemands(context).length === 0,
            target: 'INTEGRATING',
            actions: [patch(() => ({ feedback: null }))],
          },
          {
            guard: ({ event }) => event.approved,
            target: 'EXECUTING',
            actions: [patch(() => ({ feedback: null }))],
          },
          ...loop('script_vetoes', 'SCRIPTING', {
            when: ({ event }) => event.type === 'SCRIPT_REVIEWED' && !event.approved,
          }),
        ],
        SUBMIT_FAILED: submitFailed('REVIEWING_SCRIPT'),
      },
    },
    EXECUTING: {
      entry: [enter('EXECUTING')],
      on: {
        DEMAND_STARTED: {
          guard: isKnownPending,
          actions: [
            patch((a) => ({
              deadlines: { ...a.context.deadlines, [demandOf(a.event) ?? '']: deadlineFor(a) },
            })),
          ],
        },
        DEMAND_APPROVED: approval(),
        ATTEMPT_FAILED: failAttempt(isKnownPending, 'same'),
        DEMAND_BLOCKED: scriptReturn(isKnownPending),
        ACTOR_TIMED_OUT: openJudgment('actor_timeout'),
        ACTOR_REFUSED: openJudgment('refusal_or_permission'),
        RESUMES_EXCEEDED: openJudgment('resumes_exceeded'),
        DEPENDENCY_REDONE: openJudgment('dependency_redone'),
        JUDGED: executingJudgments(),
        REBASE_CONFLICT: rebaseConflict(),
        SUBMIT_FAILED: submitFailed('EXECUTING'),
      },
    },
    INTEGRATING: {
      entry: [enter('INTEGRATING')],
      on: {
        INTEGRATED: [
          // a conflict is a script failure, without the Critic (5.4)
          ...scriptReturn(({ event }) => event.type === 'INTEGRATED' && !event.ok),
          { guard: ({ context }) => context.criticWaived, target: 'DELIVERING' },
          { target: 'CRITIQUING' },
        ],
      },
    },
    CRITIQUING: {
      entry: [enter('CRITIQUING')],
      on: {
        CRITIQUED: [
          { guard: ({ event }) => event.approved, target: 'DELIVERING' },
          // more rejections than `critic_rejections`: a structural failure (5.4)
          ...structuralRestart(
            ({ context, event }) =>
              event.type === 'CRITIQUED' &&
              !event.approved &&
              exhaustedAfter(context, 'critic_rejections'),
            [rejected()],
            ({ event }) => reasonOf(event),
          ),
          { target: 'DECIDING', actions: [rejected()] },
        ],
        SUBMIT_FAILED: submitFailed('CRITIQUING'),
      },
    },
    DECIDING: {
      entry: [enter('DECIDING')],
      on: {
        JUDGED: decidingTransitions(),
        SUBMIT_FAILED: submitFailed('DECIDING'),
      },
    },
    DELIVERING: {
      entry: [enter('DELIVERING')],
      on: {
        DELIVERED: { target: 'DONE' },
        // N83: the base moved and does not merge cleanly into the integration
        BASE_DRIFT: [
          ...scriptReturn(({ event }) => event.type === 'BASE_DRIFT' && event.mode === 'update'),
          {
            guard: ({ event }) => event.mode === 'ask',
            target: 'AWAITING_PRODUCER',
            actions: [
              patch(({ event }) => ({
                producerReason: {
                  kind: 'base_drift',
                  files: event.type === 'BASE_DRIFT' ? event.files : [],
                  reason: reasonOf(event) ?? '',
                },
              })),
            ],
          },
        ],
      },
    },
    AWAITING_PRODUCER: {
      entry: [enter('AWAITING_PRODUCER')],
      on: {
        PRODUCER_CHOSE: menuTransitions(),
        // the demands that were still running when the counter ran out can still finish
        DEMAND_APPROVED: { guard: isKnownPending, actions: [approve()] },
      },
    },
    DONE: { type: 'final' },
    CANCELLED: { type: 'final' },
  },
});
