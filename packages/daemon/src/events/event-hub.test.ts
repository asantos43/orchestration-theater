// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  type EventEnvelope,
  type EventLog,
  type NewEvent,
  type Store,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import { validateEventsOf } from '../event-validation.js';
import { buildDaemonRegistries } from '../registries.js';
import { captureLogger } from '../test-helpers.js';
import { createEventHub, type EventHub, type FollowOptions } from './event-hub.js';

function tick(n: number, extra: Partial<NewEvent> = {}): NewEvent {
  return { type: 'test.tick', schemaVersion: 1, payload: { n }, ...extra };
}

function setup(bufferEvents = 1000, base?: (store: InMemoryStore) => Store) {
  const memory = new InMemoryStore({ clock: new FakeClock(Date.UTC(2026, 10, 19, 12)) });
  const inner = base === undefined ? memory : base(memory);
  const { logger, lines } = captureLogger();
  const hub = createEventHub(inner, { bufferEvents, logger });
  return { memory, inner, hub, store: hub.store, lines };
}

/** Lets the pending promises and the timers of the process run. */
async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Takes `count` events from `iterable`, then stops it. */
async function take(
  iterable: AsyncIterable<EventEnvelope>,
  count: number,
): Promise<EventEnvelope[]> {
  const received: EventEnvelope[] = [];
  if (count === 0) return received;
  for await (const event of iterable) {
    received.push(event);
    if (received.length >= count) break;
  }
  return received;
}

