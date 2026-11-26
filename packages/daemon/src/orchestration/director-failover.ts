// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode } from '@otheater/core';
import type { InterruptionCause } from '@otheater/protocol';
import type { DirectorFailoverMode } from '../config.js';
import { limitHitOf, type LimitHit } from '../quota/service.js';

/**
 * What a failed turn of the Director means for the failover (Phase 5, P20; architecture 5.4,
 * "Failover do Orquestrador", and 5.16, "Política por causa").
 *
 * [proposta] The cause is read from the same signals as the classification of an attempt
 * (`AttemptRunner`, P17): the typed error a session ends with. That classification is private to
 * the runner, which P19 also changes, so this module repeats its three rows that matter to a
 * session that has no play to resume: a limit (`quota_exhausted`, or `spend_cap` once the quota
 * service says the limit is the cap of an API key), a provider error (`transient`) and a drop
 * (`client_crash`). The rows of the table that need the play (a refusal, a stuck agent, a
 * permission) are the Director's own judgment and stay as they were: the turn fails and the queue
 * waits for the next prompt.
 */

/** A failure of the session of the Director that a new session can answer. */
export interface DirectorFailure {
  readonly cause: InterruptionCause;
  /** What the limit error says (when the quota comes back, and who said it); a limit only. */
  readonly limitHit?: LimitHit;
}

/**
 * [proposta] (P21b, N153) The profile the Director stands on is being removed
 * (`profiles.drain.director: failover`): not an error of the session but the drain's own order, so
 * it is not read from an error. `DirectorSessions.leaveProfile` hands it to the failover.
 */
export const PROFILE_REMOVED: DirectorFailure = { cause: 'profile_removed' };

/**
 * The cause of a failed turn, or `undefined` when no new session would help: an error the table
 * does not know (a refusal, a bug) fails the turn as before the failover existed.
 */
export function directorFailureOf(error: unknown): DirectorFailure | undefined {
  if (hasErrorCode(error, 'TRANSIENT')) return { cause: 'transient' };
  if (hasErrorCode(error, 'ADAPTER_UNAVAILABLE')) return { cause: 'client_crash' };
  const limitHit = limitHitOf(error);
  if (hasErrorCode(error, 'QUOTA_EXHAUSTED') || limitHit !== undefined) {
    return { cause: 'quota_exhausted', ...(limitHit === undefined ? {} : { limitHit }) };
  }
  return undefined;
}

/**
 * [proposta] (N334) The cause the chat tells when the opening of a session fails: a refusal of the
 * security policy (`PermissionDenied`: `security.unenforced: refuse` with no layer for a field,
 * as on a machine with no sandbox) is `permission`; the failure the failover answers keeps its own
 * cause; anything else is told as `client_crash`, as before. It only names the failure: whether a
 * new session is tried is still `directorFailureOf`.
 */
export function directorOpenCauseOf(error: unknown): InterruptionCause {
  if (hasErrorCode(error, 'PERMISSION_DENIED')) return 'permission';
  return directorFailureOf(error)?.cause ?? 'client_crash';
}

/** The causes `scenarios.director_failover: quota_only` answers. */
const QUOTA_CAUSES: readonly InterruptionCause[] = ['quota_exhausted', 'spend_cap'];

/** Whether `scenarios.director_failover` replaces the session for this cause. */
export function failoverApplies(mode: DirectorFailoverMode, cause: InterruptionCause): boolean {
  if (mode === 'off') return false;
  if (mode === 'quota_only') return QUOTA_CAUSES.includes(cause);
  return true;
}
