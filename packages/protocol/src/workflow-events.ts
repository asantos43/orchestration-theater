// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the workflow engine at run time (docs/24 §6; plan of Phase 11b, P2).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects. The
 * scenario and the run (which is a record of `plays`, so the run id is the `playId`) are in the
 * envelope. [proposta] The names of the fields and the types `workflow.run.refused` and
 * `workflow.notified`; the other four are the names the plan fixes.
 */

/** What the snapshot of a run keeps of the definition it runs (docs/24 §6): `{id, version, hash}`. */
export const WorkflowRefSchema = z.strictObject({
  id: z.string().min(1),
  /** The semver of the definition. */
  version: z.string().min(1),
  /** `sha256:<hex>` of the canonical definition (`workflowHash`). */
  hash: z.string().min(1),
});
export type WorkflowRef = z.infer<typeof WorkflowRefSchema>;

/** `workflow.run.started`: a run was created and its first node is the one in `start`. */
export const WorkflowRunStartedPayloadSchema = z.strictObject({
  workflow: WorkflowRefSchema,
  start: z.string().min(1),
  /** The names of the inputs the run was given (the values are not in the event). */
  inputs: z.array(z.string()),
});

/** `workflow.step.started`: the work of a node began (or began again, after a restart). */
export const WorkflowStepStartedPayloadSchema = z.strictObject({
  node: z.string().min(1),
  step: z.string().min(1),
  /** Which visit of the node this is (1 on the first; a loop makes it grow). */
  ordinal: z.int().min(1),
  /** The idempotency key of the node's effect: `<run>:<node>:<ordinal>`. */
  key: z.string().min(1),
  /** True when the daemon restarted with the node in flight and the work starts again. */
  resumed: z.boolean(),
});

export const WORKFLOW_STEP_OUTCOMES = ['done', 'failed', 'cancelled'] as const;
export type WorkflowStepOutcome = (typeof WORKFLOW_STEP_OUTCOMES)[number];

/** `workflow.step.finished`: the work of a node ended and the machine took its transition. */
export const WorkflowStepFinishedPayloadSchema = z.strictObject({
  node: z.string().min(1),
  step: z.string().min(1),
  ordinal: z.int().min(1),
  outcome: z.enum(WORKFLOW_STEP_OUTCOMES),
  /** The node the machine moved to; `null` when it went to a terminal state. */
  next: z.string().nullable(),
  /** The state the machine moved to: the node, or `done`, `cancelled` or `failed`. */
  to: z.string().min(1),
  /** Why the step failed or was cancelled. */
  reason: z.string().min(1).optional(),
  /** For a step with a side effect: how the journal answered (architecture 5.21). */
  effect: z.enum(['executed', 'replayed', 'verified']).optional(),
});

export const WORKFLOW_RUN_OUTCOMES = ['done', 'cancelled', 'failed'] as const;
export type WorkflowRunOutcome = (typeof WORKFLOW_RUN_OUTCOMES)[number];

/** `workflow.run.finished`: the run reached a terminal state. */
export const WorkflowRunFinishedPayloadSchema = z.strictObject({
  outcome: z.enum(WORKFLOW_RUN_OUTCOMES),
  reason: z.string().min(1).optional(),
  /** How many nodes the run went through (its steps, each visit of a loop counted). */
  steps: z.int().min(0),
});

export const WORKFLOW_RUN_REFUSALS = [
  'definition_missing',
  'hash_mismatch',
  'invalid_definition',
  'unknown_step_type',
  'invalid_inputs',
  'snapshot_unreadable',
] as const;
export type WorkflowRunRefusal = (typeof WORKFLOW_RUN_REFUSALS)[number];

/**
 * `workflow.run.refused`: a run was not started, or a saved run was not resumed, because the
 * definition it needs is missing, changed (another hash) or cannot run here. The saved run is not
 * touched. [proposta] (the plan names `workflow.snapshot_rejected` for the migration of P3/P4).
 */
export const WorkflowRunRefusedPayloadSchema = z.strictObject({
  workflow: WorkflowRefSchema.partial({ hash: true }),
  reason: z.enum(WORKFLOW_RUN_REFUSALS),
  detail: z.string(),
});

/**
 * `workflow.notified`: a `notify` step spoke. It is the channel the chat and the plugins read from
 * the log (a plugin hears it as it hears any event). [proposta]
 */
export const WorkflowNotifiedPayloadSchema = z.strictObject({
  node: z.string().min(1),
  message: z.string().min(1),
});

/** The type names of the events above, for the code that reads the log by type. */
export const WORKFLOW_NOTIFIED_EVENT = 'workflow.notified';
