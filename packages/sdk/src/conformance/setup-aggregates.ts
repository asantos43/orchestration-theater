// SPDX-License-Identifier: MPL-2.0
import type { NewSetupRun } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { expectCode, type AggregateHarness } from './aggregate-support.js';

export function sampleSetupRun(extra: Partial<NewSetupRun> = {}): NewSetupRun {
  return { flow: 'first_run', step: 'detect', ...extra };
}

/** Registers the conformance tests of `store.setupRuns` (the runs of the setup assistant, 5.7). */
export function describeSetupAggregatesConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Setup runs conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create assigns SR1, SR2 and stores the run active', async () => {
      const { store, clock } = harness();
      const first = await store.setupRuns.create(sampleSetupRun());
      expect(first).toEqual({
        id: 'SR1',
        seq: 1,
        flow: 'first_run',
        state: 'active',
        step: 'detect',
        done: [],
        result: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        finishedAt: null,
      });
      const second = await store.setupRuns.create(sampleSetupRun({ flow: 'change_preset' }));
      expect(second).toMatchObject({ id: 'SR2', flow: 'change_preset' });
      expect(await store.setupRuns.get('SR2')).toEqual(second);
      expect(await store.setupRuns.get('SR9')).toBeUndefined();
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store } = harness();
      await expectCode(
        store.setupRuns.create(sampleSetupRun({ flow: 'moon' as never })),
        'INVALID_INPUT',
      );
      await expectCode(store.setupRuns.create(sampleSetupRun({ step: '' })), 'INVALID_INPUT');
      expect(await store.setupRuns.list()).toEqual([]);
    });

    it('allows one active run per flow; a finished one does not count', async () => {
      const { store } = harness();
      await store.setupRuns.create(sampleSetupRun());
      await expectCode(store.setupRuns.create(sampleSetupRun()), 'CONFLICT');
      await store.setupRuns.create(sampleSetupRun({ flow: 'add_account' }));
      await store.setupRuns.update('SR1', { state: 'cancelled' });
      const again = await store.setupRuns.create(sampleSetupRun());
      expect(again).toMatchObject({ id: 'SR3', state: 'active' });
    });

    it('list filters by flow and state, ordered by seq', async () => {
      const { store } = harness();
      await store.setupRuns.create(sampleSetupRun());
      await store.setupRuns.create(sampleSetupRun({ flow: 'add_account' }));
      await store.setupRuns.update('SR1', { state: 'cancelled' });
      await store.setupRuns.create(sampleSetupRun());
      const ids = async (filter: Parameters<typeof store.setupRuns.list>[0]): Promise<string[]> =>
        (await store.setupRuns.list(filter)).map((r) => r.id);
      expect(await ids(undefined)).toEqual(['SR1', 'SR2', 'SR3']);
      expect(await ids({ flow: 'first_run' })).toEqual(['SR1', 'SR3']);
      expect(await ids({ states: ['active'] })).toEqual(['SR2', 'SR3']);
      expect(await ids({ flow: 'first_run', states: ['cancelled'] })).toEqual(['SR1']);
    });

    it('update moves the step and the answers, and settles the run once', async () => {
      const { store, clock } = harness();
      await store.setupRuns.create(sampleSetupRun());
      const done = [{ step: 'detect', input: {}, output: { clients: ['codex'] } }];
      const moved = await store.setupRuns.update('SR1', { step: 'preset', done });
      expect(moved).toMatchObject({ step: 'preset', done, state: 'active', finishedAt: null });
      expect(await store.setupRuns.get('SR1')).toEqual(moved);
      const confirmed = await store.setupRuns.update('SR1', {
        state: 'confirmed',
        result: { executors: 2 },
      });
      expect(confirmed).toMatchObject({
        state: 'confirmed',
        result: { executors: 2 },
        step: 'preset',
        done,
        updatedAt: clock.now(),
        finishedAt: clock.now(),
      });
      await expectCode(store.setupRuns.update('SR1', { step: 'x' }), 'CONFLICT');
      await expectCode(store.setupRuns.update('SR1', { state: 'cancelled' }), 'CONFLICT');
      await expectCode(store.setupRuns.update('SR9', { step: 'x' }), 'NOT_FOUND');
    });

    it('rejects a bad patch, and a result without the confirmed state', async () => {
      const { store } = harness();
      await store.setupRuns.create(sampleSetupRun());
      await expectCode(store.setupRuns.update('SR1', { step: '' }), 'INVALID_INPUT');
      await expectCode(store.setupRuns.update('SR1', { state: 'active' as never }), 'INVALID_INPUT');
      await expectCode(
        store.setupRuns.update('SR1', { state: 'cancelled', result: { a: 1 } }),
        'INVALID_INPUT',
      );
      expect(await store.setupRuns.get('SR1')).toMatchObject({ state: 'active', step: 'detect' });
    });
  });
}
