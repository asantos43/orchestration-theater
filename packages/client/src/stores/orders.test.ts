// SPDX-License-Identifier: MPL-2.0
import { ApiClient } from '../client.js';
import type { Clock } from '../connection.js';
import { waitFor } from '../test-clock.test-support.js';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEvent, applyEvents } from './core.js';
import { DAEMON_ID, FakeDaemon, directiveCreated, event, order } from './fixtures.test-support.js';
import {
  initialOrders,
  installOrders,
  orderStateAt,
  ordersInOrder,
  reduceOrders,
  settleOrder,
} from './orders.js';
import { DaemonStores } from './sync.js';

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

describe('orders: a record never read by REST', () => {
  it('adds the order a created event carries, in the order given', () => {
    const state = applyEvents(
      initialOrders(),
      [directiveCreated(2, order('O2')), directiveCreated(3, order('O1'))],
      reduceOrders,
    );
    expect(ordersInOrder(state).map((item) => item.id)).toEqual(['O1', 'O2']);
    expect(state.stale).toEqual({});
  });

  it('marks the order stale when the created event has no record (an older log)', () => {
    const state = applyEvent(
      initialOrders(),
      directiveCreated(1, order('O1'), false),
      reduceOrders,
    );
    expect(state.byId).toEqual({});
    expect(state.stale).toEqual({ O1: 1 });
  });

  it('moves the state with activated, expired and revoked', () => {
    let state = installOrders([order('O1', { state: 'scheduled', startsAt: T0 + HOUR })], 5);
    state = applyEvent(
      state,
      event(6, 'directive.activated', { directiveId: 'O1', effectiveAt: T0 + HOUR }),
      reduceOrders,
    );
    expect(state.byId.O1?.state).toBe('active');
    state = applyEvent(
      state,
      event(7, 'directive.expired', { directiveId: 'O1', effectiveAt: T0 + 2 * HOUR }),
      reduceOrders,
    );
    expect(state.byId.O1?.state).toBe('expired');
    state = applyEvent(
      state,
      event(8, 'directive.revoked', { directiveId: 'O1', reason: 'not needed', revokedAt: T0 + 3 }),
      reduceOrders,
    );
    expect(state.byId.O1).toMatchObject({
      state: 'revoked',
      revokedAt: T0 + 3,
      revokeReason: 'not needed',
    });
    // An order that was revoked stays revoked, whatever comes after.
    state = applyEvent(
      state,
      event(9, 'directive.activated', { directiveId: 'O1', effectiveAt: T0 }),
      reduceOrders,
    );
    expect(state.byId.O1?.state).toBe('revoked');
    expect(state.stale).toEqual({});
  });

  it('takes the dates of an extension and the state they mean at the moment of the event', () => {
    const base = order('O1', { endsAt: T0 + 24 * HOUR });
    let state = installOrders([base], 1);
    // Event 2 happens at T0 + 2 ms (the fixtures stamp T0 + id): the new end is still ahead.
    state = applyEvent(
      state,
      event(2, 'directive.validity_changed', {
        directiveId: 'O1',
        startsAt: T0,
        endsAt: T0 + 48 * HOUR,
        previousStartsAt: T0,
        previousEndsAt: T0 + 24 * HOUR,
      }),
      reduceOrders,
    );
    expect(state.byId.O1).toMatchObject({ state: 'active', endsAt: T0 + 48 * HOUR });
    // Pushing the start into the future makes it scheduled, with no event of its own.
    state = applyEvent(
      state,
      event(3, 'directive.validity_changed', {
        directiveId: 'O1',
        startsAt: T0 + HOUR,
        endsAt: null,
        previousStartsAt: T0,
        previousEndsAt: T0 + 48 * HOUR,
      }),
      reduceOrders,
    );
    expect(state.byId.O1).toMatchObject({ state: 'scheduled', endsAt: null });
  });

  it('keeps the expiring notice until the end moves, passes or is revoked', () => {
    let state = installOrders([order('O1', { endsAt: T0 + 24 * HOUR })], 1);
    state = applyEvent(
      state,
      event(2, 'directive.expiring', {
        directiveId: 'O1',
        endsAt: T0 + 24 * HOUR,
        noticeMs: 3 * HOUR,
      }),
      reduceOrders,
    );
    expect(state.expiring.O1).toEqual({ endsAt: T0 + 24 * HOUR, noticeMs: 3 * HOUR });
    state = applyEvent(
      state,
      event(3, 'directive.validity_changed', {
        directiveId: 'O1',
        startsAt: T0,
        endsAt: null,
        previousStartsAt: T0,
        previousEndsAt: T0 + 24 * HOUR,
      }),
      reduceOrders,
    );
    expect(state.expiring).toEqual({});
  });

  it('marks an order it does not have stale, and the read settles it', () => {
    let state = applyEvent(
      initialOrders(),
      event(1, 'directive.revoked', { directiveId: 'O7', reason: 'x', revokedAt: T0 }),
      reduceOrders,
    );
    expect(state.stale).toEqual({ O7: 1 });
    state = settleOrder(state, 'O7', 1, order('O7', { state: 'revoked' }));
    expect(state.stale).toEqual({});
    expect(state.byId.O7?.state).toBe('revoked');
    // A 404 drops the order.
    state = settleOrder(state, 'O7', 1, null);
    expect(state.byId).toEqual({});
  });

  it('ignores an event already applied, and the ones that are not its business', () => {
    const first = directiveCreated(4, order('O1'));
    const state = applyEvent(initialOrders(), first, reduceOrders);
    expect(applyEvent(state, first, reduceOrders)).toBe(state);
    const other = event(5, 'play.created', {});
    expect(applyEvent(state, other, reduceOrders)).toBe(state);
  });

  it('says the state a validity means at a moment', () => {
    const window = { startsAt: 100, endsAt: 200, revokedAt: null };
    expect(orderStateAt(window, 50)).toBe('scheduled');
    expect(orderStateAt(window, 100)).toBe('active');
    expect(orderStateAt(window, 200)).toBe('expired');
    expect(orderStateAt({ ...window, revokedAt: 1 }, 150)).toBe('revoked');
  });
});

