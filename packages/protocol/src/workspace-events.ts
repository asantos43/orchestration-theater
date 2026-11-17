// SPDX-License-Identifier: MPL-2.0
import { DELIVERY_MODES } from '@otheater/core';
import { z } from 'zod';

/**
 * Payloads of the workspace and delivery events (architecture 5.5). They are registered in
 * `DAEMON_EVENT_TYPES` (events.ts) at `schemaVersion` 1. Every payload is a strict object, and
 * carries `playId` like the session events do (N54). [proposta] The fields below.
 */

const id = z.string().min(1).max(256);
const sha = z.string().min(7).max(64);

/** One approved attempt that went into the integration branch. */
const IntegratedAttemptSchema = z.strictObject({
  demandId: id,
  attempt: z.int().min(1),
  branch: z.string().min(1),
  /** Head of the attempt branch that was merged. */
  sha,
});

/** `workspace.integrated`: every approved attempt is in `play/<id>/integration`. */
export const WorkspaceIntegratedPayloadSchema = z.strictObject({
  playId: id,
  /** The integration branch (`play/<id>/integration`). */
  branch: z.string().min(1),
  /** Head of the integration branch after the last merge. */
  head: sha,
  /** In the order they were merged (topological). */
  merged: z.array(IntegratedAttemptSchema),
});

/**
 * `workspace.integration_failed`: a merge conflicted. In the architecture (5.4, 5.5) a conflict
 * is a script failure; the Director consumes it as such.
 */
export const WorkspaceIntegrationFailedPayloadSchema = z.strictObject({
  playId: id,
  branch: z.string().min(1),
  cause: z.literal('merge_conflict'),
  /** The attempt whose merge conflicted. */
  demandId: id,
  attempt: z.int().min(1),
  conflictFiles: z.array(z.string().min(1)),
  /** Demands already merged before the conflict, in order. */
  mergedSoFar: z.array(id),
});

/** Who asked for the delivery mode that was used (architecture 5.5: "quem o pediu"). */
export const DELIVERY_REQUESTERS = ['config', 'project', 'play', 'task', 'producer'] as const;
export const DeliveryRequesterSchema = z.enum(DELIVERY_REQUESTERS);
export type DeliveryRequester = z.infer<typeof DeliveryRequesterSchema>;

/** `delivery.completed`: the integration branch reached the base, by PR or by direct merge. */
export const DeliveryCompletedPayloadSchema = z.strictObject({
  playId: id,
  /** The mode that was carried out. */
  mode: z.enum(['pr', 'direct_merge']),
  /** The mode that was asked for; differs from `mode` when it was downgraded. */
  requestedMode: z.enum(DELIVERY_MODES),
  requestedBy: DeliveryRequesterSchema,
  downgraded: z.boolean(),
  /** Why the mode was downgraded (only when `downgraded`). */
  reason: z.string().min(1).optional(),
  branch: z.string().min(1),
  base: z.string().min(1),
  /** The head that was pushed. */
  pushedSha: sha,
  /** `mode: 'pr'`. */
  pullRequest: z.strictObject({ number: z.int().min(1), url: z.string().min(1) }).optional(),
  /** `mode: 'direct_merge'`: the new head of the base. */
  mergeSha: sha.optional(),
});
