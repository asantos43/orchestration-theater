// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { Store } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { buildDaemonRegistries } from '../registries.js';
import { ToolFailure, ToolHandlers, type ToolCall } from './handlers.js';
import { seedReadTools as seed } from './read-tools-fixture.js';
import { READ_TOOL_NAMES, readToolHandlers, registerReadTools } from './read-tools.js';

const registries = buildDaemonRegistries();

function newStore(): InMemoryStore {
  return new InMemoryStore({ clock: new FakeClock(1_000) });
}

/** `playId: null` is a session not tied to a play. */
function callOf(name: string, input: unknown, playId: string | null = 'p1'): ToolCall {
  const tool = registries.tools.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return {
    tool,
    input,
    caller: {
      role: 'actor',
      attemptId: 'p1/d1/1',
      sessionId: undefined,
      correlation: playId === null ? {} : { playId, demandId: 'd1', attemptId: 'p1/d1/1' },
      record: () => Promise.resolve(),
    },
  };
}

function run(store: Store, name: string, input: unknown, playId?: string | null): Promise<unknown> {
  const handler = readToolHandlers(store)[name];
  if (handler === undefined) return Promise.reject(new Error(`no handler ${name}`));
  return Promise.resolve(handler(callOf(name, input, playId)));
}

function failure(value: unknown): ToolFailure {
  expect(value).toBeInstanceOf(ToolFailure);
  return value as ToolFailure;
}

describe('read_blackboard', () => {
  it('returns the version asked for and, without one, the latest', async () => {
    const store = newStore();
    await seed(store);
    expect(await run(store, 'read_blackboard', { key: 'script', version: 1 })).toMatchObject({
      key: 'script',
      version: 1,
      value: { v: 1 },
      author: 'scriptwriter',
    });
    expect(await run(store, 'read_blackboard', { key: 'script' })).toMatchObject({
      version: 2,
      value: { v: 2 },
    });
    expect(await run(store, 'read_blackboard', { key: 'script', version: 2 })).toMatchObject({
      version: 2,
    });
  });

  it('answers not_found for a key or a version that is not there, and names the latest', async () => {
    const store = newStore();
    await seed(store);
    const noKey = failure(await run(store, 'read_blackboard', { key: 'nothing' }));
    expect(noKey.code).toBe('not_found');
    const noVersion = failure(await run(store, 'read_blackboard', { key: 'script', version: 9 }));
    expect(noVersion.code).toBe('not_found');
    expect(noVersion.message).toContain('no version 9');
    expect(noVersion.message).toContain('latest version is 2');
    // A version of a key that does not exist at all has no latest to point to.
    expect(
      failure(await run(store, 'read_blackboard', { key: 'nothing', version: 1 })).message,
    ).not.toContain('latest');
  });

  it('reads only the blackboard of the play of the caller', async () => {
    const store = newStore();
    await seed(store);
    expect(await run(store, 'read_blackboard', { key: 'script' }, 'p2')).toMatchObject({
      value: { other: 'play' },
    });
    expect(failure(await run(store, 'read_blackboard', { key: 'script' }, 'p3')).code).toBe(
      'not_found',
    );
  });

  it('answers no_play when the session is not tied to a play', async () => {
    const store = newStore();
    await seed(store);
    expect(failure(await run(store, 'read_blackboard', { key: 'script' }, null)).code).toBe(
      'no_play',
    );
  });
});

describe('read_contract', () => {
  it('reads the contract under contract/<id>, the version asked for or the latest', async () => {
    const store = newStore();
    await seed(store);
    expect(await run(store, 'read_contract', { id: 'c1', version: 1 })).toMatchObject({
      key: 'contract/c1',
      version: 1,
      value: { fn: 'f()' },
    });
    expect(await run(store, 'read_contract', { id: 'c1' })).toMatchObject({
      version: 2,
      value: { fn: 'f(a)' },
    });
  });

  it('answers not_found for an unknown contract or version', async () => {
    const store = newStore();
    await seed(store);
    const unknown = failure(await run(store, 'read_contract', { id: 'zz' }));
    expect(unknown.code).toBe('not_found');
    expect(unknown.message).toContain('"zz"');
    expect(failure(await run(store, 'read_contract', { id: 'c1', version: 5 })).message).toContain(
      'latest version is 2',
    );
  });
});

describe('read_decision', () => {
  it('reads a decision of the play and one of the scenario', async () => {
    const store = newStore();
    await seed(store);
    expect(await run(store, 'read_decision', { id: 'D-own' })).toMatchObject({
      id: 'D-own',
      kind: 'script_review',
      state: 'pending',
      input: { q: 'ok?' },
    });
    expect(await run(store, 'read_decision', { id: 'D-scenario' })).toMatchObject({
      id: 'D-scenario',
      playId: null,
    });
  });

  it('shows the answer once the decision is made', async () => {
    const store = newStore();
    await seed(store);
    await store.decisions.decide('D-own', { answer: { ok: true }, decidedBy: 'producer' });
    expect(await run(store, 'read_decision', { id: 'D-own' })).toMatchObject({
      state: 'decided',
      answer: { ok: true },
      decidedBy: 'producer',
    });
  });

  it('hides the decisions of another play and of another scenario, as an unknown id', async () => {
    const store = newStore();
    await seed(store);
    for (const id of ['D-sibling', 'D-foreign', 'D-nope']) {
      expect(failure(await run(store, 'read_decision', { id })).code, id).toBe('not_found');
    }
  });
});

describe('registerReadTools', () => {
  it('registers the three tools and leaves one that already has a handler alone', () => {
    const store = newStore();
    const handlers = new ToolHandlers();
    const mine = (): string => 'mine';
    handlers.register('read_decision', mine);
    registerReadTools(handlers, store);
    expect(READ_TOOL_NAMES.every((name) => handlers.has(name))).toBe(true);
    expect(handlers.get('read_decision')).toBe(mine);
    // A second call is harmless.
    expect(() => registerReadTools(handlers, store)).not.toThrow();
  });
});
