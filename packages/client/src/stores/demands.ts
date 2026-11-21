// SPDX-License-Identifier: MPL-2.0
import {
  DemandResumedPayloadSchema,
  DemandTransitionedPayloadSchema,
  DemandWaitingPayloadSchema,
  type ApiPlayDetail,
} from '@otheater/protocol';
import type { z } from 'zod';
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
 * The demands (and the stages) of the plays, by play id. [proposta] Built from the events alone,
 * with no read per transition (N173, P1 of docs/18): `demand.transitioned` with `from: null`
 * carries the whole record of a new demand, and a later one moves its `state` (the stamp of the
 * event is the `updatedAt`, N177). A new play starts with no demand (`play.created`). The events
 * that say a demand waits for an Executor (`demand.waiting`, `demand.resumed`) are kept as they
 * come, in `waiting`. A play is tracked once its detail was read (the snapshot of the open plays,
 * `track`) or when a new play is born and `followNewPlays` is on; the stages stay as the read left
 * them (the daemon writes none today). A key is marked stale only when an event cannot be applied:
 * a demand this store does not have, or a birth with no record.
 */

/** The demand and stage lists of one play, as `GET /v1/plays/:id` answers. */
export type PlayParts = Pick<ApiPlayDetail, 'demands' | 'stages'>;

/** What `demand.waiting` says about a demand that waits for an Executor. */
export type DemandWait = z.infer<typeof DemandWaitingPayloadSchema>;

export interface DemandsState extends SyncFields {
  readonly byPlay: Readonly<Record<string, PlayParts>>;
  /** Demands that wait for an Executor right now, by `waitKey(playId, demandId)`. */
  readonly waiting: Readonly<Record<string, DemandWait>>;
}

export function initialDemands(): DemandsState {
  return { ...emptySync(), byPlay: {}, waiting: {} };
}

/** The key of a demand in `waiting`. A play id has no `/`. */
export function waitKey(playId: string, demandId: string): string {
  return `${playId}/${demandId}`;
}

export interface DemandsReducerOptions {
  /**
   * Track every new play (read its detail when `play.created` comes). Default `true`. With
   * `false`, only the plays asked for with `track` are followed.
   */
  readonly followNewPlays?: boolean | undefined;
}

export function createDemandsReducer(
  options: DemandsReducerOptions = {},
): EventReducer<DemandsState> {
  const followNewPlays = options.followNewPlays ?? true;
  return (state, event) => {
    switch (event.type) {
      case 'play.created': {
        const id = event.playId;
        if (!followNewPlays || id === undefined || id in state.byPlay) return state;
        // A new play has no demand yet: each one comes with its own `demand.transitioned`.
        return { ...state, byPlay: { ...state.byPlay, [id]: { demands: [], stages: [] } } };
      }
      case 'demand.transitioned': {
        const payload = payloadOf(DemandTransitionedPayloadSchema, event);
        if (payload === undefined) return state;
        const parts = state.byPlay[payload.playId];
        // A play this store does not follow: its demands are not kept.
        if (parts === undefined) return state;
        const known = parts.demands.find((demand) => demand.id === payload.demandId);
        let demands: PlayParts['demands'];
        if (payload.demand !== undefined) {
          demands = [
            ...parts.demands.filter((demand) => demand.id !== payload.demandId),
            payload.demand,
          ].sort(byNumberThenId((demand) => demand.createdAt));
        } else if (known !== undefined) {
          demands = parts.demands.map((demand) =>
            demand.id === payload.demandId
              ? {
                  ...demand,
                  state: payload.to,
                  updatedAt: Math.max(demand.updatedAt, event.timestamp),
                }
              : demand,
          );
        } else {
          return markStale(state, payload.playId);
        }
        return { ...state, byPlay: { ...state.byPlay, [payload.playId]: { ...parts, demands } } };
      }
      case 'demand.waiting': {
        const payload = payloadOf(DemandWaitingPayloadSchema, event);
        if (payload === undefined) return state;
        return {
          ...state,
          waiting: { ...state.waiting, [waitKey(payload.playId, payload.demandId)]: payload },
        };
      }
      case 'demand.resumed': {
        const payload = payloadOf(DemandResumedPayloadSchema, event);
        if (payload === undefined) return state;
        const key = waitKey(payload.playId, payload.demandId);
        if (!(key in state.waiting)) return state;
        return { ...state, waiting: without(state.waiting, key) };
      }
      default:
        return state;
    }
  };
}

/** The reducer with the defaults. */
export const reduceDemands: EventReducer<DemandsState> = createDemandsReducer();

/** A snapshot: the detail of some plays, replacing what was there. */
export function installDemands(
  details: readonly { readonly playId: string; readonly parts: PlayParts }[],
  lastEventId: number,
): DemandsState {
  return {
    loaded: true,
    lastEventId,
    stale: {},
    byPlay: Object.fromEntries(details.map((detail) => [detail.playId, detail.parts])),
    waiting: {},
  };
}

/** The answer of a read of one play: its parts, or `null` when the play is gone (404). */
export function settleDemands(
  state: DemandsState,
  playId: string,
  revision: number,
  parts: PlayParts | null,
): DemandsState {
  const next: DemandsState =
    parts === null
      ? { ...state, byPlay: without(state.byPlay, playId) }
      : { ...state, byPlay: { ...state.byPlay, [playId]: parts } };
  return clearStale(next, playId, revision);
}

/** Starts to follow a play: it is read at the next refresh. */
export function trackPlay(state: DemandsState, playId: string): DemandsState {
  return playId in state.byPlay ? state : markStale(state, playId);
}
