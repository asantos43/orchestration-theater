// SPDX-License-Identifier: MPL-2.0
import { QuotaExhausted, STORE_PORT_VERSION, type Clock, type Store } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { describeEventLogConformance, sampleEvent } from './event-log.js';
import { deferred, rejectionOf, settle } from './helpers.js';

export interface StoreHarness extends Disposable {
  readonly store: Store;
  /** The clock the adapter stamps events with (or one reading the same time source). */
  readonly clock: Pick<Clock, 'now'>;
}

/**
 * Registers the `Store` conformance tests (port version {@link STORE_PORT_VERSION}): transactions,
 * isolation, close, and the whole `EventLog` suite run against `store.events`.
 */
export function describeStoreConformance(
  name: string,
  factory: AdapterFactory<StoreHarness>,
): void {
  describeEventLogConformance(`${name} (store.events)`, async () => {
    const { store, clock, dispose } = await factory();
    return { events: store.events, clock, ...(dispose === undefined ? {} : { dispose }) };
  });

  describe(`Store conformance: ${name} (port ${STORE_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    it('transaction returns the value of the body and commits its events', async () => {
      const { store } = harness();
      const result = await store.transaction(async (tx) => {
        await tx.events.append(sampleEvent(1));
        await tx.events.append(sampleEvent(2));
        return 'done';
      });
      expect(result).toBe('done');
      expect((await store.events.readFrom(0, 10)).map((e) => e.payload.n)).toEqual([1, 2]);
    });

    it('rolls back everything and rethrows the same error when the body rejects', async () => {
      const { store } = harness();
      await store.events.append(sampleEvent(0));
      const before = await store.events.lastId();
      const failure = new Error('boom');

      const thrown = await rejectionOf(
        store.transaction(async (tx) => {
          await tx.events.append(sampleEvent(1));
          await tx.events.append(sampleEvent(2));
          throw failure;
        }),
      );

      expect(thrown).toBe(failure);
      expect(await store.events.lastId()).toBe(before);
      expect((await store.events.readFrom(0, 10)).map((e) => e.payload.n)).toEqual([0]);
    });

    it('typed errors cross the port untouched', async () => {
      const { store } = harness();
      const quota = new QuotaExhausted('no quota left');
      const thrown = await rejectionOf(
        store.transaction(() => {
          throw quota;
        }),
      );
      expect(thrown).toBe(quota);
    });

    it('a failed append inside a transaction (invalid event) rolls back the earlier ones', async () => {
      const { store } = harness();
      const thrown = await rejectionOf(
        store.transaction(async (tx) => {
          await tx.events.append(sampleEvent(1));
          await tx.events.append({ ...sampleEvent(2), type: 'BAD' });
        }),
      );
      expect(thrown).toMatchObject({ code: 'INVALID_INPUT' });
      expect(await store.events.readFrom(0, 10)).toEqual([]);
    });

    it('reads its own writes inside the transaction', async () => {
      const { store } = harness();
      await store.events.append(sampleEvent(0));
      await store.transaction(async (tx) => {
        const staged = await tx.events.append(sampleEvent(1));
        expect(await tx.events.lastId()).toBe(staged.id);
        const read = await tx.events.readFrom(0, 10);
        expect(read.map((e) => e.payload.n)).toEqual([0, 1]);
        expect((await tx.events.readFrom(staged.id - 1, 10)).map((e) => e.id)).toEqual([staged.id]);
      });
    });

    it('events of a transaction get increasing ids after the committed ones', async () => {
      const { store } = harness();
      const first = await store.events.append(sampleEvent(0));
      const ids = await store.transaction(async (tx) => [
        (await tx.events.append(sampleEvent(1))).id,
        (await tx.events.append(sampleEvent(2))).id,
      ]);
      expect(ids[0]).toBeGreaterThan(first.id);
      expect(ids[1]).toBeGreaterThan(ids[0] ?? Number.POSITIVE_INFINITY);
    });

    it('a committed transaction becomes visible all at once, never in part', async () => {
      const { store } = harness();
      const midway = deferred();
      const release = deferred();
      const transaction = store.transaction(async (tx) => {
        await tx.events.append(sampleEvent(1));
        midway.release();
        await release.promise;
        await tx.events.append(sampleEvent(2));
      });
      await midway.promise;

      // The outside reader may be answered now (nothing visible yet) or only after the commit
      // (adapters that make readers wait); it must never see the first event alone.
      const outsideRead = store.events.readFrom(0, 10);
      await settle();
      release.release();
      await transaction;

      expect([0, 2]).toContain((await outsideRead).length);
      expect(await store.events.readFrom(0, 10)).toHaveLength(2);
    });

    it('a rolled-back transaction is never visible outside', async () => {
      const { store } = harness();
      const midway = deferred();
      const release = deferred();
      const transaction = store.transaction(async (tx) => {
        await tx.events.append(sampleEvent(1));
        midway.release();
        await release.promise;
        throw new Error('rollback');
      });
      const outcome = transaction.then(
        () => 'committed',
        () => 'rolled back',
      );
      await midway.promise;

      const outsideRead = store.events.readFrom(0, 10);
      const outsideLast = store.events.lastId();
      await settle();
      release.release();

      expect(await outcome).toBe('rolled back');
      expect(await outsideRead).toEqual([]);
      expect(await outsideLast).toBe(0);
    });

    it('serializes transactions in call order: bodies never overlap', async () => {
      const { store } = harness();
      const trace: string[] = [];
      const gate = deferred();

      const a = store.transaction(async (tx) => {
        trace.push('a:start');
        await tx.events.append(sampleEvent(1));
        await gate.promise;
        await tx.events.append(sampleEvent(2));
        trace.push('a:end');
      });
      const b = store.transaction(async (tx) => {
        trace.push('b:start');
        await tx.events.append(sampleEvent(3));
        trace.push('b:end');
      });
      await settle();
      expect(trace).toEqual(['a:start']);

      gate.release();
      await Promise.all([a, b]);
      expect(trace).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
      expect((await store.events.readFrom(0, 10)).map((e) => e.payload.n)).toEqual([1, 2, 3]);
    });

    it('a failed transaction does not block the next one', async () => {
      const { store } = harness();
      const failed = store.transaction(() => Promise.reject(new Error('first fails')));
      const next = store.transaction((tx) => tx.events.append(sampleEvent(1)));
      expect(await rejectionOf(failed)).toBeInstanceOf(Error);
      expect((await next).payload).toEqual({ n: 1 });
    });

    it('store.events.append outside a transaction commits on its own', async () => {
      const { store } = harness();
      const stored = await store.events.append(sampleEvent(5));
      expect(await store.events.readFrom(0, 10)).toEqual([stored]);
    });

    it('rejects the use of a transaction handle after the transaction ended with CONFLICT', async () => {
      const { store } = harness();
      const leaked = await store.transaction((tx) => Promise.resolve(tx));
      expect(await rejectionOf(leaked.events.append(sampleEvent(1)))).toMatchObject({
        code: 'CONFLICT',
      });
      expect(await rejectionOf(leaked.events.readFrom(0, 1))).toMatchObject({ code: 'CONFLICT' });
      expect(await store.events.readFrom(0, 10)).toEqual([]);
    });

    it('after close() every operation rejects with ADAPTER_UNAVAILABLE; close is idempotent', async () => {
      const { store } = harness();
      await store.events.append(sampleEvent(1));
      await store.close();
      await store.close();

      const operations = [
        () => store.transaction(() => Promise.resolve(1)),
        () => store.events.append(sampleEvent(2)),
        () => store.events.readFrom(0, 10),
        () => store.events.lastId(),
      ];
      for (const operation of operations) {
        expect(await rejectionOf(operation())).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
      }
    });

    it('close() waits for the transaction in flight, which still commits', async () => {
      const { store } = harness();
      const gate = deferred();
      const transaction = store.transaction(async (tx) => {
        await gate.promise;
        await tx.events.append(sampleEvent(1));
        return 'committed';
      });
      let closed = false;
      const closing = store.close().then(() => {
        closed = true;
      });
      await settle();
      expect(closed).toBe(false);

      gate.release();
      expect(await transaction).toBe('committed');
      await closing;
      expect(closed).toBe(true);
    });
  });
}
