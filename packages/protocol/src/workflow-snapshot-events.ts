// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * `workflow.snapshot_rejected` (plan of Phase 11b, P3, decision D2/N311): a play saved by version 1
 * of the hand-written machine was found open when the daemon started. There is no migration of 1.x:
 * `workflows.legacy_snapshot` says what happens to it. `reject` leaves the record untouched and
 * says so in the chat; `cancel` cancels the play and records it. The scenario and the play are in
 * the envelope. [proposta] The names of the fields; the plan fixes only the event type.
 */
export const WORKFLOW_LEGACY_SNAPSHOT_MODES = ['reject', 'cancel'] as const;
export type WorkflowLegacySnapshotMode = (typeof WORKFLOW_LEGACY_SNAPSHOT_MODES)[number];

export const WorkflowSnapshotRejectedPayloadSchema = z.strictObject({
  /** The id of the flow the record names (`play`). */
  flowId: z.string().min(1),
  /** The version the record was saved by (a number, 1 for the hand-written machine). */
  savedVersion: z.int().min(1),
  /** The version this daemon runs. */
  currentVersion: z.int().min(1),
  /** What `workflows.legacy_snapshot` did with the play. */
  mode: z.enum(WORKFLOW_LEGACY_SNAPSHOT_MODES),
});
