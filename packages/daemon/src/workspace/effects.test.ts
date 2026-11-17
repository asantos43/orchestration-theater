// SPDX-License-Identifier: MPL-2.0
import { Conflict, type JsonObject } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import {
  type EffectSpec,
  type EffectVerdict,
  MAX_EFFECT_ATTEMPTS,
  effectKey,
  runEffect,
} from './effects.js';

function makeStore(): InMemoryStore {
  return new InMemoryStore({ clock: new FakeClock() });
}

/** A step whose effect and verifier are scripted by the test. */
function step(
  overrides: Partial<EffectSpec> & { verdict?: EffectVerdict } = {},
): EffectSpec & { executed: string[] } {
  const executed: string[] = [];
  const { verdict, ...rest } = overrides;
  return {
    key: 'play-1:step',
    type: 'git_commit',
    target: 'play/play-1/integration',
    params: { repo: '/r' },
    executed,
    execute: (key) => {
      executed.push(key);
      return Promise.resolve({ sha: 'abc1234' } satisfies JsonObject);
    },
    verify: () => Promise.resolve(verdict ?? { verdict: 'not_done' }),
    ...rest,
  };
}

describe('runEffect (architecture 5.21)', () => {
  it('writes the intent, runs the effect and resolves it done', async () => {
    const store = makeStore();
    const spec = step();
    const outcome = await runEffect(store.sideEffects, spec);
    expect(outcome).toEqual({
      kind: 'done',
      key: 'play-1:step',
      result: { sha: 'abc1234' },
      origin: 'executed',
    });
    const record = await store.sideEffects.get('play-1:step');
    expect(record).toMatchObject({
      state: 'done',
      type: 'git_commit',
      target: 'play/play-1/integration',
      params: { repo: '/r' },
      result: { sha: 'abc1234' },
    });
    expect(record?.resolvedAt).not.toBeNull();
  });

  it('the intent exists before the effect runs', async () => {
    const store = makeStore();
    let seen: string | undefined;
    const spec = step({
      execute: async (key) => {
        seen = (await store.sideEffects.get(key))?.state;
        return {};
      },
    });
    await runEffect(store.sideEffects, spec);
    expect(seen).toBe('pending');
  });

  it('a repetition of a finished step replays the result and does not run it again', async () => {
    const store = makeStore();
    const spec = step();
    await runEffect(store.sideEffects, spec);
    const again = await runEffect(store.sideEffects, spec);
    expect(again).toMatchObject({ kind: 'done', origin: 'replayed', result: { sha: 'abc1234' } });
    expect(spec.executed).toEqual(['play-1:step']);
  });

  it('records a failed effect, rethrows the error and uses a new key on the next run', async () => {
    const store = makeStore();
    const boom = new Error('boom');
    const failing = step({ execute: () => Promise.reject(boom) });
    await expect(runEffect(store.sideEffects, failing)).rejects.toBe(boom);
    expect((await store.sideEffects.get('play-1:step'))?.state).toBe('failed');

    const retry = step();
    const outcome = await runEffect(store.sideEffects, retry);
    expect(outcome).toMatchObject({ kind: 'done', key: 'play-1:step~2', origin: 'executed' });
    expect(retry.executed).toEqual(['play-1:step~2']);
  });

  it('settles an interrupted step as done when the verifier finds the effect', async () => {
    const store = makeStore();
    await store.sideEffects.intend({
      idempotencyKey: 'play-1:step',
      type: 'git_commit',
      target: 'play/play-1/integration',
      params: { repo: '/r' },
    });
    const spec = step({ verdict: { verdict: 'done', result: { sha: 'found123' } } });
    const outcome = await runEffect(store.sideEffects, spec);
    expect(outcome).toEqual({
      kind: 'done',
      key: 'play-1:step',
      result: { sha: 'found123' },
      origin: 'verified',
    });
    expect(spec.executed).toEqual([]);
    expect(await store.sideEffects.get('play-1:step')).toMatchObject({
      state: 'done',
      verifier: 'verifier',
      result: { sha: 'found123' },
    });
  });

  it('runs the effect again, under a new key, when the verifier says it did not happen', async () => {
    const store = makeStore();
    await store.sideEffects.intend({
      idempotencyKey: 'play-1:step',
      type: 'git_commit',
      target: 'play/play-1/integration',
    });
    const spec = step({ verdict: { verdict: 'not_done' } });
    const outcome = await runEffect(store.sideEffects, spec);
    expect(outcome).toMatchObject({ kind: 'done', key: 'play-1:step~2', origin: 'executed' });
    expect(await store.sideEffects.get('play-1:step')).toMatchObject({
      state: 'not_done',
      verifier: 'verifier',
    });
  });

  it('keeps the record ambiguous when the verifier cannot tell, and tries again later', async () => {
    const store = makeStore();
    await store.sideEffects.intend({
      idempotencyKey: 'play-1:step',
      type: 'git_commit',
      target: 'play/play-1/integration',
    });
    const unsure = step({ verdict: { verdict: 'ambiguous', reason: 'host unreachable' } });
    expect(await runEffect(store.sideEffects, unsure)).toEqual({
      kind: 'ambiguous',
      key: 'play-1:step',
      reason: 'host unreachable',
    });
    expect(unsure.executed).toEqual([]);
    expect((await store.sideEffects.get('play-1:step'))?.state).toBe('ambiguous');

    // The host is back: an ambiguous record is verified again.
    const sure = step({ verdict: { verdict: 'done', result: { sha: 'late1234' } } });
    expect(await runEffect(store.sideEffects, sure)).toMatchObject({
      kind: 'done',
      origin: 'verified',
    });
    expect((await store.sideEffects.get('play-1:step'))?.state).toBe('done');
  });

  it('a verifier that throws is ambiguous, never "not done"', async () => {
    const store = makeStore();
    await store.sideEffects.intend({
      idempotencyKey: 'play-1:step',
      type: 'git_commit',
      target: 'play/play-1/integration',
    });
    const spec = step({ verify: () => Promise.reject(new Error('network down')) });
    const outcome = await runEffect(store.sideEffects, spec);
    expect(outcome).toMatchObject({ kind: 'ambiguous', key: 'play-1:step' });
    expect(outcome.kind === 'ambiguous' && outcome.reason).toContain('network down');
    expect(spec.executed).toEqual([]);
  });

  it('gives up with Conflict when every key of the step is used', async () => {
    const store = makeStore();
    for (let n = 1; n <= MAX_EFFECT_ATTEMPTS; n += 1) {
      const key = effectKey('play-1:step', n);
      await store.sideEffects.intend({ idempotencyKey: key, type: 'git_commit', target: 't' });
      await store.sideEffects.resolve(key, { state: 'failed' });
    }
    await expect(runEffect(store.sideEffects, step())).rejects.toBeInstanceOf(Conflict);
  });

  it('effectKey keeps the base key for the first run', () => {
    expect(effectKey('k', 1)).toBe('k');
    expect(effectKey('k', 3)).toBe('k~3');
  });
});
