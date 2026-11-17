// SPDX-License-Identifier: MPL-2.0
import type { NewDecision, NewDemand, NewPlay, NewStage } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { expectCode, type AggregateHarness } from './aggregate-support.js';

/** A valid play; `n` varies the id. */
export function samplePlay(n: number, extra: Partial<NewPlay> = {}): NewPlay {
  return {
    id: `play-${String(n)}`,
    scenarioId: 'scn-1',
    need: `Need ${String(n)}`,
    flowId: 'software',
    flowVersion: 1,
    state: 'PLANNING',
    ...extra,
  };
}

export function sampleStage(n: number, extra: Partial<NewStage> = {}): NewStage {
  return {
    id: `stage-${String(n)}`,
    playId: 'play-1',
    name: 'PLANNING',
    role: 'planner',
    ...extra,
  };
}

export function sampleDemand(
  playId: string,
  id: string,
  extra: Partial<NewDemand> = {},
): NewDemand {
  return {
    playId,
    id,
    title: `Demand ${id}`,
    description: 'Do the thing',
    dependsOn: [],
    contract: { inputs: [], outputs: [] },
    expectedFiles: [],
    complexity: 'low',
    timeoutMin: 30,
    acceptanceCriteria: [],
    verify: [],
    ...extra,
  };
}

export function sampleDecision(n: number, extra: Partial<NewDecision> = {}): NewDecision {
  return {
    id: `dec-${String(n)}`,
    scenarioId: 'scn-1',
    kind: 'script_review',
    input: { question: `Question ${String(n)}` },
    ...extra,
  };
}

