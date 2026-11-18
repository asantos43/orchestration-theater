// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { IdeaQueueService, type IdeaQueueServiceOptions } from './service.js';

/**
 * The idea queue with stubs (P24, N146): the Author and the plays are never touched (`drain:
 * manual`, an empty queue), only what the daemon says about a key it ignored or an idea it could
 * not give back.
 */
async function rig(overrides: Record<string, unknown> = {}) {
  const store = new InMemoryStore({ clock: new FakeClock() });
  await store.scenarios.create({
    id: 's1',
    kind: 'chat',
    flowId: 'chat',
    name: 'talk',
    folder: '/work/talk',
    baseBranch: 'main',
    configOverride: overrides as never,
  });
  const make = (withStore: unknown) =>
    new IdeaQueueService({
      store: withStore,
      config: parseConfig('ideas:\n  drain: manual\n'),
      logger: createSilentLogger(),
    } as unknown as IdeaQueueServiceOptions);
  return { store, make };
}

const noticesOf = async (store: InMemoryStore) =>
  (await store.events.readFrom(0, 1000)).filter((event) => event.type === 'scenario.notice');

describe('IdeaQueueService: scenario.notice', () => {
  it('ideas_setting_ignored: a key ideas.* of the scenario that is not used is an event, naming the key', async () => {
    const { store, make } = await rig({ 'ideas.max_per_play': 0, 'ideas.drain': 'auto' });
    await make(store).drain('s1');
    const found = await noticesOf(store);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      scenarioId: 's1',
      payload: {
        scenarioId: 's1',
        kind: 'ideas_setting_ignored',
        subject: null,
        detail: expect.stringContaining('ideas.max_per_play') as string,
      },
    });
  });

  it('a scenario with usable keys writes no notice', async () => {
    const { store, make } = await rig({ 'ideas.max_per_play': 2 });
    await make(store).drain('s1');
    expect(await noticesOf(store)).toEqual([]);
  });

  it('idea_not_returned: an idea of a lost group that could not go back to the queue is an event of its scenario', async () => {
    const { store, make } = await rig();
    const lost = await store.ideas.create({ scenarioId: 's1', text: 'stuck' });
    await store.ideas.transition(lost.id, 'grouped', { groupId: 'grp-lost', groupOrder: 1 });
    // The queue cannot write the idea back: its `transition` fails, the rest of the store works.
    const ideas = new Proxy(store.ideas, {
      get(target, property): unknown {
        if (property === 'transition') return () => Promise.reject(new Error('disk full'));
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flaky = new Proxy(store, {
      get(target, property): unknown {
        if (property === 'ideas') return ideas;
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await make(flaky).settle();
    const found = await noticesOf(store);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      scenarioId: 's1',
      payload: {
        scenarioId: 's1',
        kind: 'idea_not_returned',
        subject: lost.id,
        detail: 'disk full',
      },
    });
  });
});