const hubs: DaemonStores[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

const clock: Clock = {
  async sleep(ms, signal) {
    if (ms === 123_456) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }
    if (signal?.aborted === true) return;
    await Promise.resolve();
  },
};

function hubOf(daemon: FakeDaemon): DaemonStores {
  const client = new ApiClient({
    url: 'http://127.0.0.1:1',
    token: 'test-token',
    daemonId: DAEMON_ID,
    fetch: daemon.fetch,
    timeoutMs: 0,
  });
  const hub = new DaemonStores(client, {
    clock,
    headTimeoutMs: 123_456,
    stream: { random: () => 0.5 },
  });
  hubs.push(hub);
  return hub;
}

const reads = (daemon: FakeDaemon): number =>
  daemon.requests.filter((request) => request.path.startsWith('/v1/orders')).length;

describe('DaemonStores: the orders', () => {
  it('reads every page of the orders once, and keeps them by the events with no other read', async () => {
    const daemon = new FakeDaemon();
    daemon.head = 3;
    daemon.orders = [order('O1'), order('O2', { scope: 'local', scenarioId: 'S1' })];
    const hub = hubOf(daemon);
    await hub.start();
    expect(ordersInOrder(hub.orders.getState()).map((item) => item.id)).toEqual(['O1', 'O2']);
    expect(hub.orders.getState()).toMatchObject({ loaded: true, lastEventId: 3 });
    const afterStart = reads(daemon);
    expect(afterStart).toBe(1);

    daemon.push(
      directiveCreated(4, order('O3', { startsAt: T0 + 5 * HOUR, state: 'scheduled' })),
      event(5, 'directive.revoked', { directiveId: 'O1', reason: 'done', revokedAt: T0 }),
    );
    await waitFor(() => hub.orders.getState().byId.O1?.state === 'revoked');
    expect(hub.orders.getState().byId.O3?.state).toBe('scheduled');
    await hub.whenIdle();
    expect(reads(daemon)).toBe(afterStart);
  });

  it('reads a single order when the event has no record', async () => {
    const daemon = new FakeDaemon();
    daemon.head = 1;
    const hub = hubOf(daemon);
    await hub.start();
    daemon.orders = [order('O9')];
    daemon.push(directiveCreated(2, order('O9'), false));
    await waitFor(() => hub.orders.getState().byId.O9 !== undefined);
    expect(daemon.requests.some((request) => request.path === '/v1/orders/O9')).toBe(true);
  });

  it('exposes the client the commands go through', async () => {
    const daemon = new FakeDaemon();
    const hub = hubOf(daemon);
    expect(hub.client).toBeInstanceOf(ApiClient);
  });
});
