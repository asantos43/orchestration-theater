// SPDX-License-Identifier: MPL-2.0
import type { PlayLimits } from '../config.js';
import type { CounterKey, CriticalException, PlayState } from './definitions.js';
import type { JudgmentPointId } from './judgment.js';

/**
 * Why a play is in AWAITING_PRODUCER. It decides which options of the fixed menu hold (`raise_limit`
 * only for a spent counter) and what the question says.
 */
export type ProducerReason =
  | {
      readonly kind: 'limit';
      /** The counter that ran out. */
      readonly counter: CounterKey;
      /** The demand, for `attempts_per_demand`. */
      readonly demandId: string | null;
      /** Where "raise the limit and go on" goes back to. */
      readonly resumeTo: PlayState;
    }
  | { readonly kind: 'exception'; readonly exception: CriticalException }
  | {
      /** A judgment point of the Director chose "ask the Producer". */
      readonly kind: 'consulted';
      readonly point: JudgmentPointId;
      readonly demandId: string | null;
    };

/** A judgment point that was opened in EXECUTING and waits for the answer of the Director. */
export interface OpenJudgment {
  readonly point: JudgmentPointId;
  readonly demandId: string;
  /** The demands that depend on `demandId` (point 8 only; empty otherwise). */
  readonly dependentIds: readonly string[];
}

/**
 * The context of the machine. It is what `getPersistedSnapshot()` writes, so it holds only JSON
 * (no `undefined`, no functions) and nothing that is already in the store's own tables beyond what
 * the transitions need.
 */
export interface PlayContext {
  readonly flowId: string;
  /** Version of the machine that wrote the snapshot; a snapshot is only restored on the same one. */
  readonly flowVersion: number;
  readonly playId: string;
  readonly need: string;
  /** The limits of this play, fixed when it was created (a config change does not touch a play in flight). */
  readonly limits: PlayLimits;
  /** Loop counters by name; the attempts of a demand are `attempts_per_demand:<demand id>`. */
  readonly counters: Readonly<Record<string, number>>;
  /** Rounds the Producer added with "raise the limit", by counter. */
  readonly limitBonus: Readonly<Record<string, number>>;
  /** The Critic was waived for the whole play (5.4). */
  readonly criticWaived: boolean;
  /** The Critic rejected the integrated work at least once since the play (re)started. */
  readonly criticRejected: boolean;
  /** The demands of the current script. */
  readonly demandIds: readonly string[];
  /** The demands that passed `verify` in the current script. */
  readonly approvedDemands: readonly string[];
  /** Absolute deadline (epoch ms) of each running demand, by demand id. The runner arms the timers. */
  readonly deadlines: Readonly<Record<string, number>>;
  readonly openJudgments: readonly OpenJudgment[];
  /** The reason of the last return (rejection, veto, failure), handed to the next stage. */
  readonly feedback: string | null;
  readonly producerReason: ProducerReason | null;
  /** DELIVERING with only the approved demands ("deliver what is ready"). */
  readonly deliverOnlyApproved: boolean;
  /** PLANNING was entered by a restart or a new need, not for the first time. */
  readonly restart: boolean;
  /** Sequence of the decisions this play recorded; makes their ids deterministic (`<play>:d<n>`). */
  readonly decisionSeq: number;
}

export function counterName(key: CounterKey, demandId?: string | null): string {
  return demandId === undefined || demandId === null ? key : `${key}:${demandId}`;
}

export function countOf(context: PlayContext, name: string): number {
  return context.counters[name] ?? 0;
}

/** The limit of a counter now: the preset (or override) plus the rounds the Producer added. */
export function limitFor(context: PlayContext, key: CounterKey): number {
  return context.limits[key] + (context.limitBonus[key] ?? 0);
}

/**
 * [proposta] Reading of the limits: `plan_reviews`, `critic_rejections`, `script_*` and
 * `structural_restarts` are the number of returns allowed, so the loop is spent when the failure
 * that comes **exceeds** the limit (`economical` has 0 restarts: the first one already goes to
 * the Producer). `attempts_per_demand` is the number of tries, so it is spent when the failed
 * attempt **reaches** it (3 attempts: the 3rd failure ends it).
 */
export function exhaustedAfter(context: PlayContext, key: CounterKey, demandId?: string): boolean {
  const next = countOf(context, counterName(key, demandId)) + 1;
  return key === 'attempts_per_demand'
    ? next >= limitFor(context, key)
    : next > limitFor(context, key);
}

export function bumpCounter(context: PlayContext, name: string): Record<string, number> {
  return { ...context.counters, [name]: countOf(context, name) + 1 };
}

/** The demands of the script that have not passed `verify` yet. */
export function pendingDemands(context: PlayContext): string[] {
  return context.demandIds.filter((id) => !context.approvedDemands.includes(id));
}

/** The counters without the attempts of the given demands (they start over, 5.4). */
export function withoutAttempts(
  counters: Readonly<Record<string, number>>,
  demandIds: readonly string[],
): Record<string, number> {
  const drop = new Set(demandIds.map((id) => counterName('attempts_per_demand', id)));
  return Object.fromEntries(Object.entries(counters).filter(([name]) => !drop.has(name)));
}

/** The counters without every attempt counter of every demand. */
export function withoutAnyAttempts(
  counters: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counters).filter(([name]) => !name.startsWith('attempts_per_demand:')),
  );
}
