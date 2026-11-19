// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from '../orchestration/e2e-fixture.js';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { IDEA_GROUP_DECISION, IdeaQueueService, type IdeaQueueServiceOptions } from './service.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The idea queue (architecture 5.20, N91) with the fake agent as the Author and as every role of
 * the plays, and the fake code host. `pnpm build` comes first (the fake agent is compiled).
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

function withPlayDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withDaemon(fakes(), options, body);
}

/** Four ideas, two of them in the same area: the Author makes three groups of them. */
const FOUR = [
  { text: 'add the route', area: 'api' },
  { text: 'add the button', area: 'ui' },
  { text: 'test the route', area: 'api' },
  { text: 'fix the typo', area: undefined },
] as const;

async function addFour(harness: PlayHarness, scenarioId: string): Promise<void> {
  for (const idea of FOUR) {
    await harness.producer.idea(scenarioId, {
      action: 'add',
      text: idea.text,
      ...(idea.area === undefined ? {} : { area: idea.area }),
    });
  }
}

async function ideasOf(harness: PlayHarness, scenarioId: string) {
  return harness.daemon.store.ideas.list({ scenarioId });
}

async function groupAsk(harness: PlayHarness, scenarioId: string) {
  return waitFor('the group to wait for approval', async () =>
    (await harness.producer.poll(scenarioId, 0)).asks.find(
      (ask) => ask.kind === IDEA_GROUP_DECISION,
    ),
  );
}

async function eventTypes(harness: PlayHarness, prefix: string): Promise<string[]> {
  return (await harness.daemon.store.events.readFrom(0, 100_000))
    .map((event) => event.type)
    .filter((type) => type.startsWith(prefix));
}

