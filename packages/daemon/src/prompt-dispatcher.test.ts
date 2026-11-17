// SPDX-License-Identifier: MPL-2.0
import type { PromptQueueItem, Store } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { seedReadTools } from './mcp/read-tools-fixture.js';
import { PromptDispatcher, type PromptDispatcherOptions } from './prompt-dispatcher.js';

/** A scenario to queue prompts for (the read-tools fixture has `s1` and `s2`). */
async function seededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore({ clock: new FakeClock(1_000) });
  await seedReadTools(store);
  return store;
}

function counterIds(): () => string {
  let n = 0;
  return () => `q${String(++n)}`;
}

function dispatcherOf(
  store: Store,
  extra: Partial<PromptDispatcherOptions> = {},
): PromptDispatcher {
  return new PromptDispatcher({ store, newId: counterIds(), ...extra });
}

const textOf = (item: PromptQueueItem): string =>
  typeof item.content.text === 'string' ? item.content.text : '';

const texts = (items: readonly PromptQueueItem[]): string[] => items.map(textOf);

/** A sender that records what it gets and holds the first prompt until `release()`. */
function gatedSender(): {
  sent: PromptQueueItem[];
  release: () => void;
  send: (item: PromptQueueItem) => Promise<void>;
  maxInFlight: () => number;
} {
  const sent: PromptQueueItem[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let inFlight = 0;
  let max = 0;
  return {
    sent,
    release: () => {
      open();
    },
    maxInFlight: () => max,
    send: async (item) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      sent.push(item);
      if (sent.length === 1) await gate;
      inFlight -= 1;
    },
  };
}

describe('PromptDispatcher: the Producer goes first', () => {
  it('sends the Producer message ahead of the notices that are waiting, never interrupting the one in flight', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    const sender = gatedSender();
    dispatcher.attach('s1', sender.send);
    await dispatcher.submit({ scenarioId: 's1', source: 'daemon', text: 'notice 1' });
    await dispatcher.submit({ scenarioId: 's1', source: 'daemon', text: 'notice 2' });
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'producer' });
    await dispatcher.submit({ scenarioId: 's1', source: 'daemon', text: 'notice 3' });
    // notice 1 was already being sent when the others arrived: it is not interrupted.
    sender.release();
    await dispatcher.idle('s1');
    expect(texts(sender.sent)).toEqual(['notice 1', 'producer', 'notice 2', 'notice 3']);
    expect(await store.promptQueue.list({ scenarioId: 's1', states: ['pending'] })).toEqual([]);
  });

  it('puts the Producer ahead of the Director and the schedule too, by the priority of the source', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    await dispatcher.submit({ scenarioId: 's1', source: 'daemon', text: 'daemon' });
    await dispatcher.submit({ scenarioId: 's1', source: 'schedule', text: 'schedule' });
    await dispatcher.submit({ scenarioId: 's1', source: 'director', text: 'director' });
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'producer 1' });
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'producer 2' });
    const sent: PromptQueueItem[] = [];
    dispatcher.attach('s1', (item) => {
      sent.push(item);
      return Promise.resolve();
    });
    await dispatcher.idle('s1');
    expect(texts(sent)).toEqual(['producer 1', 'producer 2', 'director', 'schedule', 'daemon']);
  });

  it('sends by arrival only with order: fifo', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store, { order: 'fifo' });
    await dispatcher.submit({ scenarioId: 's1', source: 'daemon', text: 'first' });
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'second' });
    // Even an explicit priority does not break the arrival order.
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'third', priority: 999 });
    const sent: PromptQueueItem[] = [];
    dispatcher.attach('s1', (item) => {
      sent.push(item);
      return Promise.resolve();
    });
    await dispatcher.idle('s1');
    expect(texts(sent)).toEqual(['first', 'second', 'third']);
    expect(new Set(sent.map((item) => item.priority))).toEqual(new Set([0]));
  });

  it('takes an explicit priority with producer_first', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'usual' });
    await dispatcher.submit({ scenarioId: 's1', source: 'daemon', text: 'urgent', priority: 500 });
    const sent: PromptQueueItem[] = [];
    dispatcher.attach('s1', (item) => {
      sent.push(item);
      return Promise.resolve();
    });
    await dispatcher.idle('s1');
    expect(texts(sent)).toEqual(['urgent', 'usual']);
  });
});

