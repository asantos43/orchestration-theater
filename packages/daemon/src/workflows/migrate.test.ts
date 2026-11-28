// SPDX-License-Identifier: MPL-2.0
import { InMemoryStore, FakeClock } from '@otheater/core/testing';
import { validateWorkflow, type ValidWorkflow } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import {
  ticketV20,
  ticketV21,
  ticketV22NoMapping,
  ticketV25RenamedLimit,
} from './fixtures/migration-fixture.js';
import { carryCounts, hasOpenEffects, isSafeNode, mappingOf, mapState } from './migrate.js';

function valid(definition: Record<string, unknown>): ValidWorkflow {
  const result = validateWorkflow(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.workflow;
}

describe('mappingOf', () => {
  it('gives the map the new version declares for the version of the run', () => {
    const result = mappingOf(valid(ticketV20()), valid(ticketV21()));
    expect(result).toEqual({
      ok: true,
      map: { announce: 'announce', review: 'review', publish: 'ship', wait: 'wait' },
    });
  });

  it('refuses a version that has no map for it', () => {
    expect(mappingOf(valid(ticketV20()), valid(ticketV22NoMapping()))).toMatchObject({
      ok: false,
      reason: 'no_mapping',
    });
  });

  it('refuses a map whose source is not a node of the old version', () => {
    const to = valid({ ...ticketV21(), migrate_from: { '2.0.0': { ghost: 'review' } } });
    expect(mappingOf(valid(ticketV20()), to)).toMatchObject({
      ok: false,
      reason: 'mapping_invalid',
      detail: 'ghost is not a node of ticket@2.0.0',
    });
  });
});

describe('mapState', () => {
  const map = { review: 'review', publish: 'ship' };

  it('says where a node goes, and refuses one the map does not name', () => {
    expect(mapState(map, 'publish')).toEqual({ ok: true, toState: 'ship' });
    expect(mapState(map, 'wait')).toMatchObject({ ok: false, reason: 'state_unmapped' });
    // A name of the prototype is not a node.
    expect(mapState(map, 'constructor')).toMatchObject({ ok: false, reason: 'state_unmapped' });
  });
});

describe('carryCounts', () => {
  it('keeps the keys the new version has and names the ones it drops', () => {
    expect(carryCounts({ redo: 1, gone: 2, also: 1 }, valid(ticketV21()))).toEqual({
      counts: { redo: 1 },
      dropped: ['also', 'gone'],
    });
    expect(carryCounts({ redo: 1 }, valid(ticketV25RenamedLimit()))).toEqual({
      counts: {},
      dropped: ['redo'],
    });
    expect(carryCounts({}, valid(ticketV21()))).toEqual({ counts: {}, dropped: [] });
  });
});

describe('isSafeNode', () => {
  it('reads the safe point of the step type of the node', () => {
    const workflow = valid(ticketV21());
    expect(isSafeNode(workflow, 'review')).toBe(true);
    expect(isSafeNode(workflow, 'nowhere')).toBe(false);
  });
});

describe('hasOpenEffects', () => {
  it('sees a pending or ambiguous effect of the run, and only of that run', async () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    const base = { type: 'demo.write', target: 'doc-1' };
    expect(await hasOpenEffects(store, 'run-1')).toBe(false);

    await store.sideEffects.intend({ idempotencyKey: 'run-10:a:1', ...base });
    expect(await hasOpenEffects(store, 'run-1')).toBe(false);

    await store.sideEffects.intend({ idempotencyKey: 'run-1:a:1', ...base });
    expect(await hasOpenEffects(store, 'run-1')).toBe(true);

    await store.sideEffects.resolve('run-1:a:1', { state: 'ambiguous' });
    expect(await hasOpenEffects(store, 'run-1')).toBe(true);

    await store.sideEffects.resolve('run-1:a:1', { state: 'done' });
    expect(await hasOpenEffects(store, 'run-1')).toBe(false);
  });
});
