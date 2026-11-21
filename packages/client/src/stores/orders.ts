// SPDX-License-Identifier: MPL-2.0
import {
  DirectiveActivatedPayloadSchema,
  DirectiveCreatedPayloadSchema,
  DirectiveExpiredPayloadSchema,
  DirectiveExpiringPayloadSchema,
  DirectiveRevokedPayloadSchema,
  DirectiveValidityChangedPayloadSchema,
  type ApiOrder,
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
 * The orders (directives, architecture 5.17) of the Producer: the ones in force, the scheduled
 * and the ended, by order id (`O<n>`). [proposta] Built from the events alone, with no read per
 * event (N173, P15 of docs/18), the way `demands` and `decisions` are:
 * - `directive.created` carries the whole record (`order`) and adds it;
 * - `directive.activated` and `directive.expired` move its `state`;
 * - `directive.validity_changed` moves the dates, and the state is the one the new dates mean at
 *   the moment of the event (`orderStateAt`), so an extension that pushes the start into the
 *   future gives `scheduled` with no event of its own;
 * - `directive.revoked` ends it, with the reason;
 * - `directive.expiring` is kept in `expiring` until the end moves, passes or the order is revoked;
 * - `directive.suspended` changes no record: the suspension is an order of its own, which came
 *   with its `directive.created`.
 * A key is marked stale only when an event cannot be applied: an order this store does not have
 * (and no record to add), or a `created` from a log that did not carry the record.
 */

/** What `directive.expiring` said about an order that is about to end. */
export interface OrderNotice {
  readonly endsAt: number;
  /** The advance the notice was configured with (`directives.expiring_notice`). */
  readonly noticeMs: number;
}

export interface OrdersState extends SyncFields {
  readonly byId: Readonly<Record<string, ApiOrder>>;
  /** The orders that were announced as about to end, by order id. */
  readonly expiring: Readonly<Record<string, OrderNotice>>;
}

export function initialOrders(): OrdersState {
  return { ...emptySync(), byId: {}, expiring: {} };
}

/** The orders in the order they were given (`seq`, which never changes). */
export function ordersInOrder(state: Pick<OrdersState, 'byId'>): ApiOrder[] {
  return Object.values(state.byId).sort((a, b) => a.seq - b.seq);
}

/**
 * The state the validity means at `now` (the same rule as `directiveStateAt` of the core, which
 * the client does not depend on): revoked, scheduled before the start, expired from the end on.
 */
export function orderStateAt(
  order: Pick<ApiOrder, 'startsAt' | 'endsAt' | 'revokedAt'>,
  now: number,
): ApiOrder['state'] {
  if (order.revokedAt !== null) return 'revoked';
  if (order.startsAt > now) return 'scheduled';
  if (order.endsAt !== null && order.endsAt <= now) return 'expired';
  return 'active';
}

const bySeq = byNumberThenId<ApiOrder>((order) => order.seq);

function put(state: OrdersState, order: ApiOrder): OrdersState {
  const byId = { ...state.byId, [order.id]: order };
  // Keep the keys in the order given: a copy sorted by `seq`.
  const sorted = Object.fromEntries(
    Object.values(byId)
      .sort(bySeq)
      .map((item) => [item.id, item]),
  );
  return { ...state, byId: sorted };
}

function patch(
  state: OrdersState,
  id: string,
  change: (order: ApiOrder) => ApiOrder,
): OrdersState | undefined {
  const order = state.byId[id];
  if (order === undefined) return undefined;
  return { ...state, byId: { ...state.byId, [id]: change(order) } };
}

export const reduceOrders: EventReducer<OrdersState> = (state, event) => {
  switch (event.type) {
    case 'directive.created': {
      const payload = payloadOf(DirectiveCreatedPayloadSchema, event);
      if (payload === undefined) return state;
      if (payload.order !== undefined) return put(state, payload.order);
      return payload.directiveId in state.byId ? state : markStale(state, payload.directiveId);
    }
    case 'directive.activated': {
      const payload = payloadOf(DirectiveActivatedPayloadSchema, event);
      if (payload === undefined) return state;
      return (
        patch(state, payload.directiveId, (order) =>
          order.state === 'revoked'
            ? order
            : { ...order, state: 'active', updatedAt: Math.max(order.updatedAt, event.timestamp) },
        ) ?? markStale(state, payload.directiveId)
      );
    }
    case 'directive.expired': {
      const payload = payloadOf(DirectiveExpiredPayloadSchema, event);
      if (payload === undefined) return state;
      const moved = patch(state, payload.directiveId, (order) =>
        order.state === 'revoked'
          ? order
          : { ...order, state: 'expired', updatedAt: Math.max(order.updatedAt, event.timestamp) },
      );
      if (moved === undefined) return markStale(state, payload.directiveId);
      return { ...moved, expiring: without(moved.expiring, payload.directiveId) };
    }
    case 'directive.validity_changed': {
      const payload = payloadOf(DirectiveValidityChangedPayloadSchema, event);
      if (payload === undefined) return state;
      const moved = patch(state, payload.directiveId, (order) => {
        const dates = { startsAt: payload.startsAt, endsAt: payload.endsAt };
        return {
          ...order,
          ...dates,
          state:
            order.state === 'revoked'
              ? order.state
              : orderStateAt({ ...dates, revokedAt: order.revokedAt }, event.timestamp),
          updatedAt: Math.max(order.updatedAt, event.timestamp),
        };
      });
      if (moved === undefined) return markStale(state, payload.directiveId);
      // The end moved: the notice was for the old one.
      return { ...moved, expiring: without(moved.expiring, payload.directiveId) };
    }
    case 'directive.revoked': {
      const payload = payloadOf(DirectiveRevokedPayloadSchema, event);
      if (payload === undefined) return state;
      const moved = patch(state, payload.directiveId, (order) => ({
        ...order,
        state: 'revoked',
        revokedAt: payload.revokedAt,
        revokeReason: payload.reason,
        updatedAt: Math.max(order.updatedAt, event.timestamp),
      }));
      if (moved === undefined) return markStale(state, payload.directiveId);
      return { ...moved, expiring: without(moved.expiring, payload.directiveId) };
    }
    case 'directive.expiring': {
      const payload = payloadOf(DirectiveExpiringPayloadSchema, event);
      if (payload === undefined) return state;
      return {
        ...state,
        expiring: {
          ...state.expiring,
          [payload.directiveId]: { endsAt: payload.endsAt, noticeMs: payload.noticeMs },
        },
      };
    }
    default:
      return state;
  }
};

/** A snapshot: every order, replacing what was there. */
export function installOrders(orders: readonly ApiOrder[], lastEventId: number): OrdersState {
  return {
    loaded: true,
    lastEventId,
    stale: {},
    byId: Object.fromEntries([...orders].sort(bySeq).map((order) => [order.id, order])),
    expiring: {},
  };
}

/** The answer of a read of one order: the order, or `null` when it is gone (404). */
export function settleOrder(
  state: OrdersState,
  id: string,
  revision: number,
  order: ApiOrder | null,
): OrdersState {
  const next: OrdersState =
    order === null ? { ...state, byId: without(state.byId, id) } : put(state, order);
  return clearStale(next, id, revision);
}
