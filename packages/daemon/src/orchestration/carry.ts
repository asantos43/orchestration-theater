// SPDX-License-Identifier: MPL-2.0
import type { Demand, Script } from '@otheater/core';
import { z } from 'zod';
import type { RescriptReuseMode } from '../config.js';

/**
 * What a demand takes over from an earlier attempt (architecture 5.5, N82 and N84). [proposta]
 * The architecture says the new attempt gets "the old diff in the Actor's context" but not where
 * the daemon keeps the note: it is the blackboard key `carry:<demand>`, written when the
 * rebase of the demand conflicts or when a new script changes it, and read when the attempt
 * starts. It applies while the demand's newest finished attempt is still `fromAttempt`, so the
 * attempts that fail in between keep seeing it, and the first one that finishes ends it.
 */
export function carryKey(demandId: string): string {
  return `carry:${demandId}`;
}

export const CarrySchema = z.strictObject({
  /** The finished attempt whose work is carried. */
  fromAttempt: z.number().int().min(1),
  kind: z.enum(['rebase_conflict', 'rescript']),
  /** Its branch. */
  branch: z.string().min(1),
  /** The branch the diff is taken from (what the earlier attempt started on); null: the base. */
  oldBase: z.string().min(1).nullable(),
  /** The new attempt only resolves the conflict (`integration.rebase_conflict: resolve_attempt`). */
  resolve: z.boolean(),
  /** The new attempt starts on `branch` (`resolve_attempt`, `rescript.reuse: from_previous`). */
  startFromBranch: z.boolean(),
  /** With `resolve`: the branch to merge into the worktree. */
  mergeIn: z.string().min(1).nullable(),
  /** The conflicting files. */
  files: z.array(z.string()),
});
export type Carry = z.infer<typeof CarrySchema>;

/** The blackboard key with the number of the current build of the integration branch. */
export const INTEGRATION_ROUND_KEY = 'integration_round';

/** The two demands ask for the same work: same text, contract, files, edges and checks. */
export function sameWork(a: Demand, b: Demand): boolean {
  const shape = (demand: Demand): string =>
    JSON.stringify([
      demand.description,
      demand.contract.inputs,
      demand.contract.outputs,
      demand.expectedFiles,
      demand.dependsOn,
      demand.verify,
      demand.verifyWaiver ?? null,
    ]);
  return shape(a) === shape(b);
}

/**
 * The demands of a rewritten script whose approved work stays (N84, `keep_unchanged` and
 * `from_previous`): the Scriptwriter marked them `unchanged`, the old script has the same demand
 * (`sameWork`), it was approved, and so are all its dependencies (a demand on top of a changed
 * one is not the same work). `redo_all` keeps none.
 */
export function keptDemands(input: {
  readonly mode: RescriptReuseMode;
  readonly previous: Script | undefined;
  readonly next: Script;
  readonly approved: ReadonlySet<string>;
}): string[] {
  if (input.mode === 'redo_all' || input.previous === undefined) return [];
  const before = new Map(input.previous.demands.map((demand) => [demand.id, demand]));
  const kept = new Set<string>();
  for (const demand of input.next.demands) {
    const old = before.get(demand.id);
    if (demand.unchanged === true && old !== undefined && input.approved.has(demand.id)) {
      if (sameWork(old, demand)) kept.add(demand.id);
    }
  }
  // a kept demand needs every dependency kept: drop the others until nothing changes
  for (let changed = true; changed;) {
    changed = false;
    for (const demand of input.next.demands) {
      if (kept.has(demand.id) && demand.dependsOn.some((id) => !kept.has(id))) {
        kept.delete(demand.id);
        changed = true;
      }
    }
  }
  return input.next.demands.filter((demand) => kept.has(demand.id)).map((demand) => demand.id);
}
