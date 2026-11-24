// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  type JsonObject,
  type NewSideEffect,
  type SideEffectRecord,
  type SideEffectRegistry,
} from '@otheater/core';
import { crashPoint } from '../chaos/crash-points.js';

/**
 * What a verifier concludes about an effect that has an "intent" and no "after" (architecture
 * 5.21): it happened (`done`, with the result a replay returns), it did not (`not_done`), or the
 * tool cannot tell right now (`ambiguous`).
 */
export type EffectVerdict =
  | { readonly verdict: 'done'; readonly result: JsonObject }
  | { readonly verdict: 'not_done' }
  | { readonly verdict: 'ambiguous'; readonly reason: string };

export interface EffectSpec {
  /** Base idempotency key. A retry after `not_done` or `failed` uses `<key>~2`, `<key>~3`... */
  readonly key: string;
  readonly type: string;
  readonly target: string;
  readonly params: JsonObject;
  readonly attemptId?: string;
  /** Does the effect, once. `key` is the effective key (what a commit trailer must carry). */
  execute(key: string): Promise<JsonObject>;
  /** Looks at the world and says whether the effect of `record` happened. */
  verify(record: SideEffectRecord): Promise<EffectVerdict>;
}

/**
 * How the outcome was reached:
 * - `executed`: the effect ran now;
 * - `replayed`: an earlier run had finished it, and its result is returned without running again;
 * - `verified`: an earlier run left it open, and the verifier found it done.
 */
export type EffectOrigin = 'executed' | 'replayed' | 'verified';

export type EffectOutcome =
  | {
      readonly kind: 'done';
      readonly key: string;
      readonly result: JsonObject;
      readonly origin: EffectOrigin;
    }
  /** The verifier could not tell: the record stays `ambiguous`, for the Producer or a later run. */
  | { readonly kind: 'ambiguous'; readonly key: string; readonly reason: string };

/**
 * What `execute` throws when the effect ran and the tool reported a failure that has a result
 * worth keeping (a command that exited with an error, with its output). The record is resolved
 * `failed` WITH that result, and the error is rethrown: the caller catches it and answers with the
 * result. A `failed` step is never replayed; the next run takes a new key.
 */
export class EffectFailed extends Error {
  constructor(
    message: string,
    readonly result: JsonObject,
  ) {
    super(message);
    this.name = 'EffectFailed';
  }
}

/** How many keys (`key`, `key~2`...) a step may go through before it is given up. [proposta] */
export const MAX_EFFECT_ATTEMPTS = 20;

/** The effective key of the `n`th (1-based) run of a step. */
export function effectKey(key: string, n: number): string {
  return n === 1 ? key : `${key}~${String(n)}`;
}

/**
 * Runs one side effect under the protocol of architecture 5.21: `intend` (the "before"), the
 * effect, then `resolve` (the "after"). Called again for the same step it never repeats a finished
 * effect:
 *
 * - no record: `intend`, `execute`, `resolve(done)`. An error resolves it `failed` and is rethrown;
 * - `done`: the recorded result is returned;
 * - `pending` or `ambiguous` (a crash, or a verifier that could not tell): the verifier decides.
 *   `done` settles the record with `verifier: 'verifier'`; `not_done` settles it and the step
 *   goes on to the next key; `ambiguous` keeps the record and returns `ambiguous`;
 * - `failed` or `not_done`: a new key for a new run.
 *
 * [proposta] A verifier that throws counts as `ambiguous`: the effect is never assumed missing.
 *
 * The chaos points of Phase 11 (`effects.*`, with the effect type as detail) sit on the three
 * boundaries: before `intend`, between `intend` and `execute` (`after_intend`), between `execute` and
 * `resolve` (`after_execute`), after `resolve`, and between a verdict `done` and its `resolve`
 * (`after_verify`). They do nothing unless `faults.inject` armed a plan.
 */
