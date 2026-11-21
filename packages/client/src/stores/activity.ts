// SPDX-License-Identifier: MPL-2.0
import {
  AttemptPausedPayloadSchema,
  PlayTransitionedPayloadSchema,
  SessionClosedPayloadSchema,
  SessionOpenedPayloadSchema,
  isFinalPlayState,
  type ExecutorPayload,
} from '@otheater/protocol';
import { emptySync, payloadOf, without, type EventReducer, type SyncFields } from './core.js';

/**
 * Who is working and what is paused, kept from the events alone (P13 of docs/18). The Overview
 * tab lists the Actors in flight with the time they have left, and it must not read the REST API
 * at every event; the recent-events window cannot carry this (a `session.update` burst pushes
 * the opening of a long session out of it), so this store keeps the little that matters:
 * - `actors`: one entry per attempt in flight (the key is the attempt id, or the session id for a
 *   session that belongs to no play): opened by `session.opened`, closed by `session.closed`, and
 *   kept while the attempt is paused, so the person can resume it;
 * - `pausedPlays`: the plays that got a `PAUSE` and no `RESUME` yet, with the stamp of the pause.
 *
 * [proposta] What the events cannot say: an Actor that opened, or a play that paused, before this
 * client connected. There is no REST route that lists attempts, and `ApiPlay` has no paused flag,
 * so the store starts empty and fills as events come (a gap reported in the PR of P13).
 */

export interface ActorActivity {
  /** The key in `actors`: the attempt id, or the session id when the session has no attempt. */
  readonly key: string;
  readonly sessionId: string;
  readonly attemptId: string | undefined;
  readonly playId: string | undefined;
  readonly demandId: string | undefined;
  readonly executor: ExecutorPayload;
  /** The stamp of the first `session.opened` of the attempt (epoch ms). */
  readonly startedAt: number;
  /** Who paused it: the person (`actor`) or the pause of the play (`play`); `undefined` when it runs. */
  readonly paused: 'actor' | 'play' | undefined;
}

export interface ActivityState extends SyncFields {
  readonly actors: Readonly<Record<string, ActorActivity>>;
  /** Plays paused now, by id, with the stamp of the `PAUSE`. */
  readonly pausedPlays: Readonly<Record<string, number>>;
}

export function initialActivity(): ActivityState {
  return { ...emptySync(), actors: {}, pausedPlays: {} };
}

function withoutPlay(state: ActivityState, playId: string): ActivityState {
  const actors = Object.fromEntries(
    Object.entries(state.actors).filter(([, actor]) => actor.playId !== playId),
  );
  const same =
    Object.keys(actors).length === Object.keys(state.actors).length &&
    !(playId in state.pausedPlays);
  if (same) return state;
  return { ...state, actors, pausedPlays: without(state.pausedPlays, playId) };
}

export const reduceActivity: EventReducer<ActivityState> = (state, event) => {
  switch (event.type) {
    case 'session.opened': {
      const payload = payloadOf(SessionOpenedPayloadSchema, event);
      if (payload === undefined) return state;
      const attemptId = payload.attemptId ?? event.attemptId;
      const key = attemptId ?? payload.sessionId;
      const before = state.actors[key];
      const actor: ActorActivity = {
        key,
        sessionId: payload.sessionId,
        attemptId,
        playId: payload.playId ?? event.playId,
        demandId: payload.demandId,
        executor: payload.executor,
        // The attempt keeps the stamp of its first session: a resume does not give it more time.
        startedAt: before?.startedAt ?? event.timestamp,
        paused: undefined,
      };
      return { ...state, actors: { ...state.actors, [key]: actor } };
    }
    case 'session.closed': {
      const payload = payloadOf(SessionClosedPayloadSchema, event);
      if (payload === undefined) return state;
      const attemptId = payload.attemptId ?? event.attemptId;
      const key = attemptId ?? payload.sessionId;
      const actor = state.actors[key];
      if (actor?.sessionId !== payload.sessionId) return state;
      // An interrupted session leaves the attempt in flight: a pause (the runner writes
      // `session.closed` first and `attempt.paused` right after), a resume or a handoff go on in a
      // new session. The attempt leaves the list by its own end (`attempt.cancelled`, `aborted`
      // or `submitted`) or by the end of the play.
      if (
        actor.paused !== undefined ||
        (payload.reason === 'interrupted' && attemptId !== undefined)
      ) {
        return state;
      }
      return { ...state, actors: without(state.actors, key) };
    }
    case 'attempt.paused': {
      const payload = payloadOf(AttemptPausedPayloadSchema, event);
      const attemptId = payload?.attemptId ?? event.attemptId;
      if (payload === undefined || attemptId === undefined) return state;
      const actor = state.actors[attemptId];
      if (actor === undefined) return state;
      return {
        ...state,
        actors: { ...state.actors, [attemptId]: { ...actor, paused: payload.origin } },
      };
    }
    case 'attempt.resumed': {
      const attemptId = event.attemptId;
      if (attemptId === undefined) return state;
      const actor = state.actors[attemptId];
      if (actor?.paused === undefined) return state;
      return {
        ...state,
        actors: { ...state.actors, [attemptId]: { ...actor, paused: undefined } },
      };
    }
    case 'attempt.cancelled':
    case 'attempt.aborted':
    case 'attempt.submitted': {
      const attemptId = event.attemptId;
      if (attemptId === undefined || !(attemptId in state.actors)) return state;
      return { ...state, actors: without(state.actors, attemptId) };
    }
    case 'play.transitioned': {
      const playId = event.playId;
      const payload = payloadOf(PlayTransitionedPayloadSchema, event);
      if (playId === undefined || payload === undefined) return state;
      if (isFinalPlayState(payload.to)) return withoutPlay(state, playId);
      if (payload.event === 'PAUSE') {
        return { ...state, pausedPlays: { ...state.pausedPlays, [playId]: event.timestamp } };
      }
      if (payload.event === 'RESUME') {
        return playId in state.pausedPlays
          ? { ...state, pausedPlays: without(state.pausedPlays, playId) }
          : state;
      }
      return state;
    }
    default:
      return state;
  }
};

/** A snapshot: nothing to read, the store starts empty at the head of the log. */
export function installActivity(lastEventId: number): ActivityState {
  return { loaded: true, lastEventId, stale: {}, actors: {}, pausedPlays: {} };
}
