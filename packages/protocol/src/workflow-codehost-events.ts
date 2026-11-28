// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the code host steps and of the approval (docs/24 §4 and §9; plan of
 * Phase 11b, P8). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict
 * objects. The scenario and the run (the `playId`) are in the envelope. The names of
 * `workflow.approval.requested` and `workflow.approval.resolved` are the plan's; the fields and the
 * other two events are [proposta].
 */

/** `workflow.approval.requested`: an `approval` node asked the Producer. */
export const WorkflowApprovalRequestedPayloadSchema = z.strictObject({
  node: z.string().min(1),
  /** Which visit of the node this is. */
  ordinal: z.int().min(1),
  /** The question the Producer sees (cut to 500 characters). */
  prompt: z.string().max(500),
});

export const WORKFLOW_APPROVAL_RESOLUTIONS = ['answered', 'timeout', 'cancelled'] as const;
export type WorkflowApprovalResolution = (typeof WORKFLOW_APPROVAL_RESOLUTIONS)[number];

/** `workflow.approval.resolved`: the question got its end, and what the step takes from it. */
export const WorkflowApprovalResolvedPayloadSchema = z.strictObject({
  node: z.string().min(1),
  ordinal: z.int().min(1),
  /** Whether the Producer said yes. A deadline and a withdrawn question are never a yes. */
  approved: z.boolean(),
  /** `answered` by the Producer, `timeout` (the deadline passed) or `cancelled` (the question was withdrawn). */
  by: z.enum(WORKFLOW_APPROVAL_RESOLUTIONS),
});

export const WORKFLOW_WRITE_REFUSALS = ['approval_missing'] as const;
export type WorkflowWriteRefusal = (typeof WORKFLOW_WRITE_REFUSALS)[number];

/**
 * `workflow.write.refused`: a step that writes in public (`comment`, `label`) did not write because
 * `workflows.security.require_approval` asks for an approval and the run has none. The validator
 * of P1 already refuses such a definition, so this is the second line: a definition that got past
 * it, or one validated under another setting.
 */
export const WorkflowWriteRefusedPayloadSchema = z.strictObject({
  node: z.string().min(1),
  step: z.string().min(1),
  /** The public write that asked for the approval: `push`, `comment` or `label`. */
  write: z.enum(['push', 'comment', 'label']),
  reason: z.enum(WORKFLOW_WRITE_REFUSALS),
});

/**
 * `workflow.untrusted.truncated`: the external text of a step (issue, pull request, comment, CI log)
 * was cut to `workflows.security.untrusted_max_chars` before it went to a prompt.
 */
export const WorkflowUntrustedTruncatedPayloadSchema = z.strictObject({
  node: z.string().min(1),
  step: z.string().min(1),
  /** Where the text came from: `issue`, `pull_request` or `ci_log`. */
  source: z.enum(['issue', 'pull_request', 'ci_log']),
  chars: z.int().min(0),
  kept: z.int().min(0),
});
