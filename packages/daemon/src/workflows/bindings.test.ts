// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput, NotFound, WORKFLOW_BUDGET_PERIOD_MS } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { PLAY_WORKFLOW } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import {
  type BudgetWarning,
  parseDeadline,
  WorkflowBindings,
  type WorkflowBindingsDeps,
} from './bindings.js';
import { DEFAULT_WORKFLOWS_SETTINGS, type WorkflowsSettings } from './config.js';
import { WorkflowLibrary } from './library.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Rig {
  readonly clock: FakeClock;
  readonly store: InMemoryStore;
  readonly bindings: WorkflowBindings;
  readonly library: WorkflowLibrary;
  readonly warnings: BudgetWarning[];
  settings: WorkflowsSettings;
}

async function rig(overrides: Partial<WorkflowsSettings> = {}): Promise<Rig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const state = { settings: { ...DEFAULT_WORKFLOWS_SETTINGS, ...overrides } };
  const library = new WorkflowLibrary({ store, settings: () => state.settings });
  await library.install(PLAY_WORKFLOW, { source: 'builtin' });
  await library.install({ ...PLAY_WORKFLOW, id: 'review-loop' }, { source: 'user' });
  for (const id of ['s1', 's2']) {
    await store.scenarios.create({
      id,
      kind: 'project',
      flowId: 'play',
      name: id,
      folder: `/work/${id}`,
      baseBranch: 'main',
    });
  }
  const warnings: BudgetWarning[] = [];
  const deps: WorkflowBindingsDeps = {
    store,
    library,
    clock,
    settings: () => state.settings,
    logger: createSilentLogger(),
    onBudgetExhausted: (warning) => warnings.push(warning),
  };
  const result: Rig = {
    clock,
    store,
    library,
    bindings: new WorkflowBindings(deps),
    warnings,
    get settings() {
      return state.settings;
    },
    set settings(value) {
      state.settings = value;
    },
  };
  return result;
}

/** The events of a type, with their payloads, in the order they were written. */
async function eventsOf(
  store: InMemoryStore,
  type: string,
): Promise<readonly Record<string, unknown>[]> {
  const all = await store.events.readFrom(0, 1000);
  return all
    .filter((event) => event.type === type)
    .map((event) => event.payload as Record<string, unknown>);
}

describe('parseDeadline', () => {
  it('reads a date, a duration from now and none', () => {
    expect(parseDeadline(5_000, 1_000)).toBe(5_000);
    expect(parseDeadline('90m', 1_000)).toBe(1_000 + 90 * 60_000);
    expect(parseDeadline('7d', 0)).toBe(7 * DAY);
    expect(parseDeadline('none', 1_000)).toBeNull();
    expect(parseDeadline(null, 1_000)).toBeNull();
  });

  it('refuses anything else', () => {
    expect(() => parseDeadline('soon', 0)).toThrow(InvalidInput);
    expect(() => parseDeadline('0d', 0)).toThrow(InvalidInput);
    expect(() => parseDeadline(-1, 0)).toThrow(InvalidInput);
    expect(() => parseDeadline(1.5, 0)).toThrow(InvalidInput);
  });
});

describe('WorkflowBindings.create', () => {
  it('takes the defaults of workflows.binding and workflows.budget, and announces it', async () => {
    const r = await rig({
      binding: { concurrency: 3, on_busy: 'skip' },
      budget: { on_exhausted: 'pause', period: 'week' },
    });
    const created = await r.bindings.create({ scenarioId: 's1', workflowId: 'play' });
    expect(created).toMatchObject({
      id: 'WB1',
      state: 'active',
      versionRange: '*',
      concurrency: 3,
      onBusy: 'skip',
      budgetPeriod: 'week',
      until: null,
      budgetUsd: null,
    });
    expect(await eventsOf(r.store, 'workflow.binding.changed')).toEqual([
      {
        bindingId: 'WB1',
        scenarioId: 's1',
        workflowId: 'play',
        from: null,
        to: 'active',
        reason: null,
      },
    ]);
  });

  it('what the request gives wins over the defaults; until is a duration from the clock', async () => {
    const r = await rig();
    const created = await r.bindings.create({
      scenarioId: 's1',
      workflowId: 'play',
      versionRange: '2.x',
      until: '2d',
      budgetUsd: 5,
      budgetPeriod: 'month',
      concurrency: 2,
      onBusy: 'replace',
      params: { skip_critique: true },
      triggers: [{ type: 'manual' }],
    });
    expect(created).toMatchObject({
      versionRange: '2.x',
      until: r.clock.now() + 2 * DAY,
      budgetUsd: 5,
      budgetPeriod: 'month',
      concurrency: 2,
      onBusy: 'replace',
      params: { skip_critique: true },
      triggers: [{ type: 'manual' }],
    });
  });

  it('needs a workflow that is allowed and a version of the library the range reaches', async () => {
    const r = await rig({ allowed: ['play'] });
    await expect(
      r.bindings.create({ scenarioId: 's1', workflowId: 'review-loop' }),
    ).rejects.toThrow(InvalidInput);
    await expect(
      r.bindings.create({ scenarioId: 's1', workflowId: 'play', versionRange: '9.x' }),
    ).rejects.toBeInstanceOf(NotFound);
    expect(await r.bindings.list()).toEqual([]);
    const open = await rig();
    await expect(
      open.bindings.create({ scenarioId: 's1', workflowId: 'unknown-workflow' }),
    ).rejects.toBeInstanceOf(NotFound);
  });

  it('a scenario has one live binding per workflow', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play' });
    await expect(
      r.bindings.create({ scenarioId: 's1', workflowId: 'play' }),
    ).rejects.toBeInstanceOf(Conflict);
    await r.bindings.create({ scenarioId: 's2', workflowId: 'play' });
    await r.bindings.create({ scenarioId: 's1', workflowId: 'review-loop' });
    expect((await r.bindings.active('s1')).map((b) => b.workflowId)).toEqual([
      'play',
      'review-loop',
    ]);
  });
});

