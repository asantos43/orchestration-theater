// SPDX-License-Identifier: MPL-2.0
import type { JsonObject } from '@otheater/core';
import { Conflict } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { EffectVerdict } from './effects.js';
import { PluginEffectRegistry, runPluginEffect, type PluginEffect } from './plugin-effects.js';

/** A plugin that "sends a message": the world is a list of messages, and its verifier reads it. */
function fakePlugin(sent: string[], verdictOverride?: () => Promise<EffectVerdict>): PluginEffect {
  return {
    type: 'fake.send',
    verify: (record) => {
      if (verdictOverride !== undefined) return verdictOverride();
      const id = record.params?.messageId;
      return Promise.resolve(
        typeof id === 'string' && sent.includes(id)
          ? { verdict: 'done', result: { messageId: id, found: true } }
          : { verdict: 'not_done' },
      );
    },
  };
}

function specOf(sent: string[], key = 'p1:fake.send:a1:1') {
  return {
    key,
    type: 'fake.send',
    target: 'room',
    attemptId: 'a1',
    params: { messageId: 'm1' } satisfies JsonObject,
    execute: (): Promise<JsonObject> => {
      sent.push('m1');
      return Promise.resolve({ messageId: 'm1' });
    },
  };
}

describe('the hook of the effects of plugins (P22)', () => {
  it('accepts only <plugin>.<effect> types, and one owner per type', () => {
    const registry = new PluginEffectRegistry();
    const effect = fakePlugin([]);
    expect(() => {
      registry.register('other', effect);
    }).toThrow(Conflict);
    expect(() => {
      registry.register('fake', { ...effect, type: 'git_commit' });
    }).toThrow(Conflict);
    expect(() => {
      registry.register('fake', { ...effect, type: 'fake.' });
    }).toThrow(Conflict);
    registry.register('fake', effect);
    expect(registry.has('fake.send')).toBe(true);
    expect(() => {
      registry.register('fake', effect);
    }).toThrow(/already declared/);
  });

  it('writes the before and the after, and replays a finished effect', async () => {
    const sent: string[] = [];
    const registry = new PluginEffectRegistry();
    registry.register('fake', fakePlugin(sent));
    const store = new InMemoryStore({ clock: new FakeClock() });

    const first = await runPluginEffect(store.sideEffects, registry, specOf(sent));
    expect(first).toMatchObject({ kind: 'done', origin: 'executed' });
    expect(await store.sideEffects.get('p1:fake.send:a1:1')).toMatchObject({
      state: 'done',
      type: 'fake.send',
    });

    const again = await runPluginEffect(store.sideEffects, registry, specOf(sent));
    expect(again).toMatchObject({ kind: 'done', origin: 'replayed' });
    expect(sent).toEqual(['m1']);
  });

  it('settles an open record with the verifier of the plugin, never by running again', async () => {
    const sent = ['m1'];
    const registry = new PluginEffectRegistry();
    registry.register('fake', fakePlugin(sent));
    const store = new InMemoryStore({ clock: new FakeClock() });
    // The crash: the "before" was written and the message went out, with no "after".
    await store.sideEffects.intend({
      idempotencyKey: 'p1:fake.send:a1:1',
      type: 'fake.send',
      target: 'room',
      params: { messageId: 'm1' },
    });
    const outcome = await runPluginEffect(store.sideEffects, registry, specOf(sent));
    expect(outcome).toMatchObject({ kind: 'done', origin: 'verified' });
    expect(sent).toEqual(['m1']);
  });

  it('runs on a new key when the verifier says it did not happen', async () => {
    const sent: string[] = [];
    const registry = new PluginEffectRegistry();
    registry.register('fake', fakePlugin(sent));
    const store = new InMemoryStore({ clock: new FakeClock() });
    await store.sideEffects.intend({
      idempotencyKey: 'p1:fake.send:a1:1',
      type: 'fake.send',
      target: 'room',
      params: { messageId: 'm1' },
    });
    const outcome = await runPluginEffect(store.sideEffects, registry, specOf(sent));
    expect(outcome).toMatchObject({ kind: 'done', origin: 'executed', key: 'p1:fake.send:a1:1~2' });
    expect(sent).toEqual(['m1']);
  });

  it('stays ambiguous when the verifier cannot tell or throws', async () => {
    for (const verdict of [
      (): Promise<EffectVerdict> => Promise.resolve({ verdict: 'ambiguous', reason: 'offline' }),
      (): Promise<EffectVerdict> => Promise.reject(new Error('boom')),
    ]) {
      const sent: string[] = [];
      const registry = new PluginEffectRegistry();
      registry.register('fake', fakePlugin(sent, verdict));
      const store = new InMemoryStore({ clock: new FakeClock() });
      await store.sideEffects.intend({
        idempotencyKey: 'p1:fake.send:a1:1',
        type: 'fake.send',
        target: 'room',
      });
      const outcome = await runPluginEffect(store.sideEffects, registry, specOf(sent));
      expect(outcome.kind).toBe('ambiguous');
      expect(sent).toEqual([]);
      expect((await store.sideEffects.get('p1:fake.send:a1:1'))?.state).toBe('ambiguous');
    }
  });

  it('refuses to run an effect no plugin declared', async () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    await expect(
      runPluginEffect(store.sideEffects, new PluginEffectRegistry(), specOf([])),
    ).rejects.toThrow(Conflict);
    expect(await store.sideEffects.list()).toEqual([]);
  });
});
