// SPDX-License-Identifier: MPL-2.0
import {
  buildTrajectory,
  isDirectTrajectoryEvent,
  isTrajectoryEvent,
  trajectorySubjectOf,
  type ApiDemandDiff,
  type ApiDirectSession,
  type Trajectory,
  type TrajectoryEvent,
} from '@otheater/protocol';

/**
 * The trajectories the screen follows (P14 of docs/18, architecture 5.11): per play, the events
 * its trajectory is built from, oldest first, capped at `client.trajectories.keep`. [proposta] The
 * history comes by one paged REST read when a screen opens the play; from then on the events of
 * the stream are appended as they arrive, so there is no read per event. A play nobody asked
 * for keeps nothing. The events of the history and of the stream may overlap: they merge by id.
 * The diffs of the demands are read on demand and kept by `playId/demandId`. [proposta] P27 of
 * docs/18: a direct session is kept like a play, under its session id (`direct-<hex>`), and the
 * store also indexes the direct sessions it knows of, per scenario, so a screen can follow the
 * latest of them.
 */

/** [proposta] How many events of one play the store keeps when `client.trajectories.keep` is not set. */
export const DEFAULT_TRAJECTORY_KEEP = 5000;

export type TrajectoryLoad = 'loading' | 'loaded' | 'failed';

export interface PlayTrajectoryState {
  readonly load: TrajectoryLoad;
  /** The events, oldest first, at most `keep`. */
  readonly events: readonly TrajectoryEvent[];
  /** Events that fell off the head because of `keep`: the folded view then starts late. */
  readonly dropped: number;
  readonly error: string | undefined;
}

export interface DemandDiffState {
  readonly load: TrajectoryLoad;
  readonly value: ApiDemandDiff | undefined;
  readonly error: string | undefined;
}

/** A direct session the store knows of: enough to pick the one a screen follows. */
export interface DirectTrajectorySubject {
  readonly sessionId: string;
  readonly scenarioId: string;
  /** Epoch ms of the last thing that happened in it. */
  readonly at: number;
  readonly closed: boolean;
}

export interface TrajectoriesState {
  /** The trajectories held, by play id or by direct session id. */
  readonly plays: Readonly<Record<string, PlayTrajectoryState>>;
  readonly diffs: Readonly<Record<string, DemandDiffState>>;
  /** The direct sessions known, by session id (P27). */
  readonly direct: Readonly<Record<string, DirectTrajectorySubject>>;
}

export function initialTrajectories(): TrajectoriesState {
  return { plays: {}, diffs: {}, direct: {} };
}

export function diffKey(playId: string, demandId: string): string {
  return `${playId}/${demandId}`;
}

/** The union of two lists of events by id, oldest first, cut to the last `keep`. */
export function mergeTrajectoryEvents(
  current: readonly TrajectoryEvent[],
  incoming: readonly TrajectoryEvent[],
  keep: number,
): { readonly events: readonly TrajectoryEvent[]; readonly dropped: number } {
  const byId = new Map<number, TrajectoryEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  const all = [...byId.values()].sort((a, b) => a.id - b.id);
  const dropped = Math.max(0, all.length - keep);
  return { events: dropped === 0 ? all : all.slice(dropped), dropped };
}

/** A screen opens a play: the history is being read. A play already there keeps what it has. */
export function openTrajectory(state: TrajectoriesState, playId: string): TrajectoriesState {
  const old = state.plays[playId];
  const next: PlayTrajectoryState = {
    load: 'loading',
    events: old?.events ?? [],
    dropped: old?.dropped ?? 0,
    error: undefined,
  };
  return { ...state, plays: { ...state.plays, [playId]: next } };
}

/** The history was read: it merges with what the stream brought meanwhile. */
export function settleTrajectory(
  state: TrajectoriesState,
  playId: string,
  history: readonly TrajectoryEvent[],
  keep: number,
): TrajectoriesState {
  const old = state.plays[playId];
  const merged = mergeTrajectoryEvents(old?.events ?? [], history, keep);
  const next: PlayTrajectoryState = {
    load: 'loaded',
    events: merged.events,
    dropped: (old?.dropped ?? 0) + merged.dropped,
    error: undefined,
  };
  return { ...state, plays: { ...state.plays, [playId]: next } };
}

export function failTrajectory(
  state: TrajectoriesState,
  playId: string,
  error: string,
): TrajectoriesState {
  const old = state.plays[playId];
  const next: PlayTrajectoryState = {
    load: 'failed',
    events: old?.events ?? [],
    dropped: old?.dropped ?? 0,
    error,
  };
  return { ...state, plays: { ...state.plays, [playId]: next } };
}