describe('the state of a binding, with the fake clock', () => {
  it('the Producer pauses, resumes and stops it; each move is an event', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play' });
    expect(await r.bindings.pause('WB1')).toMatchObject({
      state: 'paused',
      stateReason: 'producer',
    });
    expect(await r.bindings.active('s1')).toEqual([]);
    expect(await r.bindings.resume('WB1')).toMatchObject({ state: 'active', stateReason: null });
    expect(await r.bindings.stop('WB1')).toMatchObject({
      state: 'stopped',
      stateReason: 'producer',
    });
    await expect(r.bindings.resume('WB1')).rejects.toBeInstanceOf(Conflict);
    await expect(r.bindings.update('WB1', { concurrency: 2 })).rejects.toBeInstanceOf(Conflict);
    const moves = (await eventsOf(r.store, 'workflow.binding.changed')).map((e) => [
      e.from,
      e.to,
      e.reason,
    ]);
    expect(moves).toEqual([
      [null, 'active', null],
      ['active', 'paused', 'producer'],
      ['paused', 'active', null],
      ['active', 'stopped', 'producer'],
    ]);
  });

  it('an unknown binding is not found', async () => {
    const r = await rig();
    await expect(r.bindings.pause('WB9')).rejects.toBeInstanceOf(NotFound);
  });

  it('update changes a live binding, with the deadline in any form', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play' });
    const updated = await r.bindings.update('WB1', { until: '1d', concurrency: 4, onBusy: 'skip' });
    expect(updated).toMatchObject({ until: r.clock.now() + DAY, concurrency: 4, onBusy: 'skip' });
    expect((await r.bindings.update('WB1', { until: 'none' })).until).toBeNull();
  });

  it('tick expires a binding once its deadline passes, and not before', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', until: '2h' });
    await r.bindings.create({ scenarioId: 's2', workflowId: 'play' });
    await r.clock.advance(HOUR);
    expect(await r.bindings.tick()).toEqual([]);
    await r.clock.advance(HOUR);
    const changed = await r.bindings.tick();
    expect(changed.map((b) => [b.id, b.state, b.stateReason])).toEqual([
      ['WB1', 'expired', 'deadline'],
    ]);
    expect(await r.bindings.get('WB2')).toMatchObject({ state: 'active' });
    expect(await r.bindings.tick()).toEqual([]);
    expect((await eventsOf(r.store, 'workflow.binding.changed')).at(-1)).toEqual({
      bindingId: 'WB1',
      scenarioId: 's1',
      workflowId: 'play',
      from: 'active',
      to: 'expired',
      reason: 'deadline',
    });
  });

  it('a paused binding expires too, and an expired one cannot be resumed', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', until: '1h' });
    await r.bindings.pause('WB1');
    await r.clock.advance(HOUR);
    await r.bindings.tick();
    expect(await r.bindings.get('WB1')).toMatchObject({ state: 'expired' });
    await expect(r.bindings.resume('WB1')).rejects.toBeInstanceOf(Conflict);
  });

  it('a binding paused by the Producer past its deadline cannot be resumed before the tick', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', until: '1h' });
    await r.bindings.pause('WB1');
    await r.clock.advance(2 * HOUR);
    await expect(r.bindings.resume('WB1')).rejects.toBeInstanceOf(Conflict);
  });
});