describe('PromptDispatcher: one at a time, written before delivered', () => {
  it('never has two prompts in flight in a scenario', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    const sender = gatedSender();
    dispatcher.attach('s1', sender.send);
    for (const text of ['a', 'b', 'c', 'd']) {
      await dispatcher.submit({ scenarioId: 's1', source: 'producer', text });
    }
    sender.release();
    await dispatcher.idle('s1');
    expect(sender.sent).toHaveLength(4);
    expect(sender.maxInFlight()).toBe(1);
  });

  it('keeps the scenarios apart', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    const forS1: PromptQueueItem[] = [];
    dispatcher.attach('s1', (item) => {
      forS1.push(item);
      return Promise.resolve();
    });
    await dispatcher.submit({ scenarioId: 's2', source: 'producer', text: 'for s2' });
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'for s1' });
    await dispatcher.idle('s1');
    expect(texts(forS1)).toEqual(['for s1']);
    // Nobody is attached to s2: its prompt waits in the queue.
    expect(texts(await store.promptQueue.list({ scenarioId: 's2', states: ['pending'] }))).toEqual([
      'for s2',
    ]);
  });

  it('writes the prompt before it hands it over and marks it delivered after the turn ends', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    const seenInStore: (string | undefined)[] = [];
    dispatcher.attach('s1', async (item) => {
      seenInStore.push((await store.promptQueue.get(item.id))?.state);
    });
    const item = await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'hi' });
    expect(item.state).toBe('pending');
    await dispatcher.idle('s1');
    expect(seenInStore).toEqual(['pending']);
    expect((await store.promptQueue.get(item.id))?.state).toBe('delivered');
  });

  it('holds what it cannot deliver yet: the prompt is in the store with no sender attached', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    const item = await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'wait' });
    expect((await store.promptQueue.get(item.id))?.state).toBe('pending');
    const sent: PromptQueueItem[] = [];
    const attached = dispatcher.attach('s1', (queued) => {
      sent.push(queued);
      return Promise.resolve();
    });
    await dispatcher.idle('s1');
    expect(texts(sent)).toEqual(['wait']);
    // A detached sender gets nothing more; the new prompt waits.
    attached.dispose();
    const later = await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'later' });
    await dispatcher.idle('s1');
    expect(texts(sent)).toEqual(['wait']);
    expect((await store.promptQueue.get(later.id))?.state).toBe('pending');
  });

  it('does not lose a prompt submitted from inside a turn', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    const sent: string[] = [];
    dispatcher.attach('s1', async (item) => {
      sent.push(textOf(item));
      if (sent.length === 1) {
        await dispatcher.submit({ scenarioId: 's1', source: 'daemon', text: 'follow-up' });
      }
    });
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'first' });
    await dispatcher.idle('s1');
    expect(sent).toEqual(['first', 'follow-up']);
  });

  it('keeps extra fields of the content beside the text', async () => {
    const store = await seededStore();
    const dispatcher = dispatcherOf(store);
    const item = await dispatcher.submit({
      scenarioId: 's1',
      source: 'producer',
      text: 'see file',
      extra: { attachmentId: 'a1' },
    });
    expect(item.content).toEqual({ attachmentId: 'a1', text: 'see file' });
  });
});

describe('PromptDispatcher: a failing sender', () => {
  it('leaves the prompt in the queue, says so, stops, and delivers it on the next try', async () => {
    const store = await seededStore();
    const errors: { error: unknown; id: string | undefined }[] = [];
    const dispatcher = dispatcherOf(store, {
      onError: (error, item) => errors.push({ error, id: item?.id }),
    });
    const boom = new Error('session is gone');
    const a = await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'a' });
    const b = await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'b' });
    dispatcher.attach('s1', () => Promise.reject(boom));
    await dispatcher.idle('s1');
    // Stopped at the first failure: nothing is retried in a loop, and `b` was not tried.
    expect(errors).toEqual([{ error: boom, id: a.id }]);
    expect((await store.promptQueue.get(a.id))?.state).toBe('pending');
    expect((await store.promptQueue.get(b.id))?.state).toBe('pending');

    const sent: PromptQueueItem[] = [];
    dispatcher.attach('s1', (item) => {
      sent.push(item);
      return Promise.resolve();
    });
    await dispatcher.idle('s1');
    expect(texts(sent)).toEqual(['a', 'b']);
  });

  it('says so when the store fails, and stops', async () => {
    const store = await seededStore();
    const failing: Pick<Store, 'promptQueue'> = {
      promptQueue: {
        enqueue: (input) => store.promptQueue.enqueue(input),
        get: (id) => store.promptQueue.get(id),
        list: (filter) => store.promptQueue.list(filter),
        markDelivered: (id) => store.promptQueue.markDelivered(id),
        next: () => Promise.reject(new Error('store closed')),
      },
    };
    const errors: unknown[] = [];
    const dispatcher = new PromptDispatcher({
      store: failing,
      newId: counterIds(),
      onError: (error) => errors.push(error),
    });
    await dispatcher.submit({ scenarioId: 's1', source: 'producer', text: 'x' });
    dispatcher.attach('s1', () => Promise.resolve());
    await dispatcher.idle('s1');
    expect(errors).toHaveLength(1);
  });
});

// A restart loses the dispatcher and keeps the store: a new dispatcher over the same store stands
// for the daemon after the restart. The same thing on a SQLite file is covered by the tests of the
// adapter, since the daemon only reaches adapters through compose.
describe('PromptDispatcher: a prompt in the queue survives a restart', () => {
  it('delivers after the restart what was written before it, the Producer first', async () => {
    const store = await seededStore();
    const before = dispatcherOf(store);
    await before.submit({ scenarioId: 's1', source: 'daemon', text: 'notice' });
    await before.submit({ scenarioId: 's1', source: 'producer', text: 'producer' });
    // `before` is gone (no sender was ever attached); only the store is left.
    const after = dispatcherOf(store);
    const sent: PromptQueueItem[] = [];
    after.attach('s1', (item) => {
      sent.push(item);
      return Promise.resolve();
    });
    await after.idle('s1');
    expect(texts(sent)).toEqual(['producer', 'notice']);
    expect(await store.promptQueue.list({ scenarioId: 's1', states: ['pending'] })).toEqual([]);
  });

  it('sends again the prompt whose turn was cut by the restart (at least once)', async () => {
    const store = await seededStore();
    const before = dispatcherOf(store);
    // The turn never ends: the daemon dies in the middle of it.
    before.attach('s1', () => new Promise<void>(() => undefined));
    const item = await before.submit({ scenarioId: 's1', source: 'producer', text: 'long turn' });
    expect((await store.promptQueue.get(item.id))?.state).toBe('pending');

    const after = new PromptDispatcher({ store, newId: counterIds() });
    const sent: PromptQueueItem[] = [];
    after.attach('s1', (queued) => {
      sent.push(queued);
      return Promise.resolve();
    });
    await after.idle('s1');
    expect(sent.map((queued) => queued.id)).toEqual([item.id]);
    expect((await store.promptQueue.get(item.id))?.state).toBe('delivered');
  });
});
