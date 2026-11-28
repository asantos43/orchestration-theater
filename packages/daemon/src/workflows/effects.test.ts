// SPDX-License-Identifier: MPL-2.0
import type { SideEffectRecord } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import {
  WORKFLOW_EFFECT_OWNER,
  WORKFLOW_EFFECT_TYPES,
  registerWorkflowEffects,
  verifyApproval,
  verifyNotify,
} from './effects.js';

function recordOf(params: Record<string, unknown> | null): SideEffectRecord {
  return {
    idempotencyKey: 'run-1:announce:1',
    type: WORKFLOW_EFFECT_TYPES.notify,
    target: 'run-1',
    params,
    state: 'pending',
  } as unknown as SideEffectRecord;
}

async function notified(store: InMemoryStore, run: string, node: string): Promise<number> {
  const event = await store.events.append({
    type: 'workflow.notified',
    schemaVersion: 1,
    payload: { node, message: 'x' },
    playId: run,
  });
  return event.id;
}

describe('verifyNotify', () => {
  it('is done when the notice of that run and node is in the log after the noted position', async () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    const since = await store.events.lastId();
    const id = await notified(store, 'run-1', 'announce');
    expect(await verifyNotify(store, recordOf({ run: 'run-1', node: 'announce', since }))).toEqual({
      verdict: 'done',
      result: { event_id: id },
    });
  });

  it('is not_done when the notice is of another run or node, or came before the step began', async () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    await notified(store, 'run-1', 'announce');
    const since = await store.events.lastId();
    await notified(store, 'run-2', 'announce');
    await notified(store, 'run-1', 'other');
    expect(await verifyNotify(store, recordOf({ run: 'run-1', node: 'announce', since }))).toEqual({
      verdict: 'not_done',
    });
  });

  it('is ambiguous when the record does not say which notice to look for', async () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    expect((await verifyNotify(store, recordOf(null))).verdict).toBe('ambiguous');
    expect((await verifyNotify(store, recordOf({ run: 'run-1' }))).verdict).toBe('ambiguous');
  });
});

describe('verifyApproval and registerWorkflowEffects', () => {
  it('an open approval is always not_done: the step asks again', () => {
    expect(verifyApproval()).toEqual({ verdict: 'not_done' });
  });

  it('registers both verifiers under the name of the engine', () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    const registry = new PluginEffectRegistry();
    registerWorkflowEffects(registry, store);
    expect(WORKFLOW_EFFECT_OWNER).toBe('workflow');
    for (const type of Object.values(WORKFLOW_EFFECT_TYPES)) {
      expect(registry.has(type)).toBe(true);
    }
  });
});
