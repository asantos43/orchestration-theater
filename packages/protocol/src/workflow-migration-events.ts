// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The events of the migration of a run to a new version of its workflow (N295; plan of Phase 11b,
 * P4). A run is born in a version and stays there; a migration moves it to another version only at
 * a safe point (between steps, with no effect pending) and only when the new definition maps the
 * node the run is in. [proposta] The names of the fields and of the refusal reasons; the plan fixes
 * only the two types.
 */

/** What asked for the migration: the Producer (or the Director) or the activation of a version. */
export const WORKFLOW_MIGRATION_TRIGGERS = ['request', 'activation'] as const;
export type WorkflowMigrationTrigger = (typeof WORKFLOW_MIGRATION_TRIGGERS)[number];

/**
 * Why a migration was not made:
 * - `no_mapping`: the new definition has no `migrate_from` for the version the run is in;
 * - `state_unmapped`: the mapping does not name the node the run is in;
 * - `mapping_invalid`: the mapping names a node the old definition does not have;
 * - `definition_missing`: the old or the new definition is not in the library;
 * - `target_invalid`: the new definition is not valid any more (the library changed);
 * - `inputs_incompatible`: the inputs of the run do not fit the inputs of the new definition;
 * - `not_newer`: the new version is not newer than the one the run is in;
 * - `run_finished`: the run is finished, or is not a run of the generic engine.
 */
export const WORKFLOW_MIGRATION_REFUSALS = [
  'no_mapping',
  'state_unmapped',
  'mapping_invalid',
  'definition_missing',
  'target_invalid',
  'inputs_incompatible',
  'not_newer',
  'run_finished',
] as const;
export type WorkflowMigrationRefusal = (typeof WORKFLOW_MIGRATION_REFUSALS)[number];

const WorkflowRefSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
});

/** `workflow.migrated`: the run is now in another version, at the node the mapping gave. */
export const WorkflowMigratedPayloadSchema = z.strictObject({
  runId: z.string().min(1),
  from: WorkflowRefSchema,
  to: WorkflowRefSchema,
  /** The node the run was in, and the node it is in now. */
  fromState: z.string().min(1),
  toState: z.string().min(1),
  trigger: z.enum(WORKFLOW_MIGRATION_TRIGGERS),
  /** The limit counters of the old version that the new one does not have (dropped). */
  droppedLimits: z.array(z.string().min(1)),
});

/** `workflow.migration_refused`: the migration was asked and cannot be made; the run is untouched. */
export const WorkflowMigrationRefusedPayloadSchema = z.strictObject({
  runId: z.string().min(1),
  from: WorkflowRefSchema,
  /** The version asked for. */
  toVersion: z.string().min(1),
  trigger: z.enum(WORKFLOW_MIGRATION_TRIGGERS),
  reason: z.enum(WORKFLOW_MIGRATION_REFUSALS),
  detail: z.string().max(500).optional(),
});
