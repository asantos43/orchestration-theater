// SPDX-License-Identifier: MPL-2.0
import {
  DemandResumedPayloadSchema,
  DemandWaitingPayloadSchema,
  type ApiPlayDetail,
} from '@otheater/protocol';
import type { z } from 'zod';
import {
  clearStale,
  emptySync,
  markStale,
  payloadOf,
  without,
  type EventReducer,
  type SyncFields,
} from './core.js';

/**
 * The demands (and the stages) of the plays, by play id. [proposta] The daemon writes a demand
 * with no event of its own: what the log says is that the play moved (`play.transitioned`), so a
 * tracked play whose machine moved is marked to be read again by `GET /v1/plays/:id`, and the
 * events that say a demand waits for an Executor (`demand.waiting`, `demand.resumed`) are kept as
 * they come, in `waiting`. A play is tracked once its detail was read (the snapshot of the open
 * plays, `track`, or a new play when `followNewPlays` is on).
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
        return markStale(state, id);
      }
      case 'play.transitioned': {
        const id = event.playId;
        if (id === undefined || !(id in state.byPlay)) return state;
        return markStale(state, id);
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
