// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { contractKey, PLAN_KEY, SCRIPT_KEY } from './blackboard-keys.js';
import { NotFound } from './errors.js';
import {
  buildStateSummary,
  renderStateSummary,
  stateSummaryOf,
  SUMMARY_MESSAGE_CHARS,
  type StateSnapshot,
  type StateSummaryStore,
} from './state-summary.js';
import { FakeClock } from './testing/fake-clock.js';
import { InMemoryStore } from './testing/in-memory-store.js';

/** A scenario with a play, two demands, a pending decision, a directive and a few prompts. */
export async function seedScenario(
  store: StateSummaryStore,
  scenarioId = 's1',
  tag = '',
): Promise<void> {
  await store.scenarios.create({
    id: scenarioId,
    kind: 'project',
    flowId: 'play.default',
    name: 'Loja API',
    folder: '/work/loja',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: `${scenarioId}-p1`,
    scenarioId,
    need: 'Add a health endpoint',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: { plan_reviews: 1 },
  });
  for (const [id, dependsOn, state] of [
    ['d2', ['d1'], 'pending'],
    ['d1', [], 'running'],
  ] as const) {
    await store.demands.create({
      playId: `${scenarioId}-p1`,
      id,
      title: `Demand ${id}`,
      description: 'do it',
      dependsOn: [...dependsOn],
      contract: { inputs: [], outputs: [] },
      expectedFiles: ['a.ts'],
      complexity: 'low',
      timeoutMin: 10,
      acceptanceCriteria: ['works'],
      verify: [],
      verifyWaiver: 'none',
      state,
    });
  }
  await store.blackboard.put({ playId: `${scenarioId}-p1`, key: SCRIPT_KEY, value: { v: 1 } });
  await store.blackboard.put({ playId: `${scenarioId}-p1`, key: SCRIPT_KEY, value: { v: 2 } });
  await store.blackboard.put({ playId: `${scenarioId}-p1`, key: PLAN_KEY, value: 'plan' });
  await store.blackboard.put({
    playId: `${scenarioId}-p1`,
    key: contractKey('c1'),
    value: { fn: 'f()' },
  });
  await store.decisions.create({
    id: `D-1${tag}`,
    scenarioId,
    playId: `${scenarioId}-p1`,
    kind: 'script_review',
    input: { q: 'ok?' },
  });
  await store.directives.create({
    scope: 'local',
    scenarioId,
    kind: 'instruction',
    text: 'Commit in Portuguese',
    origin: 'chat',
  });
  await store.promptQueue.enqueue({
    id: `q1${tag}`,
    scenarioId,
    source: 'producer',
    content: { text: 'Please add a health endpoint' },
  });
  await store.promptQueue.markDelivered(`q1${tag}`);
  await store.promptQueue.enqueue({
    id: `q2${tag}`,
    scenarioId,
    source: 'daemon',
    content: { text: 'Decision D-1 is pending; call next_action' },
  });
  await store.promptQueue.enqueue({
    id: `q3${tag}`,
    scenarioId,
    source: 'producer',
    content: { text: 'And add a test too' },
  });
}

