// SPDX-License-Identifier: MPL-2.0
import type { NewIdea } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { expectCode, type AggregateHarness } from './aggregate-support.js';

export function sampleIdea(extra: Partial<NewIdea> = {}): NewIdea {
  return { scenarioId: 'scn-1', text: 'Add a dark theme', ...extra };
}

/** Registers the conformance tests of `store.ideas` (the idea queue of the scenario, N91). */
export function describeIdeaAggregatesConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Ideas conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create assigns I1, I2, I3 and stores the idea queued', async () => {
      const { store, clock } = harness();
      const first = await store.ideas.create(sampleIdea());
      expect(first).toEqual({
        id: 'I1',
        seq: 1,
        scenarioId: 'scn-1',
        text: 'Add a dark theme',
        area: null,
        source: 'chat',
        state: 'queued',
        groupId: null,
        groupOrder: null,
        playId: null,
        prNumber: null,
        prUrl: null,
        reason: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        closedAt: null,
      });
      const second = await store.ideas.create(
        sampleIdea({ text: 'Fix the footer', area: 'ui', source: 'import' }),
      );
      expect([second.id, second.area, second.source]).toEqual(['I2', 'ui', 'import']);
      expect(await store.ideas.get('I2')).toEqual(second);
      expect(await store.ideas.get('I9')).toBeUndefined();
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store } = harness();
      await expectCode(store.ideas.create(sampleIdea({ text: '' })), 'INVALID_INPUT');
      await expectCode(store.ideas.create(sampleIdea({ scenarioId: '' })), 'INVALID_INPUT');
      await expectCode(
        store.ideas.create({ scenarioId: 'scn-1', text: 'x', state: 'done' } as unknown as NewIdea),
        'INVALID_INPUT',
      );
      expect(await store.ideas.list()).toEqual([]);
    });

    it('list filters by scenario, state, play and group and orders by arrival', async () => {
      const { store } = harness();
      await store.ideas.create(sampleIdea({ text: 'a' }));
      await store.ideas.create(sampleIdea({ scenarioId: 'scn-2', text: 'b' }));
      await store.ideas.create(sampleIdea({ text: 'c' }));
      await store.ideas.transition('I1', 'grouped', { groupId: 'g1', groupOrder: 1 });
      await store.ideas.transition('I3', 'grouped', { groupId: 'g1', groupOrder: 2 });
      await store.ideas.transition('I1', 'grouped', { playId: 'play-1' });
      const ids = async (filter: Parameters<typeof store.ideas.list>[0]): Promise<string[]> =>
        (await store.ideas.list(filter)).map((idea) => idea.id);
      expect(await ids(undefined)).toEqual(['I1', 'I2', 'I3']);
      expect(await ids({ scenarioId: 'scn-1' })).toEqual(['I1', 'I3']);
      expect(await ids({ states: ['queued'] })).toEqual(['I2']);
      expect(await ids({ states: ['queued', 'grouped'], scenarioId: 'scn-1' })).toEqual([
        'I1',
        'I3',
      ]);
      expect(await ids({ groupId: 'g1' })).toEqual(['I1', 'I3']);
      expect(await ids({ playId: 'play-1' })).toEqual(['I1']);
    });

    it('queued -> grouped -> done walks the lifecycle and links the play and the PR', async () => {
      const { store, clock } = harness();
      await store.ideas.create(sampleIdea());
      const grouped = await store.ideas.transition('I1', 'grouped', {
        groupId: 'g1',
        groupOrder: 1,
      });
      expect(grouped).toMatchObject({
        state: 'grouped',
        groupId: 'g1',
        groupOrder: 1,
        playId: null,
      });
      const withPlay = await store.ideas.transition('I1', 'grouped', { playId: 'play-1' });
      expect(withPlay).toMatchObject({ groupId: 'g1', groupOrder: 1, playId: 'play-1' });
      const done = await store.ideas.transition('I1', 'done', {
        pullRequest: { number: 7, url: 'https://example.test/pr/7' },
      });
      expect(done).toMatchObject({
        state: 'done',
        playId: 'play-1',
        prNumber: 7,
        prUrl: 'https://example.test/pr/7',
        closedAt: clock.now(),
      });
      expect(await store.ideas.get('I1')).toEqual(done);
    });

    it('done without a play is InvalidInput; done without a PR keeps the PR null', async () => {
      const { store } = harness();
      await store.ideas.create(sampleIdea());
      await store.ideas.create(sampleIdea({ text: 'other' }));
      await store.ideas.transition('I1', 'grouped', { groupId: 'g1', groupOrder: 1 });
      await expectCode(store.ideas.transition('I1', 'done'), 'INVALID_INPUT');
      await store.ideas.transition('I2', 'grouped', { groupId: 'g1', groupOrder: 2 });
      const done = await store.ideas.transition('I2', 'done', { playId: 'play-9' });
      expect(done).toMatchObject({ playId: 'play-9', prNumber: null, prUrl: null });
    });

    it('discarded and deferred need a reason; discarded is final, deferred can come back', async () => {
      const { store, clock } = harness();
      await store.ideas.create(sampleIdea());
      await store.ideas.create(sampleIdea({ text: 'b' }));
      await expectCode(store.ideas.transition('I1', 'discarded'), 'INVALID_INPUT');
      await expectCode(store.ideas.transition('I1', 'deferred', {}), 'INVALID_INPUT');
      const discarded = await store.ideas.transition('I1', 'discarded', { reason: 'duplicate' });
      expect(discarded).toMatchObject({
        state: 'discarded',
        reason: 'duplicate',
        closedAt: clock.now(),
      });
      await expectCode(store.ideas.transition('I1', 'queued'), 'CONFLICT');

      const deferred = await store.ideas.transition('I2', 'deferred', { reason: 'later' });
      expect(deferred).toMatchObject({ state: 'deferred', reason: 'later', closedAt: null });
      const back = await store.ideas.transition('I2', 'queued');
      expect(back).toMatchObject({ state: 'queued', reason: null });
    });

    it('back to queued clears the group, the play and the PR and keeps the reason', async () => {
      const { store } = harness();
      await store.ideas.create(sampleIdea());
      await store.ideas.transition('I1', 'grouped', {
        groupId: 'g1',
        groupOrder: 1,
        playId: 'play-1',
      });
      const back = await store.ideas.transition('I1', 'queued', { reason: 'play cancelled' });
      expect(back).toMatchObject({
        state: 'queued',
        groupId: null,
        groupOrder: null,
        playId: null,
        prNumber: null,
        prUrl: null,
        reason: 'play cancelled',
        closedAt: null,
      });
    });

    it('a move outside the lifecycle is Conflict and an unknown id is NotFound', async () => {
      const { store } = harness();
      await store.ideas.create(sampleIdea());
      await expectCode(store.ideas.transition('I1', 'done', { playId: 'p' }), 'CONFLICT');
      await expectCode(store.ideas.transition('I1', 'queued'), 'CONFLICT');
      await expectCode(store.ideas.transition('I1', 'grouped', { groupId: 'g1' }), 'INVALID_INPUT');
      await expectCode(
        store.ideas.transition('I1', 'grouped', { groupId: 'g1', groupOrder: 0 }),
        'INVALID_INPUT',
      );
      await expectCode(store.ideas.transition('I9', 'discarded', { reason: 'x' }), 'NOT_FOUND');
      expect((await store.ideas.get('I1'))?.state).toBe('queued');
    });

    it('inside a transaction reads see the writes and a rollback drops them', async () => {
      const { store } = harness();
      const failure = new Error('boom');
      const error = await store
        .transaction(async (tx) => {
          await tx.ideas.create(sampleIdea());
          expect((await tx.ideas.list()).map((idea) => idea.id)).toEqual(['I1']);
          throw failure;
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBe(failure);
      expect(await store.ideas.list()).toEqual([]);
      expect((await store.ideas.create(sampleIdea())).id).toBe('I1');
    });
  });
}
