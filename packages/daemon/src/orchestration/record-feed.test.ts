// SPDX-License-Identifier: MPL-2.0
import { Conflict, type NewDemand } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { chatFeedStore } from './chat-feed.js';
import { recordFeedStore } from './record-feed.js';

/**
 * The decorator that gives the client stores their events (P1 of docs/18, N173): `decision.created`,
 * `decision.answered`, `demand.transitioned` and `scenario.archived`.
 */

let store: ReturnType<typeof recordFeedStore>;

const newDemand = (id: string): NewDemand => ({
  playId: 'p1',
  id,
  title: id,
  description: '',
  dependsOn: [],
  contract: { inputs: [], outputs: [] },
  expectedFiles: [],
  complexity: 'low',
  timeoutMin: 5,
  acceptanceCriteria: [],
  verify: [],
});

beforeEach(async () => {
  store = recordFeedStore(new InMemoryStore({ clock: new FakeClock() }), createSilentLogger());
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play',
    name: 's1',
    folder: '/work/s1',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: 'p1',
    scenarioId: 's1',
    need: 'n',
    flowId: 'play',
    flowVersion: 1,
    state: 'NEED',
  });
});

const recordEvents = async () =>
  (await store.events.readFrom(0, 1000)).filter((event) =>
    ['decision.created', 'decision.answered', 'scenario.archived', 'demand.transitioned'].includes(
      event.type,
    ),
  );

const ANSWER = { answer: { answers: ['blue'] }, decidedBy: 'producer' as const };

describe('recordFeedStore, decisions', () => {
  it('writes decision.created with the whole record and decision.answered on the answer', async () => {
    const created = await store.decisions.create({
      id: 'D1',
      scenarioId: 's1',
      playId: 'p1',
      kind: 'producer_question',
      input: { questions: [] },
    });
    const decided = await store.decisions.decide('D1', ANSWER);
    const events = await recordEvents();
    expect(events.map((event) => event.type)).toEqual(['decision.created', 'decision.answered']);
    expect(events[0]).toMatchObject({
      scenarioId: 's1',
      playId: 'p1',
      payload: { decision: created },
      timestamp: created.createdAt,
    });
    expect(events[1]).toMatchObject({
      scenarioId: 's1',
      playId: 'p1',
      payload: {
        decisionId: 'D1',
        kind: 'producer_question',
        state: 'decided',
        decidedBy: 'producer',
      },
      timestamp: decided.updatedAt,
    });
  });

  it('writes decision.answered with the state cancelled, and for a decision that is not the Producer’s', async () => {
    await store.decisions.create({
      id: 'J1',
      scenarioId: 's1',
      kind: 'judge.script_review',
      input: {},
    });
    await store.decisions.cancel('J1');
    const events = await recordEvents();
    expect(events.map((event) => event.type)).toEqual(['decision.created', 'decision.answered']);
    expect(events[0]).not.toHaveProperty('playId');
    expect(events[1]).toMatchObject({ payload: { state: 'cancelled', decidedBy: null } });
  });

  it('is atomic with the record: a rollback drops the events, a refused answer writes none', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.decisions.create({
          id: 'D2',
          scenarioId: 's1',
          kind: 'producer_question',
          input: {},
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await recordEvents()).toEqual([]);
    await store.decisions.create({
      id: 'D1',
      scenarioId: 's1',
      kind: 'producer_question',
      input: {},
    });
    await store.decisions.decide('D1', ANSWER);
    await expect(store.decisions.decide('D1', ANSWER)).rejects.toBeInstanceOf(Conflict);
    expect(await recordEvents()).toHaveLength(2);
  });

  it('writes decision.created before the chat.ask of the same decision when under chatFeedStore', async () => {
    const both = chatFeedStore(store, createSilentLogger());
    await both.decisions.create({
      id: 'D1',
      scenarioId: 's1',
      kind: 'producer_question',
      input: {},
    });
    const types = (await store.events.readFrom(0, 1000)).map((event) => event.type);
    expect(types.filter((type) => type === 'decision.created' || type === 'chat.ask')).toEqual([
      'decision.created',
      'chat.ask',
    ]);
  });
});

describe('recordFeedStore, demands', () => {
  it('writes demand.transitioned from null with the record at the birth, then only the states', async () => {
    const born = await store.demands.create(newDemand('a'));
    const moved = await store.demands.update('p1', 'a', { state: 'ready' });
    await store.demands.update('p1', 'a', { state: 'ready' });
    const events = await recordEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      scenarioId: 's1',
      playId: 'p1',
      payload: { playId: 'p1', demandId: 'a', from: null, to: 'pending', demand: born },
      timestamp: born.createdAt,
    });
    expect(events[1]).toMatchObject({
      scenarioId: 's1',
      playId: 'p1',
      payload: { playId: 'p1', demandId: 'a', from: 'pending', to: 'ready' },
      timestamp: moved.updatedAt,
    });
    expect(events[1]?.payload).not.toHaveProperty('demand');
  });

  it('writes the same events inside a transaction', async () => {
    await store.transaction(async (tx) => {
      await tx.demands.create(newDemand('a'));
      await tx.demands.update('p1', 'a', { state: 'running' });
    });
    expect((await recordEvents()).map((event) => event.payload.to)).toEqual(['pending', 'running']);
  });
});

describe('recordFeedStore, scenarios', () => {
  it('writes scenario.archived when the scenario goes from active to archived, once', async () => {
    await store.scenarios.update('s1', { name: 'renamed' });
    expect(await recordEvents()).toEqual([]);
    const archived = await store.scenarios.update('s1', { state: 'archived' });
    await store.scenarios.update('s1', { state: 'archived' });
    const events = await recordEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'scenario.archived',
      scenarioId: 's1',
      payload: { scenarioId: 's1' },
      timestamp: archived.updatedAt,
    });
  });
});
