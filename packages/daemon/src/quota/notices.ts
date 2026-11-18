// SPDX-License-Identifier: MPL-2.0
import type { QuotaProbeFailure, QuotaSignalDrop } from '@otheater/protocol';
import { situationText, type SituationSink } from '../situations.js';

/**
 * The events beside the quota warnings of the log (P24, N146): `quota.probe_failed` and
 * `quota.signal_dropped`. [proposta] `detail` is the masked and cut text of the cause, never a key.
 */

export interface ProbeFailedExtra {
  readonly status?: number | undefined;
  readonly backoffMs?: number | undefined;
  /** An error or a text; it is masked and cut here. */
  readonly detail?: unknown;
}

/** A probe gave no reading of `profile`. */
export function recordProbeFailed(
  sink: SituationSink | undefined,
  profile: string,
  reason: QuotaProbeFailure,
  extra: ProbeFailedExtra = {},
): void {
  const detail = extra.detail === undefined ? null : situationText(extra.detail);
  sink?.record('quota.probe_failed', {
    profile,
    reason,
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.backoffMs === undefined ? {} : { backoffMs: extra.backoffMs }),
    ...(detail === null ? {} : { detail }),
  });
}

export interface SignalDroppedWhat {
  readonly profile?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
  readonly detail?: unknown;
}

/** A signal, a reading or a limit error did not reach the quota state. */
export function recordSignalDropped(
  sink: SituationSink | undefined,
  reason: QuotaSignalDrop,
  what: SignalDroppedWhat = {},
): void {
  const detail = what.detail === undefined ? null : situationText(what.detail);
  sink?.record('quota.signal_dropped', {
    profile: what.profile ?? null,
    sessionId: what.sessionId ?? null,
    reason,
    ...(detail === null ? {} : { detail }),
  });
}
