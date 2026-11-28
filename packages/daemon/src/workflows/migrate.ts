// SPDX-License-Identifier: MPL-2.0
import type { Store } from '@otheater/core';
import {
  WORKFLOW_MIGRATION_TRIGGERS,
  type WorkflowMigrationRefusal,
  type WorkflowMigrationTrigger,
} from '@otheater/protocol';
import type { ValidWorkflow } from '@otheater/workflows';
import { z } from 'zod';

/**
 * The rules of the migration of a run to a new version of its workflow (N295; plan of Phase 11b,
 * P4). They are pure functions and a query of the journal; the runtime (`runtime.ts`) uses them and
 * writes the result.
 *
 * - A run is born in a version and stays there (`workflows.running_on_change: pin`, the default).
 * - A migration is asked (by the Producer, or by the activation of a version when
 *   `migrate_at_safe_point` is on) and waits for a SAFE POINT: between two steps (nothing in
 *   flight), with no effect of the run pending or ambiguous in the journal, in a node whose step
 *   type is a safe point (`CompiledNode.safePoint`). [proposta] That last condition is the
 *   conservative reading: the node the run is about to enter must itself accept a stop.
 * - The new definition says where each node goes (`migrate_from`, checked by the compiler against
 *   its own nodes; here, against the old definition). Without a mapping for the version the run is
 *   in, or for the node it is in at the safe point, the migration is refused, with an event.
 * - The counters of the limited edges are carried over by key; one the new version does not have is
 *   dropped (and named in the event). The inputs must fit the new definition as they are. [proposta]
 */

/** A migration asked and not made yet; it is part of the saved state of the run, so a restart keeps it. */
export const MigrationRequestSchema = z.strictObject({
  /** The version to move to; the library has it. */
  toVersion: z.string().min(1),
  trigger: z.enum(WORKFLOW_MIGRATION_TRIGGERS),
});
export type MigrationRequest = z.infer<typeof MigrationRequestSchema>;

export type MigrationCheck<T> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly reason: WorkflowMigrationRefusal;
      readonly detail: string;
    };

/**
 * The map `old node -> new node` that `to` declares for the version `from` is in. The state of the
 * run is not looked at here (it changes until the safe point): only that the map exists and that
 * both of its sides name real nodes. A map whose source is not a node of the old definition is a
 * mistake of the author, so it is refused rather than half-used.
 */
export function mappingOf(
  from: ValidWorkflow,
  to: ValidWorkflow,
): MigrationCheck<{ readonly map: Readonly<Record<string, string>> }> {
  const map = to.definition.migrate_from?.[from.version];
  if (map === undefined) {
    return {
      ok: false,
      reason: 'no_mapping',
      detail: `${to.id}@${to.version} has no mapping from ${from.version}`,
    };
  }
  for (const [source, target] of Object.entries(map)) {
    if (!Object.hasOwn(from.nodes, source)) {
      return {
        ok: false,
        reason: 'mapping_invalid',
        detail: `${source} is not a node of ${from.id}@${from.version}`,
      };
    }
    if (!Object.hasOwn(to.nodes, target)) {
      return {
        ok: false,
        reason: 'mapping_invalid',
        detail: `${target} is not a node of ${to.id}@${to.version}`,
      };
    }
  }
  return { ok: true, map };
}

/** Where a run in `state` goes; `state_unmapped` when the map does not say. */
export function mapState(
  map: Readonly<Record<string, string>>,
  state: string,
): MigrationCheck<{ readonly toState: string }> {
  const toState = Object.hasOwn(map, state) ? map[state] : undefined;
  return toState === undefined
    ? { ok: false, reason: 'state_unmapped', detail: `the mapping does not name ${state}` }
    : { ok: true, toState };
}

/** The counters of the limited edges the new version still has, and the keys it dropped. */
export function carryCounts(
  counts: Readonly<Record<string, number>>,
  to: ValidWorkflow,
): { readonly counts: Record<string, number>; readonly dropped: string[] } {
  const kept: Record<string, number> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(counts)) {
    if (Object.hasOwn(to.counters, key)) kept[key] = value;
    else dropped.push(key);
  }
  return { counts: kept, dropped: dropped.sort() };
}

/** Whether the node a run is about to enter accepts a migration before it (`CompiledNode.safePoint`). */
export function isSafeNode(workflow: ValidWorkflow, state: string): boolean {
  return workflow.nodes[state]?.safePoint === true;
}

/**
 * Whether an effect of this run is still open in the journal (`pending`: the intention was written
 * and the end was not; `ambiguous`: a restart could not tell). The keys of a run start with
 * `<runId>:` (`runtime.ts`), the same prefix the `approval` step extends.
 */
export async function hasOpenEffects(
  store: Pick<Store, 'sideEffects'>,
  runId: string,
): Promise<boolean> {
  const open = await store.sideEffects.list({ states: ['pending', 'ambiguous'] });
  return open.some((effect) => effect.idempotencyKey.startsWith(`${runId}:`));
}

export type { WorkflowMigrationRefusal, WorkflowMigrationTrigger };
