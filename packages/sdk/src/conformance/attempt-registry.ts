// SPDX-License-Identifier: MPL-2.0
import type { AttemptRecordInput, Store } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { sampleEvent } from './event-log.js';
import { rejectionOf } from './helpers.js';

interface RegistryHarness extends Disposable {
  readonly store: Store;
}

/** A valid attempt record; `n` varies the key and the number. */
export function sampleAttempt(
  n: number,
  extra: Partial<AttemptRecordInput> = {},
): AttemptRecordInput {
  return {
    attemptId: `attempt-${String(n)}`,
    playId: 'play-1',
    demandId: 'demand-1',
    attempt: n,
    client: 'fake',
    profile: 'default',
    state: 'executing',
    cause: null,
    sessionId: null,
    worktree: `/tmp/wt/${String(n)}`,
    branch: `play/play-1/attempts/demand-1/${String(n)}`,
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    ...extra,
  };
}

/**
 * Registers the `AttemptRegistry` conformance tests: put/get/list, validation, and the
 * transaction rules (read-your-writes, rollback, `CONFLICT` on a leaked handle).
 */
export function describeAttemptRegistryConformance(
  name: string,
  factory: AdapterFactory<RegistryHarness>,
): void {
  describe(`AttemptRegistry conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('get resolves undefined for an unknown attempt', async () => {
      expect(await harness().store.attempts.get('nope')).toBeUndefined();
    });

    it('put stores the record, stamping createdAt and updatedAt', async () => {
      const { store } = harness();
      const stored = await store.attempts.put(sampleAttempt(1, { sessionId: 'sess-1' }));
      expect(stored).toMatchObject({ ...sampleAttempt(1, { sessionId: 'sess-1' }) });
      expect(stored.createdAt).toBeGreaterThanOrEqual(0);
      expect(stored.updatedAt).toBeGreaterThanOrEqual(stored.createdAt);
      expect(await store.attempts.get('attempt-1')).toEqual(stored);
    });

    it('put on an existing id replaces it and keeps createdAt', async () => {
      const { store } = harness();
      const first = await store.attempts.put(sampleAttempt(1));
      const second = await store.attempts.put(
        sampleAttempt(1, { state: 'interrupted', cause: 'client_crash', lastCheckpoint: 'abc123' }),
      );
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
      expect(await store.attempts.get('attempt-1')).toMatchObject({
        state: 'interrupted',
        cause: 'client_crash',
        lastCheckpoint: 'abc123',
      });
      expect(await store.attempts.list()).toHaveLength(1);
    });

    it('list is ordered by creation and filters by state', async () => {
      const { store } = harness();
      await store.attempts.put(sampleAttempt(1));
      await store.attempts.put(sampleAttempt(2, { state: 'completed' }));
      await store.attempts.put(sampleAttempt(3, { state: 'interrupted', cause: 'timeout' }));
      expect((await store.attempts.list()).map((r) => r.attemptId)).toEqual([
        'attempt-1',
        'attempt-2',
        'attempt-3',
      ]);
      const active = await store.attempts.list({ states: ['executing', 'interrupted'] });
      expect(active.map((r) => r.attemptId)).toEqual(['attempt-1', 'attempt-3']);
      expect(await store.attempts.list({ states: [] })).toEqual([]);
    });

    it('rejects an invalid record with INVALID_INPUT and stores nothing', async () => {
      const { store } = harness();
      const bad = { ...sampleAttempt(1), state: 'bogus' } as unknown as AttemptRecordInput;
      expect(await rejectionOf(store.attempts.put(bad))).toMatchObject({ code: 'INVALID_INPUT' });
      const noKey = { ...sampleAttempt(1), attemptId: '' };
      expect(await rejectionOf(store.attempts.put(noKey))).toMatchObject({ code: 'INVALID_INPUT' });
      expect(await store.attempts.list()).toEqual([]);
    });

    it('returns copies: changing a result does not change the registry', async () => {
      const { store } = harness();
      const stored = await store.attempts.put(sampleAttempt(1));
      (stored as { state: string }).state = 'failed';
      expect((await store.attempts.get('attempt-1'))?.state).toBe('executing');
    });

    it('inside a transaction reads its own writes; outside, nothing before the commit', async () => {
      const { store } = harness();
      await store.transaction(async (tx) => {
        await tx.attempts.put(sampleAttempt(1));
        expect(await tx.attempts.get('attempt-1')).toBeDefined();
        expect(await store.attempts.get('attempt-1')).toBeUndefined();
      });
      expect(await store.attempts.get('attempt-1')).toBeDefined();
    });

    it('a rolled-back transaction leaves neither the attempt nor its event', async () => {
      const { store } = harness();
      await store.attempts.put(sampleAttempt(1));
      const failure = new Error('boom');
      const thrown = await rejectionOf(
        store.transaction(async (tx) => {
          await tx.attempts.put(sampleAttempt(1, { state: 'failed' }));
          await tx.attempts.put(sampleAttempt(2));
          await tx.events.append(sampleEvent(1));
          throw failure;
        }),
      );
      expect(thrown).toBe(failure);
      expect((await store.attempts.list()).map((r) => [r.attemptId, r.state])).toEqual([
        ['attempt-1', 'executing'],
      ]);
      expect(await store.events.lastId()).toBe(0);
    });

    it('commits the attempt and the event of one transaction together', async () => {
      const { store } = harness();
      await store.transaction(async (tx) => {
        await tx.attempts.put(sampleAttempt(1, { state: 'interrupted', cause: 'timeout' }));
        await tx.events.append(sampleEvent(1));
      });
      expect(await store.attempts.get('attempt-1')).toMatchObject({ state: 'interrupted' });
      expect(await store.events.lastId()).toBe(1);
    });

    it('rejects the use of a leaked handle with CONFLICT', async () => {
      const { store } = harness();
      const leaked = await store.transaction((tx) => Promise.resolve(tx));
      expect(await rejectionOf(leaked.attempts.put(sampleAttempt(1)))).toMatchObject({
        code: 'CONFLICT',
      });
      expect(await rejectionOf(leaked.attempts.get('attempt-1'))).toMatchObject({
        code: 'CONFLICT',
      });
      expect(await store.attempts.list()).toEqual([]);
    });

    it('after close() the registry rejects with ADAPTER_UNAVAILABLE', async () => {
      const { store } = harness();
      await store.attempts.put(sampleAttempt(1));
      await store.close();
      for (const operation of [
        () => store.attempts.get('attempt-1'),
        () => store.attempts.list(),
        () => store.attempts.put(sampleAttempt(2)),
      ]) {
        expect(await rejectionOf(operation())).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      }
    });
  });
}
