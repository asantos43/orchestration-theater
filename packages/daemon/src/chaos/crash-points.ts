// SPDX-License-Identifier: MPL-2.0
import { writeSync } from 'node:fs';
import { faultError, type CrashRule, type FailRule, type FaultPlan } from './faults.js';

/**
 * The named points where the daemon can be killed or made to fail on purpose (Phase 11, P1;
 * docs/23). Every point is one `await crashPoint('<area>.<place>', '<detail>')` in the code of the
 * daemon. It costs one comparison while no plan is armed, and `faults.inject: off` (the default,
 * and the only value in the release build) never arms one.
 *
 * The catalogue below is the list the chaos tests draw from (a seeded pick of a point), and the
 * test of each point lives next to the code it sits in. A new point is added here and gets a test
 * that triggers it.
 */
export const CRASH_POINTS = {
  /** The boundaries of `runEffect` (architecture 5.21: intend, execute, resolve). `detail` is the effect type. */
  effects: [
    'effects.before_intend',
    'effects.after_intend',
    'effects.after_execute',
    'effects.after_resolve',
    'effects.after_verify',
  ],
  /** The steps of the reconciliation at start-up. `detail` is the effect type, for the per-effect point. */
  reconcile: [
    'reconcile.before_orphans',
    'reconcile.after_orphans',
    'reconcile.before_worktrees',
    'reconcile.after_worktrees',
    'reconcile.before_effects',
    'reconcile.before_effect_resolve',
    'reconcile.after_effects',
  ],
  /** The commit of a store transaction: the body has run and the commit has not, or the commit is done. */
  store: ['store.before_commit', 'store.after_commit'],
} as const;

export type CrashPointName =
  | (typeof CRASH_POINTS.effects)[number]
  | (typeof CRASH_POINTS.reconcile)[number]
  | (typeof CRASH_POINTS.store)[number];

/** Every point of the catalogue, in a stable order. */
export const CRASH_POINT_NAMES: readonly CrashPointName[] = [
  ...CRASH_POINTS.effects,
  ...CRASH_POINTS.reconcile,
  ...CRASH_POINTS.store,
];

/** The line a killed daemon writes to its stdout, followed by the JSON of {@link CrashInfo}. */
export const CRASHPOINT_LINE = 'CRASHPOINT ';

export interface CrashInfo {
  readonly point: string;
  readonly detail?: string | undefined;
  /** How many matching hits there were, this one included. */
  readonly hit: number;
  /** What the describer added (the harness asks for the pids of the clients). */
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/** What happens when a crash rule fires. Default: write {@link CRASHPOINT_LINE} and `SIGKILL` itself. */
export type CrashAction = (info: CrashInfo) => Promise<void> | void;

/** Adds data to the crash line (the harness uses it to list the client pids before the kill). */
export type CrashDescriber = () => Promise<Readonly<Record<string, unknown>>>;

export interface ArmOptions {
  /** Test seam: replaces the kill. If it returns, the code of the point goes on. */
  readonly onCrash?: CrashAction | undefined;
}

interface Armed {
  readonly plan: FaultPlan;
  readonly onCrash: CrashAction | undefined;
  readonly crashHits: number[];
  readonly failHits: number[];
}

let armed: Armed | undefined;
let describer: CrashDescriber | undefined;

/**
 * Arms the plan for this process. An empty plan disarms (so the next daemon of a test that started
 * with `off` is never left with the plan of the one before). Called by `startDaemon` after it read
 * `faults.inject`; the plan is global to the process, like the process it can kill.
 */
export function armFaults(plan: FaultPlan, options: ArmOptions = {}): void {
  if (plan.crash.length === 0 && plan.fail.length === 0) {
    armed = undefined;
    return;
  }
  armed = {
    plan,
    onCrash: options.onCrash,
    crashHits: plan.crash.map(() => 0),
    failHits: plan.fail.map(() => 0),
  };
}

/** Clears the plan and the describer (the stop of a daemon, and the tests). */
export function disarmFaults(): void {
  armed = undefined;
  describer = undefined;
}

/** Whether any rule is armed. The composition passes the store hooks only if it is. */
export function faultsArmed(): boolean {
  return armed !== undefined;
}

export function setCrashDescriber(next: CrashDescriber | undefined): void {
  describer = next;
}

function matches(rule: CrashRule | FailRule, point: string, detail: string | undefined): boolean {
  return rule.point === point && (rule.detail === undefined || rule.detail === detail);
}

/**
 * A point where the daemon can be killed. With nothing armed it returns at once. When an armed
 * rule matches it and this is its `nth` hit, the process writes the crash line and ends itself
 * with `SIGKILL`: it never answers, and the code after the point does not run.
 */
export async function crashPoint(point: string, detail?: string): Promise<void> {
  const current = armed;
  if (current === undefined) return;
  const rules = current.plan.crash;
  for (const [index, rule] of rules.entries()) {
    if (!matches(rule, point, detail)) continue;
    const hit = (current.crashHits[index] ?? 0) + 1;
    current.crashHits[index] = hit;
    if (hit !== rule.nth) continue;
    await crash(current.onCrash, { point, detail, hit });
    return;
  }
}

async function crash(action: CrashAction | undefined, info: CrashInfo): Promise<void> {
  if (action !== undefined) {
    await action(info);
    return;
  }
  const extra = await describeSafely();
  const line = `${CRASHPOINT_LINE}${JSON.stringify({ ...info, ...extra })}\n`;
  try {
    writeSync(1, line);
  } catch {
    // The kill matters more than the line: the harness also reads the state from the files.
  }
  process.kill(process.pid, 'SIGKILL');
  // The signal is delivered by the system; nothing after the point may run in the meantime.
  await new Promise<never>(() => undefined);
}

/** The describer may not hold the kill back: it has two seconds, and its failure is ignored. */
async function describeSafely(): Promise<Readonly<Record<string, unknown>>> {
  const current = describer;
  if (current === undefined) return {};
  const limit = new Promise<Record<string, unknown>>((resolve) => {
    setTimeout(() => {
      resolve({});
    }, 2000).unref();
  });
  try {
    return await Promise.race([current(), limit]);
  } catch {
    return {};
  }
}

/**
 * A point where a system call can fail on purpose (`failPoint('fs.write', 'log')` throws an error
 * with the code of a full disk, for example). With nothing armed it does nothing.
 */
export function failPoint(point: string, detail?: string): void {
  const current = armed;
  if (current === undefined) return;
  for (const [index, rule] of current.plan.fail.entries()) {
    if (!matches(rule, point, detail)) continue;
    const hit = (current.failHits[index] ?? 0) + 1;
    current.failHits[index] = hit;
    const last = rule.times === 0 ? Number.POSITIVE_INFINITY : rule.nth + rule.times - 1;
    if (hit >= rule.nth && hit <= last) {
      throw faultError(rule.code, detail === undefined ? point : `${point}:${detail}`);
    }
  }
}

/**
 * The hooks the SQLite store calls around the commit of each transaction. `undefined` when nothing
 * is armed, so a daemon with `faults.inject: off` hands the store nothing at all.
 */
export function storeCommitHooks():
  | {
      readonly beforeCommit: () => Promise<void>;
      readonly afterCommit: () => Promise<void>;
    }
  | undefined {
  if (armed === undefined) return undefined;
  return {
    beforeCommit: () => crashPoint('store.before_commit'),
    afterCommit: () => crashPoint('store.after_commit'),
  };
}