describe('buildStateSummary and stateSummaryOf', () => {
  it('summarizes the open plays, decisions, directives and the queue, in a fixed order', async () => {
    const store = new InMemoryStore({ clock: new FakeClock(1_000) });
    await seedScenario(store);
    const summary = await stateSummaryOf(store, 's1');
    expect(summary.scenario).toEqual({
      id: 's1',
      kind: 'project',
      name: 'Loja API',
      directorState: 'active',
      baseBranch: 'main',
    });
    expect(summary.plays).toHaveLength(1);
    expect(summary.plays[0]).toMatchObject({
      id: 's1-p1',
      state: 'EXECUTING',
      counters: { plan_reviews: 1 },
      demands: [
        { id: 'd1', state: 'running', dependsOn: [] },
        { id: 'd2', state: 'pending', dependsOn: ['d1'] },
      ],
      // Only keys and latest versions; never the content.
      blackboard: [
        { key: 'contract/c1', version: 1 },
        { key: 'plan', version: 1 },
        { key: 'script', version: 2 },
      ],
    });
    expect(summary.pendingDecisions).toEqual([
      { id: 'D-1', kind: 'script_review', playId: 's1-p1' },
    ]);
    expect(summary.directives.map((d) => d.text)).toEqual(['Commit in Portuguese']);
    // The Producer's message passes ahead of the notice of the daemon.
    expect(summary.pendingPrompts.map((p) => p.seq)).toEqual([3, 2]);
    expect(summary.recentMessages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(JSON.stringify(summary)).not.toContain('"value"');
  });

  it('leaves out finished plays and the decisions already answered', async () => {
    const store = new InMemoryStore({ clock: new FakeClock(1_000) });
    await seedScenario(store);
    await store.plays.update('s1-p1', { state: 'DONE', finishedAt: 2_000 });
    await store.decisions.decide('D-1', { answer: { ok: true }, decidedBy: 'producer' });
    const summary = await stateSummaryOf(store, 's1');
    expect(summary.plays).toEqual([]);
    expect(summary.pendingDecisions).toEqual([]);
  });

  it('keeps the scenarios apart and rejects an unknown one', async () => {
    const store = new InMemoryStore({ clock: new FakeClock(1_000) });
    await seedScenario(store, 's1');
    await seedScenario(store, 's2', '-b');
    const summary = await stateSummaryOf(store, 's2');
    expect(summary.plays.map((p) => p.id)).toEqual(['s2-p1']);
    expect(summary.recentMessages).toHaveLength(3);
    await expect(stateSummaryOf(store, 'nope')).rejects.toBeInstanceOf(NotFound);
  });

  it('is pure: the same snapshot gives the same summary, whatever the order it came in', () => {
    const snapshot: StateSnapshot = {
      scenario: {
        id: 's',
        kind: 'chat',
        name: 'n',
        directorState: 'asleep',
        baseBranch: null,
      },
      plays: [],
      pendingDecisions: [],
      directives: [],
      queue: [
        { seq: 2, source: 'daemon', state: 'pending', priority: 0, text: 'b' },
        { seq: 1, source: 'producer', state: 'delivered', priority: 100, text: 'a' },
        { seq: 3, source: 'producer', state: 'pending', priority: 100, text: 'c' },
      ],
    };
    const shuffled = { ...snapshot, queue: [...snapshot.queue].reverse() };
    expect(buildStateSummary(snapshot)).toEqual(buildStateSummary(shuffled));
    expect(renderStateSummary(buildStateSummary(snapshot))).toBe(
      renderStateSummary(buildStateSummary(shuffled)),
    );
  });

  it('lists only the last N messages and cuts a long one', () => {
    const long = 'x'.repeat(SUMMARY_MESSAGE_CHARS + 50);
    const snapshot: StateSnapshot = {
      scenario: { id: 's', kind: 'chat', name: 'n', directorState: 'active', baseBranch: null },
      plays: [],
      pendingDecisions: [],
      directives: [],
      queue: [1, 2, 3, 4].map((seq) => ({
        seq,
        source: 'producer' as const,
        state: 'delivered' as const,
        priority: 100,
        text: seq === 4 ? long : `m${String(seq)}`,
      })),
    };
    const summary = buildStateSummary(snapshot, { recentMessages: 2 });
    expect(summary.recentMessages.map((m) => m.seq)).toEqual([3, 4]);
    expect(summary.recentMessages[1]?.text).toHaveLength(SUMMARY_MESSAGE_CHARS);
    expect(summary.recentMessages[1]?.text.endsWith('…')).toBe(true);
    expect(buildStateSummary(snapshot, { recentMessages: 0 }).recentMessages).toEqual([]);
  });

  it('renders the text a new session reads', async () => {
    const store = new InMemoryStore({ clock: new FakeClock(1_000) });
    await seedScenario(store);
    const text = renderStateSummary(await stateSummaryOf(store, 's1'));
    expect(text).toContain('State of scenario "Loja API"');
    expect(text).toContain('s1-p1 [EXECUTING]: Add a health endpoint');
    expect(text).toContain('demand d2 [pending]: Demand d2 (after d1)');
    expect(text).toContain('script@v2');
    expect(text).toContain('D-1 (script_review) of play s1-p1');
    expect(text).toContain('Commit in Portuguese');
    expect(text.indexOf('#3 producer: And add a test too')).toBeLessThan(
      text.indexOf('#2 daemon: Decision D-1 is pending'),
    );
  });
});
