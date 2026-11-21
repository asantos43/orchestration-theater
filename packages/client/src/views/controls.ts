// SPDX-License-Identifier: MPL-2.0
import type { ApiErrorCode, ApiPlay } from '@otheater/protocol';
import type { ApiClient } from '../client.js';
import { ApiClientError, ApiRequestError } from '../errors.js';
import type { ActorActivity } from '../stores/activity.js';

/**
 * What the pause and resume controls of the Overview may do (P13 of docs/18). It is the same call
 * the `/pause` and `/resume` commands end in (the routes of P2), so the effect, and the events,
 * are the same. Pure decisions plus one function that makes the call.
 */

export type ControlTarget =
  | { readonly kind: 'play'; readonly playId: string }
  | { readonly kind: 'actor'; readonly attemptId: string };

export type ControlAction = 'pause' | 'resume';

export interface Controls {
  readonly pause: boolean;
  readonly resume: boolean;
}

/**
 * [proposta] A play can be paused while it is open and not paused as far as this client saw. It
 * can be resumed whenever it is open: a pause from before this client connected leaves no trace
 * in the stores (the API has no paused flag), so the resume is offered and the daemon answers
 * `conflict` when there is nothing to resume.
 */
export function playControls(
  play: ApiPlay | undefined,
  pausedPlays: ReadonlySet<string>,
): Controls {
  if (play === undefined || play.finishedAt !== null) return { pause: false, resume: false };
  return { pause: !pausedPlays.has(play.id), resume: true };
}

/** An Actor in flight can be paused; one that was paused can be resumed. */
export function actorControls(actor: ActorActivity | undefined): Controls {
  if (actor?.attemptId === undefined) return { pause: false, resume: false };
  return { pause: actor.paused === undefined, resume: actor.paused !== undefined };
}

export type ControlResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ApiErrorCode | 'network' | 'invalid' };

/**
 * Calls the route of the control. A pause of a play takes no `mode`, so the daemon applies
 * `pause.mode` of the configuration, exactly as `/pause` does. Never throws: a refusal of the
 * daemon comes back as its `code` (`conflict` when it does not apply, `not_found`, `unavailable`).
 */
export async function runControl(
  client: Pick<ApiClient, 'pausePlay' | 'resumePlay' | 'pauseAttempt' | 'resumeAttempt'>,
  target: ControlTarget,
  action: ControlAction,
): Promise<ControlResult> {
  try {
    if (target.kind === 'play') {
      if (action === 'pause') await client.pausePlay(target.playId);
      else await client.resumePlay(target.playId);
    } else if (action === 'pause') await client.pauseAttempt(target.attemptId);
    else await client.resumeAttempt(target.attemptId);
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, code: error.code };
    if (error instanceof ApiClientError) return { ok: false, code: 'network' };
    return { ok: false, code: 'invalid' };
  }
}
