// SPDX-License-Identifier: MPL-2.0
import type { NewWorkflowBinding, NewWorkflowDefinition } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { advanceClock, expectCode, type AggregateHarness } from './aggregate-support.js';

const DAY = 86_400_000;

function hashOf(letter: string): string {
  return `sha256:${letter.repeat(64)}`;
}

export function sampleWorkflowDefinition(
  extra: Partial<NewWorkflowDefinition> = {},
): NewWorkflowDefinition {
  const workflowId = extra.workflowId ?? 'play';
  const version = extra.version ?? '1.0.0';
  return {
    workflowId,
    version,
    hash: hashOf('a'),
    definition: { id: workflowId, version, steps: [] },
    source: 'builtin',
    ...extra,
  };
}

export function sampleWorkflowBinding(extra: Partial<NewWorkflowBinding> = {}): NewWorkflowBinding {
  return { scenarioId: 'S1', workflowId: 'play', ...extra };
}

/**
 * Registers the conformance tests of `store.workflowDefinitions` (the library) and
 * `store.workflowBindings` (Phase 11b, P5, N296). The clock of the harness must offer
 * `advance(ms)`: the states of a binding depend on its deadline and on its budget period.
 */
export function describeWorkflowAggregatesConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Workflow library conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('put stores the version inactive and numbers it across the library', async () => {
      const { store, clock } = harness();
      const first = await store.workflowDefinitions.put(sampleWorkflowDefinition());
      expect(first).toEqual({
        workflowId: 'play',
        version: '1.0.0',
        seq: 1,
        hash: hashOf('a'),
        definition: { id: 'play', version: '1.0.0', steps: [] },
        source: 'builtin',
        packageId: null,
        state: 'inactive',
        createdAt: clock.now(),
        updatedAt: clock.now(),
        activatedAt: null,
      });
      const second = await store.workflowDefinitions.put(
        sampleWorkflowDefinition({ workflowId: 'review', source: 'package', packageId: 'pkg/x' }),
      );
      expect(second).toMatchObject({ seq: 2, source: 'package', packageId: 'pkg/x' });
      expect(await store.workflowDefinitions.get('play', '1.0.0')).toEqual(first);
      expect(await store.workflowDefinitions.get('play', '9.9.9')).toBeUndefined();
    });

    it('a version is immutable: the same hash is a no-op, another hash is a Conflict', async () => {
      const { store } = harness();
      const first = await store.workflowDefinitions.put(sampleWorkflowDefinition());
      expect(await store.workflowDefinitions.put(sampleWorkflowDefinition())).toEqual(first);
      await expectCode(
        store.workflowDefinitions.put(sampleWorkflowDefinition({ hash: hashOf('b') })),
        'CONFLICT',
      );
      expect(await store.workflowDefinitions.list()).toHaveLength(1);
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store } = harness();
      const bad = async (extra: Partial<NewWorkflowDefinition>): Promise<void> => {
        await expectCode(
          store.workflowDefinitions.put(sampleWorkflowDefinition(extra)),
          'INVALID_INPUT',
        );
      };
      await bad({ workflowId: 'Play' });
      await bad({ version: '1.0' });
      await bad({ hash: 'abc' });
      await bad({ source: 'moon' as never });
      await bad({ definition: { id: 'other', version: '1.0.0' } });
      await bad({ definition: { id: 'play', version: '2.0.0' } });
      await bad({ source: 'package' });
      await bad({ source: 'user', packageId: 'pkg/x' });
      expect(await store.workflowDefinitions.list()).toEqual([]);
    });

    it('activate makes one version the active one and the previous one inactive', async () => {
      const { store, clock } = harness();
      await store.workflowDefinitions.put(sampleWorkflowDefinition());
      await store.workflowDefinitions.put(
        sampleWorkflowDefinition({ version: '1.1.0', hash: hashOf('b') }),
      );
      expect(await store.workflowDefinitions.active('play')).toBeUndefined();

      const one = await store.workflowDefinitions.activate('play', '1.0.0');
      expect(one).toMatchObject({ state: 'active', activatedAt: clock.now() });
      expect(await store.workflowDefinitions.active('play')).toEqual(one);

      await advanceClock(harness(), 1000);
      const two = await store.workflowDefinitions.activate('play', '1.1.0');
      expect(two).toMatchObject({ version: '1.1.0', state: 'active', activatedAt: clock.now() });
      expect(await store.workflowDefinitions.active('play')).toEqual(two);
      expect(await store.workflowDefinitions.get('play', '1.0.0')).toMatchObject({
        state: 'inactive',
        activatedAt: one.activatedAt,
      });
      // Activating the active version changes nothing.
      expect(await store.workflowDefinitions.activate('play', '1.1.0')).toEqual(two);
      await expectCode(store.workflowDefinitions.activate('play', '9.9.9'), 'NOT_FOUND');
      await expectCode(store.workflowDefinitions.activate('nope', '1.0.0'), 'NOT_FOUND');
    });

    it('deactivate leaves the workflow with no active version', async () => {
      const { store, clock } = harness();
      await store.workflowDefinitions.put(sampleWorkflowDefinition());
      await store.workflowDefinitions.put(
        sampleWorkflowDefinition({ version: '1.1.0', hash: hashOf('b') }),
      );
      const one = await store.workflowDefinitions.activate('play', '1.0.0');
      // A version that is not the active one: nothing changes.
      const idle = await store.workflowDefinitions.get('play', '1.1.0');
      expect(await store.workflowDefinitions.deactivate('play', '1.1.0')).toEqual(idle);
      expect(await store.workflowDefinitions.active('play')).toEqual(one);

      await advanceClock(harness(), 1000);
      const off = await store.workflowDefinitions.deactivate('play', '1.0.0');
      expect(off).toMatchObject({
        state: 'inactive',
        activatedAt: one.activatedAt,
        updatedAt: clock.now(),
      });
      expect(await store.workflowDefinitions.active('play')).toBeUndefined();
      // The inactive version can now be removed, and one can be activated again.
      await store.workflowDefinitions.remove('play', '1.0.0');
      expect(await store.workflowDefinitions.activate('play', '1.1.0')).toMatchObject({
        state: 'active',
      });
      await expectCode(store.workflowDefinitions.deactivate('play', '9.9.9'), 'NOT_FOUND');
    });

    it('each workflow has its own active version', async () => {
      const { store } = harness();
      await store.workflowDefinitions.put(sampleWorkflowDefinition());
      await store.workflowDefinitions.put(sampleWorkflowDefinition({ workflowId: 'review' }));
      await store.workflowDefinitions.activate('play', '1.0.0');
      await store.workflowDefinitions.activate('review', '1.0.0');
      expect((await store.workflowDefinitions.active('play'))?.workflowId).toBe('play');
      expect((await store.workflowDefinitions.active('review'))?.workflowId).toBe('review');
      expect(await store.workflowDefinitions.active('other')).toBeUndefined();
    });

    it('remove deletes an inactive version, never the active one', async () => {
      const { store } = harness();
      await store.workflowDefinitions.put(sampleWorkflowDefinition());
      await store.workflowDefinitions.put(
        sampleWorkflowDefinition({ version: '1.1.0', hash: hashOf('b') }),
      );
      await store.workflowDefinitions.activate('play', '1.1.0');
      await expectCode(store.workflowDefinitions.remove('play', '1.1.0'), 'CONFLICT');
      await store.workflowDefinitions.remove('play', '1.0.0');
      expect(await store.workflowDefinitions.get('play', '1.0.0')).toBeUndefined();
      expect(await store.workflowDefinitions.get('play', '1.1.0')).toBeDefined();
      await expectCode(store.workflowDefinitions.remove('play', '1.0.0'), 'NOT_FOUND');
      // The numbering goes on from the last one kept.
      const next = await store.workflowDefinitions.put(
        sampleWorkflowDefinition({ version: '1.2.0', hash: hashOf('c') }),
      );
      expect(next.seq).toBe(3);
    });

    it('list filters by workflow, state and source, ordered by workflow and seq', async () => {
      const { store } = harness();
      await store.workflowDefinitions.put(sampleWorkflowDefinition({ workflowId: 'review' }));
      await store.workflowDefinitions.put(sampleWorkflowDefinition());
      await store.workflowDefinitions.put(
        sampleWorkflowDefinition({ version: '1.1.0', hash: hashOf('b'), source: 'user' }),
      );
      await store.workflowDefinitions.activate('play', '1.1.0');
      const keys = async (
        filter: Parameters<typeof store.workflowDefinitions.list>[0],
      ): Promise<string[]> =>
        (await store.workflowDefinitions.list(filter)).map((d) => `${d.workflowId}@${d.version}`);
      expect(await keys(undefined)).toEqual(['play@1.0.0', 'play@1.1.0', 'review@1.0.0']);
      expect(await keys({ workflowId: 'play' })).toEqual(['play@1.0.0', 'play@1.1.0']);
      expect(await keys({ states: ['active'] })).toEqual(['play@1.1.0']);
      expect(await keys({ states: ['inactive'], source: 'builtin' })).toEqual([
        'play@1.0.0',
        'review@1.0.0',
      ]);
      expect(await keys({ source: 'user' })).toEqual(['play@1.1.0']);
    });
  });

  describe(`Workflow bindings conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create assigns WB1, WB2 and stores the binding active with the defaults', async () => {
      const { store, clock } = harness();
      const first = await store.workflowBindings.create(sampleWorkflowBinding());
      expect(first).toEqual({
        id: 'WB1',
        seq: 1,
        scenarioId: 'S1',
        workflowId: 'play',
        versionRange: '*',
        params: {},
        triggers: [],
        state: 'active',
        stateReason: null,
        until: null,
        budgetUsd: null,
        budgetPeriod: 'day',
        spentUsd: 0,
        periodStartedAt: clock.now(),
        concurrency: 1,
        onBusy: 'queue',
        createdAt: clock.now(),
        updatedAt: clock.now(),
        stateChangedAt: clock.now(),
      });
      const until = clock.now() + 7 * DAY;
      const second = await store.workflowBindings.create(
        sampleWorkflowBinding({
          scenarioId: 'S2',
          versionRange: '1.x',
          params: { goal: 'ship' },
          triggers: [{ type: 'event', name: 'play.finished' }],
          until,
          budgetUsd: 5,
          budgetPeriod: 'week',
          concurrency: 3,
          onBusy: 'skip',
        }),
      );
      expect(second).toMatchObject({
        id: 'WB2',
        versionRange: '1.x',
        params: { goal: 'ship' },
        triggers: [{ type: 'event', name: 'play.finished' }],
        until,
        budgetUsd: 5,
        budgetPeriod: 'week',
        concurrency: 3,
        onBusy: 'skip',
      });
      expect(await store.workflowBindings.get('WB2')).toEqual(second);
      expect(await store.workflowBindings.get('WB9')).toBeUndefined();
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store, clock } = harness();
      const bad = async (extra: Partial<NewWorkflowBinding>): Promise<void> => {
        await expectCode(
          store.workflowBindings.create(sampleWorkflowBinding(extra)),
          'INVALID_INPUT',
        );
      };
      await bad({ scenarioId: '' });
      await bad({ workflowId: 'Play' });
      await bad({ versionRange: 'latest' });
      await bad({ concurrency: 0 });
      await bad({ budgetUsd: 0 });
      await bad({ budgetUsd: -1 });
      await bad({ budgetPeriod: 'year' as never });
      await bad({ onBusy: 'wait' as never });
      await bad({ until: clock.now() });
      await bad({ until: clock.now() - 1 });
      expect(await store.workflowBindings.list()).toEqual([]);
    });

    it('allows one live binding per scenario and workflow; a final one does not count', async () => {
      const { store } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding());
      await expectCode(store.workflowBindings.create(sampleWorkflowBinding()), 'CONFLICT');
      await store.workflowBindings.create(sampleWorkflowBinding({ scenarioId: 'S2' }));
      await store.workflowBindings.create(sampleWorkflowBinding({ workflowId: 'review' }));
      // A paused binding is still live.
      await store.workflowBindings.transition('WB1', { to: 'paused', reason: 'producer' });
      await expectCode(store.workflowBindings.create(sampleWorkflowBinding()), 'CONFLICT');
      await store.workflowBindings.transition('WB1', { to: 'stopped', reason: 'producer' });
      const again = await store.workflowBindings.create(sampleWorkflowBinding());
      expect(again).toMatchObject({ id: 'WB4', state: 'active' });
    });

    it('list filters by scenario, workflow and state, ordered by seq', async () => {
      const { store } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding());
      await store.workflowBindings.create(sampleWorkflowBinding({ scenarioId: 'S2' }));
      await store.workflowBindings.create(sampleWorkflowBinding({ workflowId: 'review' }));
      await store.workflowBindings.transition('WB2', { to: 'paused', reason: 'producer' });
      const ids = async (
        filter: Parameters<typeof store.workflowBindings.list>[0],
      ): Promise<string[]> => (await store.workflowBindings.list(filter)).map((b) => b.id);
      expect(await ids(undefined)).toEqual(['WB1', 'WB2', 'WB3']);
      expect(await ids({ scenarioId: 'S1' })).toEqual(['WB1', 'WB3']);
      expect(await ids({ workflowId: 'play' })).toEqual(['WB1', 'WB2']);
      expect(await ids({ states: ['paused'] })).toEqual(['WB2']);
      expect(await ids({ states: ['active', 'paused'], scenarioId: 'S2' })).toEqual(['WB2']);
      expect(await ids({ states: ['stopped', 'expired'] })).toEqual([]);
    });

    it('update changes the fields of a live binding and nothing else', async () => {
      const { store, clock } = harness();
      const created = await store.workflowBindings.create(sampleWorkflowBinding());
      await advanceClock(harness(), 1000);
      const until = clock.now() + DAY;
      const changed = await store.workflowBindings.update('WB1', {
        versionRange: '2.1.x',
        params: { a: 1 },
        triggers: [{ type: 'manual' }],
        until,
        budgetUsd: 3,
        budgetPeriod: 'month',
        concurrency: 2,
        onBusy: 'replace',
      });
      expect(changed).toEqual({
        ...created,
        versionRange: '2.1.x',
        params: { a: 1 },
        triggers: [{ type: 'manual' }],
        until,
        budgetUsd: 3,
        budgetPeriod: 'month',
        concurrency: 2,
        onBusy: 'replace',
        updatedAt: clock.now(),
      });
      expect(await store.workflowBindings.get('WB1')).toEqual(changed);
      // A null clears the deadline and the budget; a field left out is kept.
      const cleared = await store.workflowBindings.update('WB1', { until: null, budgetUsd: null });
      expect(cleared).toMatchObject({ until: null, budgetUsd: null, concurrency: 2 });
    });

    it('update rejects a bad patch, an unknown id and a final binding', async () => {
      const { store, clock } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding());
      await expectCode(store.workflowBindings.update('WB1', { concurrency: 0 }), 'INVALID_INPUT');
      await expectCode(
        store.workflowBindings.update('WB1', { until: clock.now() }),
        'INVALID_INPUT',
      );
      await expectCode(
        store.workflowBindings.update('WB1', { state: 'stopped' } as never),
        'INVALID_INPUT',
      );
      await expectCode(
        store.workflowBindings.update('WB1', { scenarioId: 'S2' } as never),
        'INVALID_INPUT',
      );
      await expectCode(store.workflowBindings.update('WB9', { concurrency: 2 }), 'NOT_FOUND');
      await store.workflowBindings.transition('WB1', { to: 'stopped', reason: 'producer' });
      await expectCode(store.workflowBindings.update('WB1', { concurrency: 2 }), 'CONFLICT');
    });

    it('pauses, resumes and stops, keeping the reason of each state', async () => {
      const { store, clock } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding());
      await advanceClock(harness(), 10);
      const paused = await store.workflowBindings.transition('WB1', {
        to: 'paused',
        reason: 'producer',
      });
      expect(paused).toMatchObject({
        state: 'paused',
        stateReason: 'producer',
        stateChangedAt: clock.now(),
        updatedAt: clock.now(),
      });
      await advanceClock(harness(), 10);
      const resumed = await store.workflowBindings.transition('WB1', { to: 'active' });
      expect(resumed).toMatchObject({
        state: 'active',
        stateReason: null,
        stateChangedAt: clock.now(),
      });
      const budgetPause = await store.workflowBindings.transition('WB1', {
        to: 'paused',
        reason: 'budget',
      });
      expect(budgetPause.stateReason).toBe('budget');
      const stopped = await store.workflowBindings.transition('WB1', {
        to: 'stopped',
        reason: 'producer',
      });
      expect(stopped).toMatchObject({ state: 'stopped', stateReason: 'producer' });
      expect(await store.workflowBindings.get('WB1')).toEqual(stopped);
    });

    it('refuses the moves the state machine does not have', async () => {
      const { store } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding());
      const bindings = store.workflowBindings;
      // From active: resuming is refused, and so is expiring before any deadline.
      await expectCode(bindings.transition('WB1', { to: 'active' }), 'CONFLICT');
      await expectCode(bindings.transition('WB1', { to: 'expired' }), 'CONFLICT');
      // From paused: pausing again is refused.
      await bindings.transition('WB1', { to: 'paused', reason: 'producer' });
      await expectCode(bindings.transition('WB1', { to: 'paused', reason: 'budget' }), 'CONFLICT');
      // A final binding never moves again.
      await bindings.transition('WB1', { to: 'stopped', reason: 'budget' });
      await expectCode(bindings.transition('WB1', { to: 'active' }), 'CONFLICT');
      await expectCode(
        bindings.transition('WB1', { to: 'paused', reason: 'producer' }),
        'CONFLICT',
      );
      await expectCode(
        bindings.transition('WB1', { to: 'stopped', reason: 'producer' }),
        'CONFLICT',
      );
      await expectCode(bindings.transition('WB1', { to: 'expired' }), 'CONFLICT');
      await expectCode(
        bindings.transition('WB9', { to: 'stopped', reason: 'producer' }),
        'NOT_FOUND',
      );
      expect(await bindings.get('WB1')).toMatchObject({ state: 'stopped', stateReason: 'budget' });
    });

    it('checks the reason that goes with each target state', async () => {
      const { store } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding());
      const bad = async (to: string, reason?: string): Promise<void> => {
        await expectCode(
          store.workflowBindings.transition('WB1', {
            to: to as never,
            ...(reason === undefined ? {} : { reason: reason as never }),
          }),
          'INVALID_INPUT',
        );
      };
      await bad('paused');
      await bad('paused', 'deadline');
      await bad('stopped');
      await bad('stopped', 'deadline');
      await bad('expired', 'producer');
      await bad('moon', 'producer');
      await bad('paused', 'moon');
      expect(await store.workflowBindings.get('WB1')).toMatchObject({ state: 'active' });
    });

    it('expires only once the deadline has passed (fake clock), from active or paused', async () => {
      const { store, clock } = harness();
      const until = clock.now() + 1000;
      await store.workflowBindings.create(sampleWorkflowBinding({ until }));
      await store.workflowBindings.create(sampleWorkflowBinding({ scenarioId: 'S2', until }));
      await store.workflowBindings.transition('WB2', { to: 'paused', reason: 'producer' });
      await advanceClock(harness(), 999);
      await expectCode(store.workflowBindings.transition('WB1', { to: 'expired' }), 'CONFLICT');
      await advanceClock(harness(), 1);
      const expired = await store.workflowBindings.transition('WB1', { to: 'expired' });
      expect(expired).toMatchObject({
        state: 'expired',
        stateReason: 'deadline',
        stateChangedAt: clock.now(),
      });
      expect(
        await store.workflowBindings.transition('WB2', { to: 'expired', reason: 'deadline' }),
      ).toMatchObject({ state: 'expired', stateReason: 'deadline' });
      // A binding without a deadline never expires.
      await store.workflowBindings.create(sampleWorkflowBinding({ workflowId: 'review' }));
      await advanceClock(harness(), 365 * DAY);
      await expectCode(store.workflowBindings.transition('WB3', { to: 'expired' }), 'CONFLICT');
    });

    it('refuses to resume a binding whose deadline has passed', async () => {
      const { store, clock } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding({ until: clock.now() + 1000 }));
      await store.workflowBindings.transition('WB1', { to: 'paused', reason: 'producer' });
      await advanceClock(harness(), 1000);
      await expectCode(store.workflowBindings.transition('WB1', { to: 'active' }), 'CONFLICT');
      await store.workflowBindings.transition('WB1', { to: 'expired' });
    });

    it('recordSpend adds up in the period and starts again from zero in the next one', async () => {
      const { store, clock } = harness();
      const startedAt = clock.now();
      await store.workflowBindings.create(
        sampleWorkflowBinding({ budgetUsd: 1, budgetPeriod: 'day' }),
      );
      expect(await store.workflowBindings.recordSpend('WB1', 0.25)).toMatchObject({
        spentUsd: 0.25,
        periodStartedAt: startedAt,
      });
      expect(await store.workflowBindings.recordSpend('WB1', 0.5)).toMatchObject({
        spentUsd: 0.75,
      });
      await advanceClock(harness(), DAY - 1);
      expect(await store.workflowBindings.recordSpend('WB1', 0.25)).toMatchObject({
        spentUsd: 1,
        periodStartedAt: startedAt,
      });
      await advanceClock(harness(), 1);
      // The new period starts on the grid of the first one; this spend is the first of it.
      expect(await store.workflowBindings.recordSpend('WB1', 0.1)).toMatchObject({
        spentUsd: 0.1,
        periodStartedAt: startedAt + DAY,
      });
      // Several periods pass in silence: the start lands on the period that holds now.
      await advanceClock(harness(), 3 * DAY + 5);
      expect(await store.workflowBindings.recordSpend('WB1', 0)).toMatchObject({
        spentUsd: 0,
        periodStartedAt: startedAt + 4 * DAY,
      });
      await expectCode(store.workflowBindings.recordSpend('WB1', -1), 'INVALID_INPUT');
      await expectCode(store.workflowBindings.recordSpend('WB1', Number.NaN), 'INVALID_INPUT');
      await expectCode(store.workflowBindings.recordSpend('WB9', 1), 'NOT_FOUND');
    });

    it('recordSpend works in every state, and never moves the state itself', async () => {
      const { store } = harness();
      await store.workflowBindings.create(sampleWorkflowBinding({ budgetUsd: 1 }));
      const over = await store.workflowBindings.recordSpend('WB1', 2);
      expect(over).toMatchObject({ state: 'active', spentUsd: 2 });
      await store.workflowBindings.transition('WB1', { to: 'stopped', reason: 'budget' });
      expect(await store.workflowBindings.recordSpend('WB1', 1)).toMatchObject({
        state: 'stopped',
        spentUsd: 3,
      });
    });

    it('a binding paused by the budget resumes only in a new period', async () => {
      const { store, clock } = harness();
      await store.workflowBindings.create(
        sampleWorkflowBinding({ budgetUsd: 1, budgetPeriod: 'day' }),
      );
      await store.workflowBindings.recordSpend('WB1', 1);
      await store.workflowBindings.transition('WB1', { to: 'paused', reason: 'budget' });
      await expectCode(store.workflowBindings.transition('WB1', { to: 'active' }), 'CONFLICT');
      await advanceClock(harness(), DAY - 1);
      await expectCode(store.workflowBindings.transition('WB1', { to: 'active' }), 'CONFLICT');
      await advanceClock(harness(), 1);
      const resumed = await store.workflowBindings.transition('WB1', { to: 'active' });
      expect(resumed).toMatchObject({
        state: 'active',
        stateReason: null,
        spentUsd: 0,
        stateChangedAt: clock.now(),
      });
      // A producer's pause with the budget used up is refused the same way.
      await store.workflowBindings.recordSpend('WB1', 1);
      await store.workflowBindings.transition('WB1', { to: 'paused', reason: 'producer' });
      await expectCode(store.workflowBindings.transition('WB1', { to: 'active' }), 'CONFLICT');
    });

    it('rollPeriod starts a new period only when the current one is over', async () => {
      const { store } = harness();
      const created = await store.workflowBindings.create(
        sampleWorkflowBinding({ budgetUsd: 5, budgetPeriod: 'week' }),
      );
      await store.workflowBindings.recordSpend('WB1', 2);
      await advanceClock(harness(), 7 * DAY - 1);
      expect(await store.workflowBindings.rollPeriod('WB1')).toMatchObject({
        spentUsd: 2,
        periodStartedAt: created.periodStartedAt,
      });
      await advanceClock(harness(), 1);
      const rolled = await store.workflowBindings.rollPeriod('WB1');
      expect(rolled).toMatchObject({
        spentUsd: 0,
        periodStartedAt: created.periodStartedAt + 7 * DAY,
      });
      expect(await store.workflowBindings.get('WB1')).toEqual(rolled);
      expect(await store.workflowBindings.rollPeriod('WB1')).toEqual(rolled);
      await expectCode(store.workflowBindings.rollPeriod('WB9'), 'NOT_FOUND');
    });
  });
}
