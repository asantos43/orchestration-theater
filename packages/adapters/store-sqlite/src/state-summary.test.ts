// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { contractKey, renderStateSummary, stateSummaryOf, type Store } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from './store.js';
import { DRIVERS, openTempStore } from './test-helpers.js';

/** A scenario with a play, a blackboard with versions, a decision, a directive and a message. */
async function seed(store: Store): Promise<void> {
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play.default',
    name: 'Loja API',
    folder: '/work/loja',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: 'p1',
    scenarioId: 's1',
    need: 'Add a health endpoint',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: { plan_reviews: 1 },
  });
  await store.demands.create({
    playId: 'p1',
    id: 'd1',
    title: 'Demand d1',
    description: 'do it',
    dependsOn: [],
    contract: { inputs: [], outputs: [] },
    expectedFiles: ['a.ts'],
    complexity: 'low',
    timeoutMin: 10,
    acceptanceCriteria: ['works'],
    verify: [],
    verifyWaiver: 'none',
    state: 'running',
  });
  await store.blackboard.put({ playId: 'p1', key: 'script', value: { v: 1 }, author: 'writer' });
  await store.blackboard.put({ playId: 'p1', key: 'script', value: { v: 2 }, author: 'writer' });
  await store.blackboard.put({ playId: 'p1', key: contractKey('c1'), value: { fn: 'f()' } });
  await store.decisions.create({
    id: 'D-1',
    scenarioId: 's1',
    playId: 'p1',
    kind: 'script_review',
    input: { q: 'ok?' },
  });
  await store.directives.create({
    scope: 'local',
    scenarioId: 's1',
    kind: 'instruction',
    text: 'Commit in Portuguese',
    origin: 'chat',
  });
}

const queued = (id: string, source: 'producer' | 'director' | 'daemon', priority: number) => ({
  id,
  scenarioId: 's1',
  source,
  priority,
  content: { text: id },
});

describe.each(DRIVERS)('the Director prompt queue on %s', (driver) => {
  it('keeps what was queued across a close and a reopen of the file, the Producer first', async () => {
    const ctx = await openTempStore(driver);
    try {
      await seed(ctx.store);
      await ctx.store.promptQueue.enqueue(queued('notice', 'daemon', 0));
      await ctx.store.promptQueue.enqueue(queued('follow-up', 'director', 50));
      await ctx.store.promptQueue.enqueue(queued('producer', 'producer', 100));
      await ctx.store.close();

      // The "restart": the same file, a new store.
      const reopened = await SqliteStore.open({ path: ctx.dbPath, driver }, ctx.clock);
      try {
        const pending = await reopened.promptQueue.list({ scenarioId: 's1', states: ['pending'] });
        expect(pending).toHaveLength(3);
        const order: string[] = [];
        for (let item = await reopened.promptQueue.next('s1'); item;) {
          order.push(item.id);
          await reopened.promptQueue.markDelivered(item.id);
          item = await reopened.promptQueue.next('s1');
        }
        expect(order).toEqual(['producer', 'follow-up', 'notice']);
      } finally {
        await reopened.close();
      }
    } finally {
      // `store.close()` ran above; the folder is removed here.
      await ctx.dispose().catch(() => undefined);
    }
  });

  it('keeps a delivered prompt delivered after the reopen', async () => {
    const ctx = await openTempStore(driver);
    try {
      await seed(ctx.store);
      await ctx.store.promptQueue.enqueue(queued('a', 'producer', 100));
      await ctx.store.promptQueue.markDelivered('a');
      await ctx.store.close();
      const reopened = await SqliteStore.open({ path: ctx.dbPath, driver }, ctx.clock);
      try {
        expect(await reopened.promptQueue.next('s1')).toBeUndefined();
        expect((await reopened.promptQueue.get('a'))?.state).toBe('delivered');
      } finally {
        await reopened.close();
      }
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });
});

describe.each(DRIVERS)('the state summary of a restored store on %s', (driver) => {
  it('is equal, as data and as text, to the one of the store the backup came from', async () => {
    const ctx = await openTempStore(driver);
    try {
      await seed(ctx.store);
      await ctx.store.promptQueue.enqueue(queued('producer', 'producer', 100));
      const dest = join(ctx.dir, 'restored.db');
      await ctx.store.backup(dest);

      // Same instant: which directives are in force depends on the clock by design (a validity
      // window), so the summaries are equal at the same time, not at any time.
      const restored = await SqliteStore.open({ path: dest, driver }, ctx.clock);
      try {
        const options = { recentMessages: 5 };
        const original = await stateSummaryOf(ctx.store, 's1', options);
        const copy = await stateSummaryOf(restored, 's1', options);
        expect(copy).toEqual(original);
        expect(renderStateSummary(copy)).toBe(renderStateSummary(original));
        // Not an empty equality: the summary does carry the state.
        const text = renderStateSummary(original);
        expect(text).toContain('Add a health endpoint');
        expect(text).toContain('script');
      } finally {
        await restored.close();
      }
    } finally {
      await ctx.dispose();
    }
  });
});