/** Registers the conformance tests of `store.plays`, `stages`, `demands` and `decisions`. */
export function describePlayAggregatesConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Plays conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create stores a play with the defaults and get finds it', async () => {
      const { store, clock } = harness();
      const stored = await store.plays.create(samplePlay(1));
      expect(stored).toEqual({
        ...samplePlay(1),
        snapshot: null,
        counters: {},
        parentPlayId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        finishedAt: null,
      });
      expect(await store.plays.get('play-1')).toEqual(stored);
      expect(await store.plays.get('nope')).toBeUndefined();
    });

    it('a duplicate id rejects with CONFLICT; bad input with INVALID_INPUT', async () => {
      const { store } = harness();
      await store.plays.create(samplePlay(1));
      await expectCode(store.plays.create(samplePlay(1, { need: 'Other' })), 'CONFLICT');
      await expectCode(store.plays.create(samplePlay(2, { flowVersion: 0 })), 'INVALID_INPUT');
      await expectCode(store.plays.create(samplePlay(2, { need: '' })), 'INVALID_INPUT');
      await expectCode(
        store.plays.create(samplePlay(2, { counters: { loops: -1 } })),
        'INVALID_INPUT',
      );
      expect((await store.plays.list()).map((p) => p.id)).toEqual(['play-1']);
    });

    it('update changes state, snapshot, counters and finishedAt together', async () => {
      const { store } = harness();
      const first = await store.plays.create(samplePlay(1));
      const snapshot = { value: 'PLANNING', context: { rounds: [1, 2], note: null } };
      const updated = await store.plays.update('play-1', {
        state: 'EXECUTING',
        snapshot,
        counters: { plan_reviews: 2 },
      });
      expect(updated).toMatchObject({
        state: 'EXECUTING',
        snapshot,
        counters: { plan_reviews: 2 },
        need: 'Need 1',
        createdAt: first.createdAt,
        finishedAt: null,
      });
      expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
      expect(await store.plays.get('play-1')).toEqual(updated);

      const done = await store.plays.update('play-1', { state: 'DONE', finishedAt: 5000 });
      expect(done).toMatchObject({ state: 'DONE', finishedAt: 5000, snapshot });
    });

    it('update rejects an unknown id with NOT_FOUND and other fields with INVALID_INPUT', async () => {
      const { store } = harness();
      await store.plays.create(samplePlay(1));
      await expectCode(store.plays.update('nope', { state: 'X' }), 'NOT_FOUND');
      await expectCode(store.plays.update('play-1', { need: 'changed' } as never), 'INVALID_INPUT');
      await expectCode(store.plays.update('play-1', { state: '' }), 'INVALID_INPUT');
    });

    it('list is ordered by creation, then id, and filters by scenario, state and openness', async () => {
      const { store } = harness();
      await store.plays.create(samplePlay(2, { scenarioId: 'scn-2' }));
      await store.plays.create(samplePlay(1, { state: 'DONE' }));
      await store.plays.create(samplePlay(3));
      await store.plays.update('play-1', { finishedAt: 10 });
      expect((await store.plays.list()).map((p) => p.id)).toEqual(['play-1', 'play-2', 'play-3']);
      expect((await store.plays.list({ scenarioId: 'scn-1' })).map((p) => p.id)).toEqual([
        'play-1',
        'play-3',
      ]);
      expect((await store.plays.list({ states: ['PLANNING'] })).map((p) => p.id)).toEqual([
        'play-2',
        'play-3',
      ]);
      expect((await store.plays.list({ open: true })).map((p) => p.id)).toEqual([
        'play-2',
        'play-3',
      ]);
      expect((await store.plays.list({ open: false })).map((p) => p.id)).toEqual(['play-1']);
      expect(await store.plays.list({ states: [] })).toEqual([]);
    });

    it('keeps the link to a parent play', async () => {
      const { store } = harness();
      await store.plays.create(samplePlay(1));
      const child = await store.plays.create(samplePlay(2, { parentPlayId: 'play-1' }));
      expect(child.parentPlayId).toBe('play-1');
      expect((await store.plays.get('play-2'))?.parentPlayId).toBe('play-1');
    });
  });

  describe(`Stages conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create starts a stage running, with no end', async () => {
      const { store, clock } = harness();
      const stored = await store.stages.create(sampleStage(1, { demandId: 'D1' }));
      expect(stored).toEqual({
        ...sampleStage(1),
        attemptId: null,
        demandId: 'D1',
        state: 'running',
        result: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        endedAt: null,
      });
      expect(await store.stages.get('stage-1')).toEqual(stored);
    });

    it('a stage born finished already has its end', async () => {
      const { store, clock } = harness();
      const stored = await store.stages.create(sampleStage(1, { state: 'completed' }));
      expect(stored.endedAt).toBe(clock.now());
    });

    it('update to a final state stamps endedAt and keeps the structured result', async () => {
      const { store } = harness();
      await store.stages.create(sampleStage(1));
      const result = { verdict: 'approved', findings: [{ file: 'a.ts', line: 3 }] };
      const ended = await store.stages.update('stage-1', {
        state: 'completed',
        result,
        attemptId: 'attempt-1',
      });
      expect(ended).toMatchObject({ state: 'completed', result, attemptId: 'attempt-1' });
      expect(ended.endedAt).not.toBeNull();
      expect(await store.stages.get('stage-1')).toEqual(ended);
    });

    it('rejects a duplicate, an unknown id and bad input', async () => {
      const { store } = harness();
      await store.stages.create(sampleStage(1));
      await expectCode(store.stages.create(sampleStage(1)), 'CONFLICT');
      await expectCode(
        store.stages.create(sampleStage(2, { state: 'nope' as never })),
        'INVALID_INPUT',
      );
      await expectCode(store.stages.update('nope', { state: 'failed' }), 'NOT_FOUND');
      await expectCode(store.stages.update('stage-1', { name: 'x' } as never), 'INVALID_INPUT');
    });

    it('list is ordered by creation, then id, and filters by play and state', async () => {
      const { store } = harness();
      await store.stages.create(sampleStage(2, { playId: 'play-2' }));
      await store.stages.create(sampleStage(1, { state: 'failed' }));
      await store.stages.create(sampleStage(3));
      expect((await store.stages.list()).map((s) => s.id)).toEqual([
        'stage-1',
        'stage-2',
        'stage-3',
      ]);
      expect((await store.stages.list({ playId: 'play-1' })).map((s) => s.id)).toEqual([
        'stage-1',
        'stage-3',
      ]);
      expect((await store.stages.list({ states: ['running'] })).map((s) => s.id)).toEqual([
        'stage-2',
        'stage-3',
      ]);
    });
  });

  describe(`Demands conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create stores a demand as pending and get finds it by play and id', async () => {
      const { store, clock } = harness();
      const stored = await store.demands.create(
        sampleDemand('play-1', 'D1', {
          dependsOn: ['D0'],
          contract: { inputs: ['a'], outputs: [{ file: 'out.ts' }] },
          expectedFiles: ['src/a.ts'],
          acceptanceCriteria: ['it works'],
          verify: [{ kind: 'command', run: 'pnpm test' }],
          specialty: 'backend',
        }),
      );
      expect(stored).toMatchObject({
        playId: 'play-1',
        id: 'D1',
        state: 'pending',
        verifyWaiver: null,
        specialty: 'backend',
        dependsOn: ['D0'],
        contract: { inputs: ['a'], outputs: [{ file: 'out.ts' }] },
        verify: [{ kind: 'command', run: 'pnpm test' }],
        createdAt: clock.now(),
      });
      expect(await store.demands.get('play-1', 'D1')).toEqual(stored);
      expect(await store.demands.get('play-2', 'D1')).toBeUndefined();
    });

    it('ids are scoped by play: the same id may repeat in another play, not in the same one', async () => {
      const { store } = harness();
      await store.demands.create(sampleDemand('play-1', 'D1'));
      await store.demands.create(sampleDemand('play-2', 'D1', { title: 'Other play' }));
      await expectCode(store.demands.create(sampleDemand('play-1', 'D1')), 'CONFLICT');
      expect((await store.demands.get('play-2', 'D1'))?.title).toBe('Other play');
    });

    it('update changes only the state', async () => {
      const { store } = harness();
      const first = await store.demands.create(sampleDemand('play-1', 'D1'));
      const updated = await store.demands.update('play-1', 'D1', { state: 'running' });
      expect(updated).toEqual({ ...first, state: 'running', updatedAt: updated.updatedAt });
      await expectCode(store.demands.update('play-1', 'D9', { state: 'running' }), 'NOT_FOUND');
      await expectCode(
        store.demands.update('play-1', 'D1', { title: 'x' } as never),
        'INVALID_INPUT',
      );
      await expectCode(
        store.demands.update('play-1', 'D1', { state: 'nope' as never }),
        'INVALID_INPUT',
      );
    });

    it('rejects bad input with INVALID_INPUT', async () => {
      const { store } = harness();
      await expectCode(
        store.demands.create(sampleDemand('play-1', 'D1', { timeoutMin: 0 })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.demands.create(sampleDemand('play-1', 'D1', { complexity: 'huge' as never })),
        'INVALID_INPUT',
      );
      expect(await store.demands.list()).toEqual([]);
    });

    it('list is ordered by creation, play and id, and filters by play and state', async () => {
      const { store } = harness();
      await store.demands.create(sampleDemand('play-2', 'D1'));
      await store.demands.create(sampleDemand('play-1', 'D2', { state: 'ready' }));
      await store.demands.create(sampleDemand('play-1', 'D1'));
      expect((await store.demands.list()).map((d) => `${d.playId}/${d.id}`)).toEqual([
        'play-1/D1',
        'play-1/D2',
        'play-2/D1',
      ]);
      expect((await store.demands.list({ playId: 'play-1' })).map((d) => d.id)).toEqual([
        'D1',
        'D2',
      ]);
      expect((await store.demands.list({ states: ['ready'] })).map((d) => d.id)).toEqual(['D2']);
    });
  });

  describe(`Decisions conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create records a pending decision', async () => {
      const { store, clock } = harness();
      const stored = await store.decisions.create(sampleDecision(1, { playId: 'play-1' }));
      expect(stored).toEqual({
        ...sampleDecision(1),
        playId: 'play-1',
        answer: null,
        decidedBy: null,
        state: 'pending',
        createdAt: clock.now(),
        updatedAt: clock.now(),
        decidedAt: null,
      });
      expect(await store.decisions.get('dec-1')).toEqual(stored);
      expect(await store.decisions.get('nope')).toBeUndefined();
      await expectCode(store.decisions.create(sampleDecision(1)), 'CONFLICT');
    });

    it('decide records the answer and the decider, once', async () => {
      const { store } = harness();
      await store.decisions.create(sampleDecision(1));
      const decided = await store.decisions.decide('dec-1', {
        answer: { approve: true, notes: ['ok'] },
        decidedBy: 'producer',
      });
      expect(decided).toMatchObject({
        state: 'decided',
        answer: { approve: true, notes: ['ok'] },
        decidedBy: 'producer',
      });
      expect(decided.decidedAt).not.toBeNull();
      expect(await store.decisions.get('dec-1')).toEqual(decided);
      await expectCode(
        store.decisions.decide('dec-1', { answer: { approve: false }, decidedBy: 'director' }),
        'CONFLICT',
      );
      await expectCode(store.decisions.cancel('dec-1'), 'CONFLICT');
      expect((await store.decisions.get('dec-1'))?.answer).toEqual({
        approve: true,
        notes: ['ok'],
      });
    });

    it('cancel ends a pending decision', async () => {
      const { store } = harness();
      await store.decisions.create(sampleDecision(1));
      expect((await store.decisions.cancel('dec-1')).state).toBe('cancelled');
      await expectCode(
        store.decisions.decide('dec-1', { answer: {}, decidedBy: 'daemon' }),
        'CONFLICT',
      );
    });

    it('rejects an unknown id and bad input', async () => {
      const { store } = harness();
      await expectCode(
        store.decisions.decide('nope', { answer: {}, decidedBy: 'daemon' }),
        'NOT_FOUND',
      );
      await expectCode(store.decisions.cancel('nope'), 'NOT_FOUND');
      await store.decisions.create(sampleDecision(1));
      await expectCode(
        store.decisions.decide('dec-1', { answer: {}, decidedBy: 'nobody' as never }),
        'INVALID_INPUT',
      );
      await expectCode(store.decisions.create(sampleDecision(2, { kind: '' })), 'INVALID_INPUT');
      expect((await store.decisions.get('dec-1'))?.state).toBe('pending');
    });

    it('list is ordered by creation, then id, and filters by scenario, play, kind and state', async () => {
      const { store } = harness();
      await store.decisions.create(
        sampleDecision(2, { kind: 'dispense_critic', playId: 'play-1' }),
      );
      await store.decisions.create(sampleDecision(1, { scenarioId: 'scn-2' }));
      await store.decisions.create(sampleDecision(3));
      await store.decisions.cancel('dec-3');
      const ids = async (filter: Parameters<typeof store.decisions.list>[0]): Promise<string[]> =>
        (await store.decisions.list(filter)).map((d) => d.id);
      expect(await ids({})).toEqual(['dec-1', 'dec-2', 'dec-3']);
      expect(await ids({ scenarioId: 'scn-1' })).toEqual(['dec-2', 'dec-3']);
      expect(await ids({ playId: 'play-1' })).toEqual(['dec-2']);
      expect(await ids({ kinds: ['dispense_critic'] })).toEqual(['dec-2']);
      expect(await ids({ states: ['pending'] })).toEqual(['dec-1', 'dec-2']);
      expect(await ids({ states: ['cancelled'], kinds: ['script_review'] })).toEqual(['dec-3']);
    });
  });
}
