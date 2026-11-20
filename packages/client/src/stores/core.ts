// SPDX-License-Identifier: MPL-2.0
import type { ApiEventEnvelope } from '@otheater/protocol';
import type { z } from 'zod';

/**
 * What the stores of the client share (plan docs/17 P11). A store is a plain state object kept in
 * a zustand `vanilla` store; what changes it are pure functions, so everything here runs without
 * React, without network and without a clock. Browser-safe.
 *
 * Every store carries three fields, {@link SyncFields}:
 * - `loaded`: a REST snapshot was installed;
 * - `lastEventId`: the id of the last event that changed the store. An event whose id is not above
 *   it is ignored (it was applied already: the stream sent it again, or the snapshot covers it);
 * - `stale`: keys whose copy the events cannot keep right (the daemon writes the record with no
 *   event, or the event does not carry the whole record). The hub reads them again by REST.
 */

export interface SyncFields {
  readonly loaded: boolean;
  readonly lastEventId: number;
  /**
   * Keys to read again by REST, each with a revision that goes up every time an event marks it. A
   * read that started at revision `n` clears the key only if it is still `n` when the answer
   * comes: an event that arrived while the read was in flight keeps the key stale.
   */
  readonly stale: Readonly<Record<string, number>>;
}

/** A reducer of one store: a pure function of the state and one event. Unknown types: same state. */
export type EventReducer<S> = (state: S, event: ApiEventEnvelope) => S;

export function emptySync(): SyncFields {
  return { loaded: false, lastEventId: 0, stale: {} };
}

/**
 * Applies one event to a store. An event whose id is not above `lastEventId` is ignored. A reducer
 * that returns the same state means the event is not the store's business: nothing changes, not
 * even `lastEventId`, and a subscriber is not woken.
 */
export function applyEvent<S extends SyncFields>(
  state: S,
  event: ApiEventEnvelope,
  reduce: EventReducer<S>,
): S {
  if (event.id <= state.lastEventId) return state;
  const next = reduce(state, event);
  if (next === state) return state;
  return { ...next, lastEventId: event.id };
}

/** Applies a sequence of events, in order. */
export function applyEvents<S extends SyncFields>(
  state: S,
  events: readonly ApiEventEnvelope[],
  reduce: EventReducer<S>,
): S {
  let current = state;
  for (const event of events) current = applyEvent(current, event, reduce);
  return current;
}

/** The payload of an event as `schema` reads it, or `undefined` when it does not fit. */
export function payloadOf<Schema extends z.ZodType>(
  schema: Schema,
  event: ApiEventEnvelope,
): z.infer<Schema> | undefined {
  const parsed = schema.safeParse(event.payload);
  return parsed.success ? parsed.data : undefined;
}

/** Marks `key` to be read again: the revision goes up by one. */
export function markStale<S extends SyncFields>(state: S, key: string): S {
  return { ...state, stale: { ...state.stale, [key]: (state.stale[key] ?? 0) + 1 } };
}

/** Clears `key` if a read that started at `revision` is still the latest ask. */
export function clearStale<S extends SyncFields>(state: S, key: string, revision: number): S {
  if (state.stale[key] !== revision) return state;
  return { ...state, stale: without(state.stale, key) };
}

/** A copy of `record` without `key` (the same object when it is not there). */
export function without<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> {
  if (!(key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/** Keys with the highest value of `pick` last: a stable order for lists. */
export function byNumberThenId<Item extends { readonly id: string }>(
  pick: (item: Item) => number,
): (a: Item, b: Item) => number {
  return (a, b) => pick(a) - pick(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