export function runEffect(registry: SideEffectRegistry, spec: EffectSpec): Promise<EffectOutcome> {
  let running = inFlight.get(registry);
  if (running === undefined) {
    running = new Map();
    inFlight.set(registry, running);
  }
  const active = running.get(spec.key);
  if (active !== undefined) {
    // A second caller for the same step (two resumes at once) waits for the first one and gets what
    // it settled; for it the effect was not run now.
    return active.then((outcome) =>
      outcome.kind === 'done' ? { ...outcome, origin: 'replayed' } : outcome,
    );
  }
  const map = running;
  const run = runEffectOnce(registry, spec).finally(() => {
    map.delete(spec.key);
  });
  map.set(spec.key, run);
  return run;
}

/**
 * The steps that are running in this process, per registry. It keeps two resumes at once from both
 * reading "no record" and both running the effect; across processes the `intend` of the registry
 * is what refuses the second (`Conflict`).
 */
const inFlight = new WeakMap<SideEffectRegistry, Map<string, Promise<EffectOutcome>>>();

async function runEffectOnce(
  registry: SideEffectRegistry,
  spec: EffectSpec,
): Promise<EffectOutcome> {
  for (let n = 1; n <= MAX_EFFECT_ATTEMPTS; n += 1) {
    const key = effectKey(spec.key, n);
    const record = await registry.get(key);
    if (record === undefined) return intendAndExecute(registry, spec, key);
    if (record.state === 'done') {
      return { kind: 'done', key, result: record.result ?? {}, origin: 'replayed' };
    }
    if (record.state === 'pending' || record.state === 'ambiguous') {
      const verdict = await verifySafely(spec, record);
      if (verdict.verdict === 'done') {
        await crashPoint('effects.after_verify', spec.type);
        await registry.resolve(key, {
          state: 'done',
          result: verdict.result,
          verifier: 'verifier',
        });
        return { kind: 'done', key, result: verdict.result, origin: 'verified' };
      }
      if (verdict.verdict === 'ambiguous') {
        if (record.state === 'pending') {
          await registry.resolve(key, { state: 'ambiguous', verifier: null });
        }
        return { kind: 'ambiguous', key, reason: verdict.reason };
      }
      await registry.resolve(key, { state: 'not_done', verifier: 'verifier' });
    }
    // `failed` and `not_done`: the next key.
  }
  throw new Conflict(
    `The side effect ${spec.type} on ${spec.target} has no free key after ${String(MAX_EFFECT_ATTEMPTS)} runs`,
  );
}

async function intendAndExecute(
  registry: SideEffectRegistry,
  spec: EffectSpec,
  key: string,
): Promise<EffectOutcome> {
  const input: NewSideEffect = {
    idempotencyKey: key,
    type: spec.type,
    target: spec.target,
    params: spec.params,
    ...(spec.attemptId === undefined ? {} : { attemptId: spec.attemptId }),
  };
  await crashPoint('effects.before_intend', spec.type);
  await registry.intend(input);
  await crashPoint('effects.after_intend', spec.type);
  let result: JsonObject;
  try {
    result = await spec.execute(key);
  } catch (error) {
    // The tool reported an error, so the record says so; a failure to write it must not hide the
    // original error.
    try {
      await registry.resolve(key, {
        state: 'failed',
        ...(error instanceof EffectFailed ? { result: error.result } : {}),
      });
    } catch {
      // The record stays `pending`; the verifier settles it on the next run.
    }
    throw error;
  }
  await crashPoint('effects.after_execute', spec.type);
  await registry.resolve(key, { state: 'done', result });
  await crashPoint('effects.after_resolve', spec.type);
  return { kind: 'done', key, result, origin: 'executed' };
}

async function verifySafely(spec: EffectSpec, record: SideEffectRecord): Promise<EffectVerdict> {
  try {
    return await spec.verify(record);
  } catch (error) {
    return {
      verdict: 'ambiguous',
      reason: `The verifier failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
