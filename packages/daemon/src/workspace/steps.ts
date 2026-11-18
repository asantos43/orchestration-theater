// SPDX-License-Identifier: MPL-2.0
import type { SideEffectRecord } from '@otheater/core';

/** The records of one step of an attempt: the key `<base>:<n>` and its retries `<base>:<n>~k`. */
export interface Step {
  readonly step: number;
  readonly records: readonly SideEffectRecord[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The records of an attempt, grouped by the step of their key, in order. */
export function stepsOf(records: readonly SideEffectRecord[], base: string): Step[] {
  const pattern = new RegExp(`^${escapeRegExp(base)}:(\\d+)(?:~\\d+)?$`);
  const byStep = new Map<number, SideEffectRecord[]>();
  for (const record of records) {
    const match = pattern.exec(record.idempotencyKey);
    if (match === null) continue;
    const step = Number(match[1]);
    byStep.set(step, [...(byStep.get(step) ?? []), record]);
  }
  return [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, list]) => ({ step, records: list }));
}

function callHashOf(record: SideEffectRecord): string | undefined {
  const value = record.params?.callHash;
  return typeof value === 'string' ? value : undefined;
}

/** A step with a run that never ended (`pending`) or could not be told (`ambiguous`), and none that did. */
function isOpen(step: Step): boolean {
  return (
    !step.records.some((record) => record.state === 'done') &&
    step.records.some((record) => record.state === 'pending' || record.state === 'ambiguous')
  );
}

/**
 * The step of this call. The same call (`hash`) asked again while an earlier run of it is still
 * open (the daemon stopped in the middle of it, or its reply was lost) is the same step, so the
 * verifier is asked what happened. Anything else is a new step: an agent that clicks the same
 * button twice on purpose clicks it twice.
 */
export function stepFor(
  steps: readonly Step[],
  hash: string,
  /** A step a call of this process is running right now: it is not an interrupted one. */
  busy: (step: number) => boolean = () => false,
): number {
  const open = steps.find(
    (step) =>
      isOpen(step) &&
      !busy(step.step) &&
      step.records.some((record) => callHashOf(record) === hash),
  );
  if (open !== undefined) return open.step;
  return (steps[steps.length - 1]?.step ?? 0) + 1;
}

/** The hash a step record carries (`params.callHash`), if it has one. */
export function callHashOfStep(step: Step): string | undefined {
  for (const record of step.records) {
    const hash = callHashOf(record);
    if (hash !== undefined) return hash;
  }
  return undefined;
}

/** The result of the run that finished the step (`done`), if one did. */
export function doneRecordOf(step: Step): SideEffectRecord | undefined {
  return step.records.find((record) => record.state === 'done');
}
