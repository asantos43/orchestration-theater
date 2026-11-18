// SPDX-License-Identifier: MPL-2.0
import type {
  SideEffectRecord,
  SideEffectRegistry,
  SideEffectState,
  SideEffectVerifier,
} from '@otheater/core';

/** One effect of an attempt, as the continuation package (P18) and a notice show it. */
export interface AttemptEffect {
  readonly key: string;
  readonly type: string;
  readonly target: string;
  readonly state: SideEffectState;
  /** The step of the key (`<base>:<n>` or `<base>:<n>~k`), when the key has that shape. */
  readonly step: number | undefined;
  /** Who settled it, when a verifier or the Producer did. */
  readonly verifier: SideEffectVerifier | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

const STEP_OF_KEY = /:(\d+)(?:~\d+)?$/;

function summaryOf(record: SideEffectRecord): AttemptEffect {
  const match = STEP_OF_KEY.exec(record.idempotencyKey);
  return {
    key: record.idempotencyKey,
    type: record.type,
    target: record.target,
    state: record.state,
    step: match === null ? undefined : Number(match[1]),
    verifier: record.verifier,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
  };
}

/**
 * The effects of an attempt that were executed (`done`), oldest first: what a resumed run must not
 * do again (architecture 5.16). A `failed`, `not_done` or open record is not here: nothing came of
 * it, or nobody knows yet (`openEffectsOf`). `types` narrows the list to some kinds of effect.
 */
export async function effectsOf(
  registry: SideEffectRegistry,
  attemptId: string,
  types?: readonly string[],
): Promise<readonly AttemptEffect[]> {
  const records = await registry.list({
    attemptId,
    states: ['done'],
    ...(types === undefined ? {} : { types }),
  });
  return records.map(summaryOf);
}

/**
 * The effects of an attempt that have a "before" and no "after" (`pending` or `ambiguous`): the
 * ones that were started and nobody can say yet whether they finished. The continuation package
 * lists them apart from the executed ones.
 */
export async function openEffectsOf(
  registry: SideEffectRegistry,
  attemptId: string,
): Promise<readonly AttemptEffect[]> {
  const records = await registry.list({ attemptId, states: ['pending', 'ambiguous'] });
  return records.map(summaryOf);
}
