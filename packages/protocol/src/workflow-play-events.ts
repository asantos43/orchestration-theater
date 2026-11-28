// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * `workflow.play.cancelled` (plan of Phase 11b, P10c): a run was cancelled while a `run_play` node
 * had opened a play, so the runtime asked the play to cancel too. The run is in the envelope
 * (`playId` is the run's id there; the play the step opened is `play` here). [proposta] The names
 * of the fields and of the outcomes.
 *
 * - `cancelled`: the play was asked to cancel and its machine took the cancel;
 * - `already_final`: the play had ended before (nothing to cancel);
 * - `failed`: the cancel could not be sent or the play refused it; the play keeps running and is
 *   the Producer's, in the chat. `detail` says why.
 */
export const WORKFLOW_PLAY_CANCEL_OUTCOMES = ['cancelled', 'already_final', 'failed'] as const;
export type WorkflowPlayCancelOutcome = (typeof WORKFLOW_PLAY_CANCEL_OUTCOMES)[number];

export const WorkflowPlayCancelledPayloadSchema = z.strictObject({
  runId: z.string().min(1),
  /** The `run_play` node that opened the play. */
  node: z.string().min(1),
  /** The play the step opened. */
  play: z.string().min(1),
  outcome: z.enum(WORKFLOW_PLAY_CANCEL_OUTCOMES),
  detail: z.string().max(500).optional(),
});
