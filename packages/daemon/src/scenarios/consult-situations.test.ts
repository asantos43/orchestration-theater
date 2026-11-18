// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { ToolFailure } from '../mcp/handlers.js';
import { ConsultService, type ConsultServiceOptions } from './consult.js';

/**
 * The consultation with stubs (P24, N146): what the consultant did is not the subject, only what
 * the daemon says when the worktree of the consultant could not be removed.
 */
describe('ConsultService: scenario.notice consult_worktree_stayed', () => {
  async function rig(removeWorktree: () => Promise<void>) {
    const store = new InMemoryStore({ clock: new FakeClock() });
    await store.scenarios.create({
      id: 'chat-1',
      kind: 'chat',
      flowId: 'chat',
      name: 'talk',
      folder: '/work/talk',
      baseBranch: 'main',
    });
    const service = new ConsultService({
      store,
      vcs: { headOf: () => Promise.resolve('abc123'), removeWorktree },
      // A consultation that ended without an answer: the work is dropped, which removes the worktree.
      runner: {
        run: () =>
          Promise.resolve({
            attemptId: 'chat-1/consult-1/1',
            state: 'failed',
            cause: 'the session died',
            branch: 'attempt/consult-1',
            worktree: '/work/talk/.worktrees/consult-1',
          }),
      },
      adapters: { adapterOf: () => undefined },
      registries: { tools: { list: () => [] } },
      prompts: { get: () => Promise.resolve('') },
      config: parseConfig(''),
      paths: { profiles: '/profiles' },
      attachments: {},
      chatFlow: { sync: () => Promise.resolve() },
      selection: {
        once: () =>
          Promise.resolve({
            kind: 'selected',
            profile: { id: 'fake/one' },
            settings: {},
          }),
      },
      logger: createSilentLogger(),
    } as unknown as ConsultServiceOptions);
    return { store, service };
  }

  const noticesOf = async (store: InMemoryStore) =>
    (await store.events.readFrom(0, 1000)).filter((event) => event.type === 'scenario.notice');

  it('a worktree that cannot be removed is an event of the scenario, and the consultation ends as it would', async () => {
    const { store, service } = await rig(() => Promise.reject(new Error('worktree is locked')));
    const result = await service.consult('chat-1', { question: 'what now?' });
    expect(result).toBeInstanceOf(ToolFailure);
    expect((result as ToolFailure).message).toContain('the session died');
    const notices = await noticesOf(store);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      scenarioId: 'chat-1',
      payload: {
        scenarioId: 'chat-1',
        kind: 'consult_worktree_stayed',
        subject: 'attempt/consult-1',
        detail: 'worktree is locked',
      },
    });
  });

  it('a worktree that is removed writes nothing', async () => {
    const { store, service } = await rig(() => Promise.resolve());
    await service.consult('chat-1', { question: 'what now?' });
    expect(await noticesOf(store)).toEqual([]);
  });
});