describe('the budget of a binding', () => {
  it('adds up, and pauses the binding when it reaches the budget (default), with an event and a warning', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', budgetUsd: 10 });
    expect(await r.bindings.recordSpend('WB1', 4)).toMatchObject({ state: 'active', spentUsd: 4 });
    expect(r.warnings).toEqual([]);
    const after = await r.bindings.recordSpend('WB1', 6);
    expect(after).toMatchObject({ state: 'paused', stateReason: 'budget', spentUsd: 10 });
    expect(await eventsOf(r.store, 'workflow.budget_exhausted')).toEqual([
      {
        bindingId: 'WB1',
        scenarioId: 's1',
        workflowId: 'play',
        budgetUsd: 10,
        spentUsd: 10,
        period: 'day',
        periodStartedAt: after.periodStartedAt,
        action: 'pause',
      },
    ]);
    expect((await eventsOf(r.store, 'workflow.binding.changed')).at(-1)).toMatchObject({
      from: 'active',
      to: 'paused',
      reason: 'budget',
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ action: 'pause' });
    expect(r.warnings[0]?.text).toMatch(/WB1.*10\.00 of 10\.00 USD/);
  });

  it('a spend after the pause is still recorded and does not repeat the event', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', budgetUsd: 1 });
    await r.bindings.recordSpend('WB1', 1);
    expect(await r.bindings.recordSpend('WB1', 0.5)).toMatchObject({
      state: 'paused',
      spentUsd: 1.5,
    });
    expect(await eventsOf(r.store, 'workflow.budget_exhausted')).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });

  it('workflows.budget.on_exhausted: stop ends the binding', async () => {
    const r = await rig({ budget: { on_exhausted: 'stop', period: 'day' } });
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', budgetUsd: 2 });
    expect(await r.bindings.recordSpend('WB1', 2)).toMatchObject({
      state: 'stopped',
      stateReason: 'budget',
    });
    expect((await eventsOf(r.store, 'workflow.budget_exhausted'))[0]).toMatchObject({
      action: 'stop',
    });
    await r.clock.advance(2 * DAY);
    expect(await r.bindings.tick()).toEqual([]);
    expect(await r.bindings.get('WB1')).toMatchObject({ state: 'stopped' });
  });

  it('a binding with no budget never pauses', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play' });
    expect(await r.bindings.recordSpend('WB1', 1000)).toMatchObject({ state: 'active' });
    expect(await eventsOf(r.store, 'workflow.budget_exhausted')).toEqual([]);
  });

  it('the Producer can resume only in a new period; tick resumes a budget pause by itself', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', budgetUsd: 3 });
    await r.bindings.recordSpend('WB1', 3);
    await expect(r.bindings.resume('WB1')).rejects.toBeInstanceOf(Conflict);
    await r.clock.advance(WORKFLOW_BUDGET_PERIOD_MS.day - HOUR);
    expect(await r.bindings.tick()).toEqual([]);
    await r.clock.advance(HOUR);
    const changed = await r.bindings.tick();
    expect(changed.map((b) => [b.id, b.state, b.spentUsd])).toEqual([['WB1', 'active', 0]]);
    expect((await eventsOf(r.store, 'workflow.binding.changed')).at(-1)).toMatchObject({
      from: 'paused',
      to: 'active',
      reason: null,
    });
    // The new period counts from zero and can run out again.
    expect(await r.bindings.recordSpend('WB1', 3)).toMatchObject({ state: 'paused' });
    expect(await eventsOf(r.store, 'workflow.budget_exhausted')).toHaveLength(2);
  });

  it('tick does not resume a pause the Producer made', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', budgetUsd: 3 });
    await r.bindings.pause('WB1');
    await r.clock.advance(3 * DAY);
    expect(await r.bindings.tick()).toEqual([]);
    expect(await r.bindings.get('WB1')).toMatchObject({ state: 'paused', stateReason: 'producer' });
  });

  it('the period of a binding follows workflows.budget.period', async () => {
    const r = await rig({ budget: { on_exhausted: 'pause', period: 'week' } });
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', budgetUsd: 1 });
    await r.bindings.recordSpend('WB1', 1);
    await r.clock.advance(2 * DAY);
    expect(await r.bindings.tick()).toEqual([]);
    await r.clock.advance(5 * DAY);
    expect((await r.bindings.tick()).map((b) => b.state)).toEqual(['active']);
  });

  it('a bad amount is refused and nothing changes', async () => {
    const r = await rig();
    await r.bindings.create({ scenarioId: 's1', workflowId: 'play', budgetUsd: 1 });
    await expect(r.bindings.recordSpend('WB1', -1)).rejects.toBeInstanceOf(InvalidInput);
    await expect(r.bindings.recordSpend('WB1', Number.NaN)).rejects.toBeInstanceOf(InvalidInput);
    expect(await r.bindings.get('WB1')).toMatchObject({ spentUsd: 0, state: 'active' });
  });
});
