// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { DaemonConfigSchema } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { OrchestrationHandlers, type OrchestrationRuntime } from './handlers.js';

let store: InMemoryStore;
let handlers: OrchestrationHandlers;

const QUESTIONS = {
  questions: [
    {
      header: 'Browser',
      question: 'Click "Buy"?',
      options: [
        { label: 'Allow', description: 'Let the click happen' },
        { label: 'Deny', description: 'Refuse' },
      ],
    },
  ],
} as never;

beforeEach(async () => {
  store = new InMemoryStore({ clock: new FakeClock() });
  await store.scenarios.create({
    id: 'c1',
    kind: 'chat',
    flowId: 'chat',
    name: 'c1',
    folder: '/x',
  });
  handlers = new OrchestrationHandlers();
});

function bind(): void {
  handlers.bind({
    store,
    config: DaemonConfigSchema.parse({}),
    logger: createSilentLogger(),
  } as unknown as OrchestrationRuntime);
}

describe('openApproval', () => {
  it('returns nothing while the daemon has no runtime (nobody can be asked)', async () => {
    expect(await handlers.openApproval('c1', QUESTIONS)).toBeUndefined();
  });

  it('opens a producer question and resolves with the answers the channel sends', async () => {
    bind();
    const opened = await handlers.openApproval('c1', QUESTIONS);
    expect(opened).toBeDefined();
    const pending = await store.decisions.get(opened!.decisionId);
    expect(pending?.kind).toBe('producer_question');
    expect(handlers.board.has(opened!.decisionId)).toBe(true);
    handlers.board.resolve(opened!.decisionId, { answers: [{ selected: ['Allow'] }] });
    await expect(opened!.answer).resolves.toEqual([{ selected: ['Allow'] }]);
  });

  it('cancels the decision and rejects when the daemon stops before the answer', async () => {
    bind();
    const opened = await handlers.openApproval('c1', QUESTIONS);
    handlers.board.abortAll('daemon stopping');
    await expect(opened!.answer).rejects.toThrow('daemon stopping');
    const decision = await store.decisions.get(opened!.decisionId);
    expect(decision?.status).not.toBe('pending');
  });
});
