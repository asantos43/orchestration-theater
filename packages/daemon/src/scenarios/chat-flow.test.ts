// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { CHAT_DECISION_KINDS, ChatFlow } from './chat-flow.js';

let store: InMemoryStore;

beforeEach(async () => {
  store = new InMemoryStore({ clock: new FakeClock() });
  await store.scenarios.create({
    id: 'c1',
    kind: 'chat',
    flowId: 'chat',
    name: 'c1',
    folder: '/x',
  });
  await store.scenarios.create({
    id: 'p1',
    kind: 'project',
    flowId: 'play',
    name: 'p1',
    folder: '/y',
  });
});

function flow(): ChatFlow {
  return new ChatFlow({ store, logger: createSilentLogger() });
}

async function moves(scenarioId: string): Promise<string[]> {
  return (await store.events.readFrom(0, 1000))
    .filter((e) => e.type === 'scenario.chat_transitioned' && e.scenarioId === scenarioId)
    .map((e) => {
      const p = e.payload as { from: string; to: string; cause: string };
      return `${p.from}>${p.to}:${p.cause}`;
    });
}

describe('the chat flow state', () => {
  it('is IDLE with nothing pending, CONSULTING on a consultation, AWAITING_PRODUCER on a question', async () => {
    const chat = flow();
    expect(await chat.stateOf('c1')).toBe('IDLE');
    await store.decisions.create({
      id: 'c1:consult:1',
      scenarioId: 'c1',
      kind: CHAT_DECISION_KINDS.consult,
      input: { question: 'q' },
    });
    expect(await chat.stateOf('c1')).toBe('CONSULTING');
    await store.decisions.decide('c1:consult:1', { answer: {}, decidedBy: 'daemon' });
    expect(await chat.stateOf('c1')).toBe('IDLE');
    await store.decisions.create({
      id: 'c1:ask:1',
      scenarioId: 'c1',
      kind: 'producer_question',
      input: {},
    });
    expect(await chat.stateOf('c1')).toBe('AWAITING_PRODUCER');
  });

  it('is rehydrated from the store by a new instance', async () => {
    await store.decisions.create({
      id: 'c1:consult:1',
      scenarioId: 'c1',
      kind: CHAT_DECISION_KINDS.consult,
      input: {},
    });
    expect(await flow().stateOf('c1')).toBe('CONSULTING');
  });
});

describe('sync', () => {
  it('records each move once, and nothing when the state did not change', async () => {
    const chat = flow();
    expect(await chat.sync('c1', 'noop')).toBe('IDLE');
    await store.decisions.create({
      id: 'c1:consult:1',
      scenarioId: 'c1',
      kind: CHAT_DECISION_KINDS.consult,
      input: {},
    });
    await chat.sync('c1', 'consult', { decisionId: 'c1:consult:1', executor: 'fake/one' });
    await chat.sync('c1', 'again');
    await store.decisions.decide('c1:consult:1', { answer: {}, decidedBy: 'daemon' });
    await chat.sync('c1', 'consult_answered');
    expect(await moves('c1')).toEqual([
      'IDLE>CONSULTING:consult',
      'CONSULTING>IDLE:consult_answered',
    ]);
  });

  it('picks up from the event log after a restart', async () => {
    await store.decisions.create({
      id: 'c1:consult:1',
      scenarioId: 'c1',
      kind: CHAT_DECISION_KINDS.consult,
      input: {},
    });
    await flow().sync('c1', 'consult');
    // A new instance has no memory: it must not write IDLE>CONSULTING again.
    await flow().sync('c1', 'after restart');
    await store.decisions.decide('c1:consult:1', { answer: {}, decidedBy: 'daemon' });
    await flow().sync('c1', 'consult_answered');
    expect(await moves('c1')).toEqual([
      'IDLE>CONSULTING:consult',
      'CONSULTING>IDLE:consult_answered',
    ]);
  });

  it('never touches a scenario of another flow', async () => {
    await store.decisions.create({
      id: 'p1:ask:1',
      scenarioId: 'p1',
      kind: 'producer_question',
      input: {},
    });
    expect(await flow().sync('p1', 'ask_producer')).toBe('IDLE');
    expect(await moves('p1')).toEqual([]);
  });
});