/** An event of the stream: it goes to the play it names, if a screen follows that play. */
export function reduceTrajectories(
  state: TrajectoriesState,
  event: TrajectoryEvent & { readonly scenarioId?: string | undefined },
  keep: number,
): TrajectoriesState {
  if (!isTrajectoryEvent(event.type)) return state;
  const playId = trajectorySubjectOf(event);
  if (playId === undefined) return state;
  if (isDirectTrajectoryEvent(event.type)) {
    return reduceHeld(noteDirectEvent(state, playId, event), playId, event, keep);
  }
  return reduceHeld(state, playId, event, keep);
}

/** The direct session an event of the stream names: new on `opened`, closed on `closed`, alive on the rest. */
function noteDirectEvent(
  state: TrajectoriesState,
  sessionId: string,
  event: TrajectoryEvent & { readonly scenarioId?: string | undefined },
): TrajectoriesState {
  const known = state.direct[sessionId];
  const scenarioId = known?.scenarioId ?? event.scenarioId;
  if (scenarioId === undefined) return state;
  const next: DirectTrajectorySubject = {
    sessionId,
    scenarioId,
    at: Math.max(known?.at ?? 0, event.timestamp),
    closed: known?.closed === true || event.type === 'direct.session.closed',
  };
  if (known === undefined && event.type !== 'direct.session.opened') return state;
  return { ...state, direct: { ...state.direct, [sessionId]: next } };
}

/** The direct sessions a REST list of a scenario brought, merged with what the stream noted. */
export function settleDirectSessions(
  state: TrajectoriesState,
  sessions: readonly ApiDirectSession[],
): TrajectoriesState {
  if (sessions.length === 0) return state;
  const direct = { ...state.direct };
  for (const session of sessions) {
    const known = direct[session.id];
    direct[session.id] = {
      sessionId: session.id,
      scenarioId: session.scenarioId,
      at: Math.max(known?.at ?? 0, session.closedAt ?? session.lastActivityAt),
      closed: known?.closed === true || session.state === 'closed',
    };
  }
  return { ...state, direct };
}

function reduceHeld(
  state: TrajectoriesState,
  playId: string,
  event: TrajectoryEvent,
  keep: number,
): TrajectoriesState {
  const old = state.plays[playId];
  if (old === undefined) return state;
  const last = old.events[old.events.length - 1];
  let merged: { readonly events: readonly TrajectoryEvent[]; readonly dropped: number };
  if (last === undefined || event.id > last.id) {
    // The usual case: the stream is in order, so the event goes at the end.
    const events = [...old.events, event];
    const dropped = Math.max(0, events.length - keep);
    merged = { events: dropped === 0 ? events : events.slice(dropped), dropped };
  } else {
    // At or below the last one held: the history had it, or the stream sent it again.
    if (old.events.some((held) => held.id === event.id)) return state;
    merged = mergeTrajectoryEvents(old.events, [event], keep);
  }
  return {
    ...state,
    plays: {
      ...state.plays,
      [playId]: { ...old, events: merged.events, dropped: old.dropped + merged.dropped },
    },
  };
}

export function openDiff(
  state: TrajectoriesState,
  playId: string,
  demandId: string,
): TrajectoriesState {
  const key = diffKey(playId, demandId);
  const old = state.diffs[key];
  return {
    ...state,
    diffs: { ...state.diffs, [key]: { load: 'loading', value: old?.value, error: undefined } },
  };
}

export function settleDiff(state: TrajectoriesState, value: ApiDemandDiff): TrajectoriesState {
  return {
    ...state,
    diffs: {
      ...state.diffs,
      [diffKey(value.playId, value.demandId)]: { load: 'loaded', value, error: undefined },
    },
  };
}

export function failDiff(
  state: TrajectoriesState,
  playId: string,
  demandId: string,
  error: string,
): TrajectoriesState {
  const key = diffKey(playId, demandId);
  return {
    ...state,
    diffs: { ...state.diffs, [key]: { load: 'failed', value: state.diffs[key]?.value, error } },
  };
}

/** The folded trajectory of a play (`undefined` while no screen has opened it). */
export function selectTrajectory(state: TrajectoriesState, playId: string): Trajectory | undefined {
  const held = state.plays[playId];
  return held === undefined ? undefined : buildTrajectory(playId, held.events);
}