describeWithLauncher('the idea queue with the fake agent (P8)', { timeout: 180_000 }, () => {
  it('four ideas, two in the same area, become three plays; each waits for approval and ends linked to its play and PR', async () => {
    await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness) => {
      const scenarioId = await harness.openChat();
      await addFour(harness, scenarioId);
      expect((await ideasOf(harness, scenarioId)).map((idea) => idea.state)).toEqual([
        'queued',
        'queued',
        'queued',
        'queued',
      ]);

      const seen: string[][] = [];
      for (let round = 1; round <= 3; round += 1) {
        const result = await harness.producer.idea(scenarioId, { action: 'drain' });
        expect(result.drain?.groups).toBe(1);
        // `grouping_approval: ask`: the group waits, and no play exists for it yet.
        const ask = await groupAsk(harness, scenarioId);
        expect(await harness.plays(scenarioId)).toHaveLength(round - 1);
        const grouped = (await ideasOf(harness, scenarioId)).filter(
          (idea) => idea.state === 'grouped',
        );
        expect(grouped.every((idea) => idea.playId === null)).toBe(true);
        seen.push(grouped.map((idea) => idea.id));
        await harness.producer.answer(ask.id, { option: 'approve' });
        const members = new Set(grouped.map((idea) => idea.id));
        const playId = await waitFor(
          'the play of the group',
          async () =>
            (await ideasOf(harness, scenarioId)).find(
              (idea) => members.has(idea.id) && idea.playId !== null,
            )?.playId ?? undefined,
        );
        await waitFor('the play to end', async () => {
          const found = await harness.daemon.store.plays.get(playId);
          return found?.state === 'DONE';
        });
        await waitFor('the ideas to be done', async () =>
          (await ideasOf(harness, scenarioId))
            .filter((idea) => members.has(idea.id))
            .every((idea) => idea.state === 'done'),
        );
      }
      expect(seen).toEqual([['I1', 'I3'], ['I2'], ['I4']]);

      const ideas = await ideasOf(harness, scenarioId);
      expect(ideas.map((idea) => idea.state)).toEqual(['done', 'done', 'done', 'done']);
      const plays = await harness.plays(scenarioId);
      expect(plays).toHaveLength(3);
      const pulls = harness.codeHost.pullRequests();
      expect(pulls).toHaveLength(3);
      // Each idea is linked to its play and to the PR that play opened.
      expect(ideas[0]?.playId).toBe(ideas[2]?.playId);
      expect(new Set(ideas.map((idea) => idea.playId)).size).toBe(3);
      for (const idea of ideas) {
        expect(idea.playId).not.toBeNull();
        expect(idea.prNumber).not.toBeNull();
        expect(idea.prUrl).toContain(String(idea.prNumber));
        expect(idea.closedAt).not.toBeNull();
      }
      expect(new Set(ideas.map((idea) => idea.prNumber)).size).toBe(3);

      const events = await eventTypes(harness, 'idea.');
      expect(events.filter((type) => type === 'idea.added')).toHaveLength(4);
      expect(events.filter((type) => type === 'idea.grouped')).toHaveLength(3);
      expect(events.filter((type) => type === 'idea.play_opened')).toHaveLength(3);
      expect(events.filter((type) => type === 'idea.done')).toHaveLength(4);
    });
  });

  it('with drain auto and grouping_approval auto the queue empties by itself', async () => {
    await withPlayDaemon(
      { extra: 'ideas:\n  drain: auto\n  grouping_approval: auto' },
      async (harness) => {
        const scenarioId = await harness.openChat();
        // The first three go in without waking the queue; the fourth wakes it with all four there.
        for (const idea of FOUR.slice(0, 3)) {
          await harness.daemon.store.ideas.create({
            scenarioId,
            text: idea.text,
            source: 'terminal',
            ...(idea.area === undefined ? {} : { area: idea.area }),
          });
        }
        await harness.producer.idea(scenarioId, { action: 'add', text: FOUR[3].text });
        await waitFor('the queue to drain', async () =>
          (await ideasOf(harness, scenarioId)).every((idea) => idea.state === 'done'),
        );
        expect(await harness.plays(scenarioId)).toHaveLength(3);
        expect(harness.codeHost.pullRequests()).toHaveLength(3);
        const ideas = await ideasOf(harness, scenarioId);
        expect(ideas.every((idea) => idea.prNumber !== null && idea.playId !== null)).toBe(true);
        // `auto` never asked: no decision of the group was created.
        expect(
          await harness.daemon.store.decisions.list({ scenarioId, kinds: [IDEA_GROUP_DECISION] }),
        ).toHaveLength(0);
      },
    );
  });

  it('the Producer can edit a group (fewer ideas, a new need): the one left out goes back to the queue', async () => {
    await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness) => {
      const scenarioId = await harness.openChat();
      await addFour(harness, scenarioId);
      await harness.producer.idea(scenarioId, { action: 'drain' });
      const ask = await groupAsk(harness, scenarioId);
      expect((ask.input.ideas as { id: string }[]).map((idea) => idea.id)).toEqual(['I1', 'I3']);
      expect(ask.input.leftOut).toHaveLength(2);
      await harness.producer.answer(ask.id, {
        option: 'edit',
        need: 'only the route, please',
        ideaIds: ['I1'],
      });
      const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
      expect(play.need).toContain('only the route, please');
      const ideas = await ideasOf(harness, scenarioId);
      expect(ideas.find((idea) => idea.id === 'I1')).toMatchObject({
        state: 'grouped',
        playId: play.id,
      });
      expect(ideas.find((idea) => idea.id === 'I3')).toMatchObject({
        state: 'queued',
        playId: null,
        groupId: null,
      });
      expect(await eventTypes(harness, 'idea.returned')).toHaveLength(1);
    });
  });

  it('a refused group sends every idea back to the queue and opens nothing', async () => {
    await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness) => {
      const scenarioId = await harness.openChat();
      await addFour(harness, scenarioId);
      await harness.producer.idea(scenarioId, { action: 'drain' });
      const ask = await groupAsk(harness, scenarioId);
      await harness.producer.answer(ask.id, { option: 'refuse', reason: 'not now' });
      // The Producer is told why the queue stopped, once.
      const poll = await harness.producer.poll(scenarioId, 0);
      expect(poll.queueHolds).toEqual([
        { scenarioId, cause: 'group_refused', reason: 'not now', playId: null },
      ]);
      expect((await harness.producer.poll(scenarioId, 0)).queueHolds).toEqual([]);
      expect(await eventTypes(harness, 'idea.queue_held')).toHaveLength(1);
      const ideas = await ideasOf(harness, scenarioId);
      expect(ideas.map((idea) => idea.state)).toEqual(['queued', 'queued', 'queued', 'queued']);
      expect(ideas[0]?.reason).toBe('not now');
      expect(await harness.plays(scenarioId)).toHaveLength(0);
      expect((await harness.daemon.store.decisions.get(ask.id))?.state).toBe('decided');
    });
  });

  it('a stopped queue stays stopped under drain auto until a command or a new idea frees it', async () => {
    await withPlayDaemon({}, async (harness) => {
      const scenarioId = await harness.openChat();
      await harness.producer.idea(scenarioId, { action: 'add', text: 'one thing' });
      const first = await groupAsk(harness, scenarioId);
      await harness.producer.answer(first.id, { option: 'refuse', reason: 'changed my mind' });
      const held = await waitFor('the notice of the stop', async () => {
        const { queueHolds } = await harness.producer.poll(scenarioId, 0);
        return queueHolds.length === 0 ? undefined : queueHolds;
      });
      expect(held[0]).toMatchObject({ cause: 'group_refused', reason: 'changed my mind' });
      // Nothing moves the queue by itself: the idea stays queued and no new group is asked.
      await waitFor(
        'the channel to be quiet',
        async () => !(await harness.producer.poll(scenarioId, 0)).busy,
      );
      expect((await ideasOf(harness, scenarioId)).map((idea) => idea.state)).toEqual(['queued']);
      expect((await harness.producer.poll(scenarioId, 0)).asks).toEqual([]);
      // A new idea frees it: the Author groups again.
      await harness.producer.idea(scenarioId, { action: 'add', text: 'another thing' });
      const second = await groupAsk(harness, scenarioId);
      expect(second.id).not.toBe(first.id);
    });
  });

  it('ideas go back to the queue when their play is cancelled', async () => {
    await withPlayDaemon(
      { limits: '  attempts_per_demand: 2', extra: 'ideas:\n  drain: manual' },
      async (harness) => {
        const scenarioId = await harness.openChat();
        await harness.producer.idea(scenarioId, {
          action: 'add',
          text: 'write alpha #outcome:exhausted',
        });
        await harness.producer.idea(scenarioId, { action: 'drain' });
        const ask = await groupAsk(harness, scenarioId);
        await harness.producer.answer(ask.id, { option: 'approve' });
        const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
        const menu = await waitFor('the menu', async () =>
          (await harness.producer.poll(scenarioId, 0)).asks.find(
            (item) => item.kind === 'producer_menu',
          ),
        );
        await harness.producer.answer(menu.id, { option: 'cancel', reason: 'not worth it' });
        await waitFor('the idea to go back', async () => {
          const [idea] = await ideasOf(harness, scenarioId);
          return idea?.state === 'queued';
        });
        const [idea] = await ideasOf(harness, scenarioId);
        expect(idea).toMatchObject({ playId: null, prNumber: null, groupId: null });
        expect(idea?.reason).toContain('cancelled');
        const returned = (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
          (event) => event.type === 'idea.returned',
        );
        expect(returned.map((event) => event.payload.playId)).toEqual([play.id]);
        const { queueHolds } = await harness.producer.poll(scenarioId, 0);
        expect(queueHolds).toHaveLength(1);
        expect(queueHolds[0]).toMatchObject({ cause: 'play_ended', playId: play.id });
        expect(queueHolds[0]?.reason).toContain('cancelled');
        expect(harness.codeHost.pullRequests()).toHaveLength(0);
      },
    );
  });

  it('with drain auto an added idea wakes the queue and the group waits for approval', async () => {
    await withPlayDaemon({}, async (harness) => {
      const scenarioId = await harness.openChat();
      await harness.producer.idea(scenarioId, { action: 'add', text: 'one thing' });
      const ask = await groupAsk(harness, scenarioId);
      expect(ask.input.need).toBe('one thing');
      expect(await harness.plays(scenarioId)).toHaveLength(0);
    });
  });

  it('after a restart the ideas of a group nobody waits for go back to the queue', async () => {
    await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness) => {
      const scenarioId = await harness.openChat();
      const { store } = harness.daemon;
      const lost = await store.ideas.create({ scenarioId, text: 'stuck' });
      await store.ideas.transition(lost.id, 'grouped', { groupId: 'grp-lost', groupOrder: 1 });
      // A second service on the same store is what the start-up of a new daemon builds. It never
      // runs the Author here (`drain: manual`), so the stubs are not touched.
      const restarted = new IdeaQueueService({
        store,
        config: parseConfig('ideas:\n  drain: manual\n'),
        logger: createSilentLogger(),
      } as unknown as IdeaQueueServiceOptions);
      await restarted.settle();
      expect(await store.ideas.get(lost.id)).toMatchObject({
        state: 'queued',
        groupId: null,
        playId: null,
      });
      expect(await eventTypes(harness, 'idea.returned')).toHaveLength(1);
    });
  });
});