function ids(events: readonly EventEnvelope[]): number[] {
  return events.map((event) => event.id);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function followOf(hub: EventHub, options: Partial<FollowOptions> = {}) {
  const controller = new AbortController();
  const iterable = hub.follow({ signal: controller.signal, ...options });
  return { controller, iterable };
}

describe('announcing', () => {
  it('announces an append outside a transaction, once it resolved', async () => {
    const { store, memory, hub } = setup();
    const { controller, iterable } = followOf(hub);
    const reads = vi.spyOn(memory.events, 'readFrom');
    const received = take(iterable, 1);
    await settle();
    const before = reads.mock.calls.length;
    const stored = await store.events.append(tick(1));
    expect(ids(await received)).toEqual([stored.id]);
    expect(reads.mock.calls.length).toBeGreaterThan(before);
    controller.abort();
  });

  it('announces the events of a transaction together, only after the commit', async () => {
    const { store, hub } = setup();
    const { controller, iterable } = followOf(hub);
    const received = take(iterable, 3);
    await settle();
    let seenInside: EventEnvelope[] | undefined;
    await store.transaction(async (tx) => {
      await tx.events.append(tick(1));
      await tx.events.append(tick(2));
      await tx.events.append(tick(3));
      await settle();
      // Nothing is visible, and the subscriber has nothing, until the commit.
      seenInside = [...(await store.events.readFrom(0, 10))];
    });
    expect(seenInside).toEqual([]);
    expect(ids(await received)).toEqual([1, 2, 3]);
    controller.abort();
  });

  it('announces nothing for a transaction that is rolled back', async () => {
    const { store, memory, hub } = setup();
    const { controller, iterable } = followOf(hub);
    const received = take(iterable, 1);
    await settle();
    const reads = vi.spyOn(memory.events, 'readFrom');
    const failure = new Error('boom');
    await expect(
      store.transaction(async (tx) => {
        await tx.events.append(tick(1));
        await tx.events.append(tick(2));
        throw failure;
      }),
    ).rejects.toBe(failure);
    await settle();
    expect(reads).not.toHaveBeenCalled();
    const sentinel = await store.events.append(tick(3));
    expect(ids(await received)).toEqual([sentinel.id]);
    controller.abort();
  });

  it('announces nothing for an event the registry refuses (validation outside the hub)', async () => {
    const { store, memory, hub } = setup();
    const { logger } = captureLogger();
    const validated = validateEventsOf(store, {
      registry: buildDaemonRegistries().events,
      unknownType: 'reject',
      logger,
    });
    const { controller, iterable } = followOf(hub);
    const received = take(iterable, 1);
    await settle();
    const reads = vi.spyOn(memory.events, 'readFrom');
    await expect(validated.events.append(tick(1))).rejects.toThrow(InvalidInput);
    await settle();
    expect(reads).not.toHaveBeenCalled();
    await validated.events.append({
      type: 'daemon.stopped',
      schemaVersion: 1,
      payload: { reason: 'signal', uptimeMs: 5 },
    });
    expect(await received).toHaveLength(1);
    controller.abort();
  });

  it('keeps everything else of the store working through the decorator', async () => {
    const { store, memory } = setup();
    await store.transaction(async (tx) => {
      await tx.events.append(tick(1));
    });
    await expect(memory.events.lastId()).resolves.toBe(1);
    await expect(store.events.lastId()).resolves.toBe(1);
    await store.close();
    await expect(store.events.lastId()).rejects.toThrow();
  });
});

describe('follow: order and completeness', () => {
  it('delivers every event in order with concurrent appends and transactions', async () => {
    const { store, hub } = setup();
    const { controller, iterable } = followOf(hub, { afterId: 0, pageSize: 25 });
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 150; i += 1) writes.push(store.events.append(tick(i)));
    for (let i = 0; i < 20; i += 1) {
      writes.push(
        store.transaction(async (tx) => {
          await tx.events.append(tick(1000 + i));
          await tx.events.append(tick(2000 + i));
          await tx.events.append(tick(3000 + i));
        }),
      );
    }
    // A few transactions that are rolled back in the middle of the others.
    for (let i = 0; i < 10; i += 1) {
      writes.push(
        store
          .transaction(async (tx) => {
            await tx.events.append(tick(9000 + i));
            throw new Error('rollback');
          })
          .catch(() => undefined),
      );
    }
    const received = await take(iterable, 210);
    await Promise.all(writes);
    const stored = await store.events.readFrom(0, 1000);
    expect(ids(received)).toEqual(ids(stored));
    expect(received).toHaveLength(210);
    expect(ids(received)).toEqual([...ids(received)].sort((a, b) => a - b));
    expect(new Set(ids(received)).size).toBe(210);
    // The three events of a transaction are adjacent in the log: a transaction is never split.
    const byN = new Map(received.map((event) => [event.payload.n, event.id]));
    for (let i = 0; i < 20; i += 1) {
      expect(byN.get(2000 + i)).toBe((byN.get(1000 + i) ?? 0) + 1);
      expect(byN.get(3000 + i)).toBe((byN.get(1000 + i) ?? 0) + 2);
    }
    controller.abort();
  });

  it('delivers each id once and in order when 1000 events are written during the hand-over', async () => {
    const { store, hub } = setup();
    for (let i = 0; i < 1000; i += 1) await store.events.append(tick(i));
    const { controller, iterable } = followOf(hub, { afterId: 0, pageSize: 50 });
    const reader = take(iterable, 2000);
    const writer = (async () => {
      for (let i = 0; i < 1000; i += 1) {
        await store.events.append(tick(1000 + i));
        if (i % 7 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    const [received] = await Promise.all([reader, writer]);
    expect(ids(received)).toEqual(range(1, 2000));
    controller.abort();
  });

  it('never assumes id === previous + 1: it survives holes in the ids', async () => {
    // A log that burns an id before every third event, as a rolled-back write of a real adapter may.
    const { store, hub } = setup(1000, (memory) => {
      let count = 0;
      const events: EventLog = {
        append: async (event) => {
          count += 1;
          if (count % 3 === 0) await memory.events.append({ ...tick(0), type: 'test.burned' });
          return memory.events.append(event);
        },
        readFrom: async (afterId, limit) =>
          (await memory.events.readFrom(afterId, limit * 2))
            .filter((event) => event.type !== 'test.burned')
            .slice(0, limit),
        lastId: () => memory.events.lastId(),
      };
      return new Proxy(memory, {
        get: (target, property) =>
          property === 'events' ? events : (Reflect.get(target, property, target) as unknown),
      });
    });
    const { controller, iterable } = followOf(hub, { afterId: 0, pageSize: 4 });
    const reader = take(iterable, 40);
    for (let i = 0; i < 40; i += 1) {
      await store.events.append(tick(i));
      if (i % 5 === 0) await settle(1);
    }
    const received = await reader;
    expect(received.map((event) => event.payload.n)).toEqual(range(0, 39));
    const receivedIds = ids(received);
    expect(new Set(receivedIds).size).toBe(40);
    expect(receivedIds).toEqual([...receivedIds].sort((a, b) => a - b));
    // There really are holes.
    expect(receivedIds[39]).toBeGreaterThan(40);
    controller.abort();
  });

  it('starts from the current lastId when afterId is omitted (no history)', async () => {
    const { store, hub } = setup();
    for (let i = 0; i < 3; i += 1) await store.events.append(tick(i));
    const { controller, iterable } = followOf(hub);
    const received = take(iterable, 2);
    await settle();
    await store.events.append(tick(10));
    await store.events.append(tick(11));
    expect(ids(await received)).toEqual([4, 5]);
    controller.abort();
  });

  it('resumes from a cursor: the history after it comes first, then the live events', async () => {
    const { store, hub } = setup();
    for (let i = 0; i < 6; i += 1) await store.events.append(tick(i));
    const { controller, iterable } = followOf(hub, { afterId: 3, pageSize: 2 });
    const received = take(iterable, 5);
    await settle();
    await store.events.append(tick(6));
    await store.events.append(tick(7));
    expect(ids(await received)).toEqual([4, 5, 6, 7, 8]);
    controller.abort();
  });

  it('rejects an invalid cursor or page size with InvalidInput', async () => {
    const { hub } = setup();
    const { iterable } = followOf(hub, { afterId: -1 });
    await expect(take(iterable, 1)).rejects.toThrow(InvalidInput);
    const { iterable: bad } = followOf(hub, { pageSize: 0 });
    await expect(take(bad, 1)).rejects.toThrow(InvalidInput);
    expect(hub.subscriberCount).toBe(0);
  });
});

describe('follow: filter', () => {
  it('lets through only the events of the scenario and the type prefixes asked', async () => {
    const { store, hub } = setup();
    await store.events.append(tick(1, { scenarioId: 'sc-a', type: 'play.created' }));
    await store.events.append(tick(2, { scenarioId: 'sc-b', type: 'play.created' }));
    await store.events.append(tick(3, { type: 'play.created' }));
    await store.events.append(tick(4, { scenarioId: 'sc-a', type: 'quota.changed' }));
    await store.events.append(tick(5, { scenarioId: 'sc-a', type: 'play.updated' }));
    const { controller, iterable } = followOf(hub, {
      afterId: 0,
      filter: { scenarioIds: ['sc-a'], typePrefixes: ['play.', 'usage.'] },
    });
    const received = take(iterable, 4);
    await settle();
    await store.events.append(tick(6, { scenarioId: 'sc-b', type: 'play.updated' }));
    await store.events.append(tick(7, { scenarioId: 'sc-a', type: 'usage.recorded' }));
    await store.events.append(tick(8, { type: 'play.updated' }));
    await store.events.append(tick(9, { scenarioId: 'sc-a', type: 'play.updated' }));
    const got = await received;
    expect(got.map((event) => event.payload.n)).toEqual([1, 5, 7, 9]);
    expect(got.every((event) => event.scenarioId === 'sc-a')).toBe(true);
    controller.abort();
  });

  it('treats an empty list as no restriction', async () => {
    const { store, hub } = setup();
    await store.events.append(tick(1, { scenarioId: 'sc-a' }));
    await store.events.append(tick(2));
    const { iterable } = followOf(hub, {
      afterId: 0,
      filter: { scenarioIds: [], typePrefixes: [] },
    });
    expect(ids(await take(iterable, 2))).toEqual([1, 2]);
  });

  it('keeps the cursor moving by the global id over the events the filter drops', async () => {
    const { store, memory, hub } = setup();
    for (let i = 0; i < 10; i += 1) await store.events.append(tick(i, { scenarioId: 'sc-b' }));
    const reads = vi.spyOn(memory.events, 'readFrom');
    const { controller, iterable } = followOf(hub, {
      afterId: 0,
      pageSize: 5,
      filter: { scenarioIds: ['sc-a'] },
    });
    const received = take(iterable, 1);
    await settle();
    // Two full pages of dropped events, then an empty read: the cursor went 0, 5, 10.
    expect(reads.mock.calls.map((call) => call[0])).toEqual([0, 5, 10]);
    await store.events.append(tick(10, { scenarioId: 'sc-a' }));
    expect(ids(await received)).toEqual([11]);
    expect(reads.mock.calls.at(-1)?.[0]).toBe(10);
    controller.abort();
  });

  it('does not wake a subscriber for an event its filter drops', async () => {
    const { store, memory, hub } = setup();
    const { controller, iterable } = followOf(hub, {
      afterId: 0,
      filter: { scenarioIds: ['sc-a'] },
    });
    const received = take(iterable, 1);
    await settle();
    const reads = vi.spyOn(memory.events, 'readFrom');
    await store.events.append(tick(1, { scenarioId: 'sc-b' }));
    await settle();
    expect(reads).not.toHaveBeenCalled();
    await store.events.append(tick(2, { scenarioId: 'sc-a' }));
    expect(ids(await received)).toEqual([2]);
    controller.abort();
  });
});

describe('follow: slow subscribers and the buffer', () => {
  it('does not hold the append of anybody, and recovers from the log after the overflow', async () => {
    const { store, hub, lines } = setup(10);
    const { controller, iterable } = followOf(hub, { afterId: 0, pageSize: 100 });
    const iterator = iterable[Symbol.asyncIterator]();
    // A second, fast subscriber, to prove the slow one does not hurt it.
    const fast = followOf(hub, { afterId: 0, pageSize: 100 });
    const fastReader = take(fast.iterable, 3000);
    await store.events.append(tick(0));
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // The slow subscriber is now suspended at its first event and never pulls during the writes.
    const writes: Promise<unknown>[] = [];
    for (let i = 1; i < 3000; i += 1) writes.push(store.events.append(tick(i)));
    await Promise.all(writes);
    expect(hub.subscriberCount).toBe(2);
    const overflows = lines.filter((line) => line.level === 'warn');
    expect(overflows).toHaveLength(1);
    expect(overflows[0]?.fields).toMatchObject({ bufferEvents: 10 });
    expect(ids(await fastReader)).toEqual(range(1, 3000));
    // Now it reads what it lost, from the log, with no gap and no repetition.
    const received: number[] = [(first.value as EventEnvelope).id];
    while (received.length < 3000) {
      const next = await iterator.next();
      if (next.done === true) break;
      received.push(next.value.id);
    }
    expect(received).toEqual(range(1, 3000));
    controller.abort();
    fast.controller.abort();
  });

  it('warns once per overflow episode, not once per event', async () => {
    const { store, hub, lines } = setup(5);
    const { controller, iterable } = followOf(hub, { afterId: 0 });
    const iterator = iterable[Symbol.asyncIterator]();
    await store.events.append(tick(0));
    await iterator.next();
    for (let i = 1; i < 200; i += 1) await store.events.append(tick(i));
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    controller.abort();
  });

  it('does not warn while the subscriber keeps up', async () => {
    const { store, hub, lines } = setup(5);
    const { controller, iterable } = followOf(hub, { afterId: 0 });
    const received = take(iterable, 100);
    for (let i = 0; i < 100; i += 1) {
      await store.events.append(tick(i));
      await settle(1);
    }
    expect(ids(await received)).toEqual(range(1, 100));
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(0);
    controller.abort();
  });

  it('refuses a buffer that is not a positive integer', () => {
    const memory = new InMemoryStore({ clock: new FakeClock(0) });
    const { logger } = captureLogger();
    expect(() => createEventHub(memory, { bufferEvents: 0, logger })).toThrow(InvalidInput);
    expect(() => createEventHub(memory, { bufferEvents: 1.5, logger })).toThrow(InvalidInput);
  });
});

describe('follow: release of the subscriber', () => {
  it('ends the iteration and releases the subscriber when the signal aborts while waiting', async () => {
    const { hub } = setup();
    const { controller, iterable } = followOf(hub, { afterId: 0 });
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    await settle();
    expect(hub.subscriberCount).toBe(1);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(hub.subscriberCount).toBe(0);
  });

  it('releases the subscriber at once when the signal aborts while the consumer is not pulling', async () => {
    const { store, hub } = setup();
    await store.events.append(tick(0));
    await store.events.append(tick(1));
    const { controller, iterable } = followOf(hub, { afterId: 0 });
    const iterator = iterable[Symbol.asyncIterator]();
    await iterator.next();
    expect(hub.subscriberCount).toBe(1);
    controller.abort();
    expect(hub.subscriberCount).toBe(0);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('ends at once for a signal that was already aborted', async () => {
    const { hub } = setup();
    const controller = new AbortController();
    controller.abort();
    const received = await take(hub.follow({ signal: controller.signal, afterId: 0 }), 1);
    expect(received).toEqual([]);
    expect(hub.subscriberCount).toBe(0);
  });

  it('releases the subscriber when the consumer stops with break or an error', async () => {
    const { store, hub } = setup();
    for (let i = 0; i < 3; i += 1) await store.events.append(tick(i));
    const { controller, iterable } = followOf(hub, { afterId: 0 });
    await take(iterable, 1);
    expect(hub.subscriberCount).toBe(0);
    await expect(
      (async () => {
        for await (const event of followOf(hub, { afterId: 0 }).iterable) {
          throw new Error(`stop at ${String(event.id)}`);
        }
      })(),
    ).rejects.toThrow('stop at 1');
    expect(hub.subscriberCount).toBe(0);
    controller.abort();
  });

  it('holds nothing for an iterable nobody iterates', () => {
    const { hub } = setup();
    followOf(hub, { afterId: 0 });
    expect(hub.subscriberCount).toBe(0);
  });

  it('leaves no subscriber behind after many iterations', async () => {
    const { store, hub } = setup();
    await store.events.append(tick(0));
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i += 1) {
      const { controller, iterable } = followOf(hub, { afterId: 0 });
      controllers.push(controller);
      pending.push(take(iterable, 2));
    }
    await settle();
    expect(hub.subscriberCount).toBe(50);
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    expect(hub.subscriberCount).toBe(0);
  });

  it('ends every iteration when the hub closes, and the log failing rejects it', async () => {
    const { hub } = setup();
    const { iterable } = followOf(hub, { afterId: 0 });
    const reader = take(iterable, 1);
    await settle();
    hub.close();
    await expect(reader).resolves.toEqual([]);
    expect(hub.subscriberCount).toBe(0);
    hub.close();

    const closed = setup();
    const { iterable: broken } = followOf(closed.hub, { afterId: 0 });
    await closed.store.close();
    await expect(take(broken, 1)).rejects.toThrow();
    expect(closed.hub.subscriberCount).toBe(0);
  });
});

describe('the config key api.sse.buffer_events', () => {
  it('defaults to 1000', () => {
    expect(parseConfig('').api.sse.buffer_events).toBe(1000);
    expect(parseConfig('api:\n  sse: {}\n').api.sse.buffer_events).toBe(1000);
  });

  it('takes a positive integer', () => {
    expect(parseConfig('api:\n  sse:\n    buffer_events: 50\n').api.sse.buffer_events).toBe(50);
  });

  it('refuses zero, a fraction, text and a misspelled key', () => {
    expect(() => parseConfig('api:\n  sse:\n    buffer_events: 0\n')).toThrow();
    expect(() => parseConfig('api:\n  sse:\n    buffer_events: 1.5\n')).toThrow();
    expect(() => parseConfig('api:\n  sse:\n    buffer_events: many\n')).toThrow();
    expect(() => parseConfig('api:\n  sse:\n    buffer_event: 5\n')).toThrow();
    expect(() => parseConfig('api:\n  other: 1\n')).toThrow();
  });
});
