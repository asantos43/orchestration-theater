// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { chatFeedStore } from './chat-feed.js';
import { DECISION_KINDS } from './play-effects.js';

/**
 * The decorator that gives the chat WebSocket its events: `chat.ask` when a decision for the
 * Producer is created and `chat.ask_closed` when it is settled (P7 of docs/17, N179 item 2).
 */

let store: ReturnType<typeof chatFeedStore>;

beforeEach(async () => {
  store = chatFeedStore(new InMemoryStore({ clock: new FakeClock() }), createSilentLogger());
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play',
    name: 's1',
    folder: '/work/s1',
    baseBranch: 'main',
  });
});

const chatEvents = async () =>
  (await store.events.readFrom(0, 1000)).filter((event) => event.type.startsWith('chat.'));

const ANSWER = { answer: { answers: ['blue'] }, decidedBy: 'producer' as const };

describe('chatFeedStore, decisions of the Producer', () => {
  it('writes chat.ask when the decision is created, and chat.ask_closed when it is decided', async () => {
    await store.decisions.create({
      id: 'D1',
      scenarioId: 's1',
      kind: DECISION_KINDS.question,
      input: { questions: [] },
    });
    await store.decisions.decide('D1', ANSWER);
    const events = await chatEvents();
    expect(events.map((event) => event.type)).toEqual(['chat.ask', 'chat.ask_closed']);
    expect(events[1]).toMatchObject({
      scenarioId: 's1',
      payload: { decisionId: 'D1', kind: DECISION_KINDS.question, state: 'decided' },
    });
  });

  it('writes chat.ask_closed with the state cancelled when the decision is cancelled', async () => {
    await store.decisions.create({
      id: 'D1',
      scenarioId: 's1',
      kind: DECISION_KINDS.question,
      input: {},
    });
    await store.decisions.cancel('D1');
    expect((await chatEvents()).at(-1)).toMatchObject({
      type: 'chat.ask_closed',
      payload: { decisionId: 'D1', state: 'cancelled' },
    });
  });

  it('writes the same events when the calls are inside a transaction, and none if it rolls back', async () => {
    await store.transaction(async (tx) => {
      await tx.decisions.create({
        id: 'D1',
        scenarioId: 's1',
        kind: DECISION_KINDS.question,
        input: {},
      });
      await tx.decisions.decide('D1', ANSWER);
    });
    expect((await chatEvents()).map((event) => event.type)).toEqual([
      'chat.ask',
      'chat.ask_closed',
    ]);
    await expect(
      store.transaction(async (tx) => {
        await tx.decisions.create({
          id: 'D2',
          scenarioId: 's1',
          kind: DECISION_KINDS.question,
          input: {},
        });
        await tx.decisions.cancel('D2');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await chatEvents()).toHaveLength(2);
  });

  it('writes no event for a decision that is not the Producer’s, and none for a refused answer', async () => {
    await store.decisions.create({
      id: 'J1',
      scenarioId: 's1',
      kind: 'judge.script_review',
      input: {},
    });
    await store.decisions.decide('J1', { ...ANSWER, decidedBy: 'director' });
    expect(await chatEvents()).toEqual([]);

    await store.decisions.create({
      id: 'D1',
      scenarioId: 's1',
      kind: DECISION_KINDS.question,
      input: {},
    });
    await store.decisions.decide('D1', ANSWER);
    await expect(store.decisions.decide('D1', ANSWER)).rejects.toBeInstanceOf(Conflict);
    expect((await chatEvents()).map((event) => event.type)).toEqual([
      'chat.ask',
      'chat.ask_closed',
    ]);
  });
});
