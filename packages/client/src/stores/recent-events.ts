// SPDX-License-Identifier: MPL-2.0
import type { ApiEventEnvelope } from '@otheater/protocol';
import { emptySync, type EventReducer, type SyncFields } from './core.js';

/**
 * The last events the stream delivered, oldest first, capped at `client.events.keep` (default
 * {@link DEFAULT_EVENTS_KEEP}). Every type is kept, known or not: this is the activity feed. [proposta]
 * There is no REST read of the log, so a client that connects shows only what happens from then
 * on (what came before the head of the log at the first frame is not backfilled).
 */

/** [proposta] How many events the store keeps when `client.events.keep` is not set. */
export const DEFAULT_EVENTS_KEEP = 500;

export interface RecentEventsState extends SyncFields {
  readonly events: readonly ApiEventEnvelope[];
}

export function initialRecentEvents(): RecentEventsState {
  return { ...emptySync(), events: [] };
}

export function createRecentEventsReducer(
  keep: number = DEFAULT_EVENTS_KEEP,
): EventReducer<RecentEventsState> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new RangeError('client.events.keep must be an integer of at least 1');
  }
  return (state, event) => {
    const events = [...state.events, event];
    return { ...state, events: events.length > keep ? events.slice(events.length - keep) : events };
  };
}

/** A snapshot: nothing to read, the store starts empty at the head of the log. */
export function installRecentEvents(lastEventId: number): RecentEventsState {
  return { loaded: true, lastEventId, stale: {}, events: [] };
}

/** The events, newest first. */
export function selectRecentEvents(state: RecentEventsState): ApiEventEnvelope[] {
  return [...state.events].reverse();
}
