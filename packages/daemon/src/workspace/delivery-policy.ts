// SPDX-License-Identifier: MPL-2.0
import type { DELIVERY_MODES } from '@otheater/core';
import type { DeliveryRequester } from '@otheater/protocol';

export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** The mode asked for, and by whom (architecture 5.5: "o PR e o evento registram quem o pediu"). */
export interface DeliveryRequest {
  readonly mode: DeliveryMode;
  readonly by: DeliveryRequester;
}

export interface DeliveryPolicyInput {
  /**
   * The most specific request: the override of the task, the play or the project, or the Producer's
   * answer to `ask`. Absent: the global `delivery.mode` decides, requested by `config`.
   */
  readonly requested?: DeliveryRequest;
  /** `delivery.mode`. */
  readonly configMode: DeliveryMode;
  /** `delivery.allow_direct_merge`: the project's permission. */
  readonly allowDirectMerge: boolean;
  /** Someone is looking (an interactive play). A scheduled task is not attended. */
  readonly attended: boolean;
}

/** Why a request was not carried out as asked. */
export const DELIVERY_DOWNGRADE_REASONS = [
  'direct_merge_not_allowed',
  'direct_merge_not_requested_by_play_or_task',
  'unattended',
] as const;
export type DeliveryDowngradeReason = (typeof DELIVERY_DOWNGRADE_REASONS)[number];

export interface DeliveryDecision {
  /** What happens next: `ask` means the Director must ask the Producer before anything else. */
  readonly mode: DeliveryMode;
  readonly requestedMode: DeliveryMode;
  readonly requestedBy: DeliveryRequester;
  readonly downgraded: boolean;
  readonly reason?: DeliveryDowngradeReason;
}

/**
 * The delivery policy of architecture 5.5 (decision N5), as a pure function:
 *
 * - `pr` opens the PR and stops. It is the default and the destination of every downgrade.
 * - `direct_merge` holds only with `allow_direct_merge` AND a request from the play or the task
 *   (or the Producer's own answer to `ask`).
 * - `ask` makes the Director ask the Producer; with nobody looking it becomes `pr`.
 * - Without `allow_direct_merge`, `direct_merge` and `ask` become `pr`.
 *
 * [proposta] A `direct_merge` that only the global config or the project asked for (nobody on the
 * play or the task) is read as "not requested" and becomes `pr`: the safe side of an ambiguity in
 * the text of 5.5. The Producer's answer to `ask` counts as a request.
 */
export function resolveDeliveryMode(input: DeliveryPolicyInput): DeliveryDecision {
  const request: DeliveryRequest = input.requested ?? { mode: input.configMode, by: 'config' };
  const base = { requestedMode: request.mode, requestedBy: request.by };
  const toPr = (reason: DeliveryDowngradeReason): DeliveryDecision => ({
    ...base,
    mode: 'pr',
    downgraded: true,
    reason,
  });
  if (request.mode === 'pr') return { ...base, mode: 'pr', downgraded: false };
  if (!input.allowDirectMerge) return toPr('direct_merge_not_allowed');
  if (request.mode === 'ask') {
    return input.attended ? { ...base, mode: 'ask', downgraded: false } : toPr('unattended');
  }
  if (request.by === 'config' || request.by === 'project') {
    return toPr('direct_merge_not_requested_by_play_or_task');
  }
  return { ...base, mode: 'direct_merge', downgraded: false };
}
