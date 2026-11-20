// SPDX-License-Identifier: MPL-2.0
import {
  PlayCreatedPayloadSchema,
  PlayTransitionedPayloadSchema,
  isFinalPlayState,
  type ApiPlay,
} from '@otheater/protocol';
import {
  byNumberThenId,
  clearStale,
  emptySync,
  markStale,
  payloadOf,
  without,
  type EventReducer,
  type SyncFields,
} from './core.js';

/**
 * The plays (peças) of one daemon, by id. The events carry the whole record, so a play built only
 * from `play.created` and `play.transitioned` equals the REST record at the end of the play
 * (checked against a real daemon in P13, with a clock that moves too). [V] N177: the daemon
 * writes the record and the event in one transaction that reads the clock once, so the two things
 * the events do not say are the timestamp of the event: `createdAt`/`updatedAt` are its timestamp,
 * and `finishedAt` is its timestamp when the play goes to a final state; the snapshot of the
 * machine is not in the API.
 */

export interface PlaysState extends SyncFields {
  readonly byId: Readonly<Record<string, ApiPlay>>;
}

export function initialPlays(): PlaysState {
  return { ...emptySync(), byId: {} };
}

export const reducePlays: EventReducer<PlaysState> = (state, event) => {
  switch (event.type) {
    case 'play.created': {
      const id = event.playId;
      if (id === undefined) return state;
      if (id in state.byId) return state;
      const payload = payloadOf(PlayCreatedPayloadSchema, event);
      if (payload === undefined || event.scenarioId === undefined) return markStale(state, id);
      const play: ApiPlay = {
        id,
        scenarioId: event.scenarioId,
        need: payload.need,
        flowId: payload.flowId,
        flowVersion: payload.flowVersion,
        state: 'NEED',
        counters: {},
        parentPlayId: payload.parentPlayId,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        finishedAt: null,
      };
      return { ...state, byId: { ...state.byId, [id]: play } };
    }
    case 'play.transitioned': {
      const id = event.playId;
      if (id === undefined) return state;
      const known = state.byId[id];
      const payload = payloadOf(PlayTransitionedPayloadSchema, event);
      // A play this store never saw (a closed one, say), or a payload it cannot read: read it.
      if (known === undefined || payload === undefined) return markStale(state, id);
      return {
        ...state,
        byId: {
          ...state.byId,
          [id]: {
            ...known,
            state: payload.to,
            counters: payload.counters,
            updatedAt: event.timestamp,
            finishedAt: isFinalPlayState(payload.to) ? event.timestamp : null,
          },
        },
      };
    }
    default:
      return state;
  }
};

/** A snapshot of some plays (the scenarios' lists): replaces what was there. */
export function installPlays(plays: readonly ApiPlay[], lastEventId: number): PlaysState {
  return {
    loaded: true,
    lastEventId,
    stale: {},
    byId: Object.fromEntries(plays.map((play) => [play.id, play])),
  };
}

/** The answer of a read of one play: the record, or `null` when it is gone (404). */
export function settlePlay(
  state: PlaysState,
  id: string,
  revision: number,
  play: ApiPlay | null,
): PlaysState {
  const next: PlaysState =
    play === null
      ? { ...state, byId: without(state.byId, id) }
      : { ...state, byId: { ...state.byId, [id]: play } };
  return clearStale(next, id, revision);
}

/** The plays of a scenario, oldest first. */
export function selectPlaysOf(state: PlaysState, scenarioId: string): ApiPlay[] {
  return Object.values(state.byId)
    .filter((play) => play.scenarioId === scenarioId)
    .sort(byNumberThenId((play) => play.createdAt));
}

/** The plays not finished, oldest first. */
export function selectOpenPlays(state: PlaysState): ApiPlay[] {
  return Object.values(state.byId)
    .filter((play) => play.finishedAt === null)
    .sort(byNumberThenId((play) => play.createdAt));
}
