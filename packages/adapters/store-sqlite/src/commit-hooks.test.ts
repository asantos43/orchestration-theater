// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { SqliteStore, type StoreCommitHooks } from './store.js';
import { DRIVERS, makeTempDir } from './test-helpers.js';

const event = (n: number) => ({ type: 'test.happened', schemaVersion: 1, payload: { n } });

/** The hooks of the chaos tests (Phase 11, P1): around the commit of every transaction. */
describe.each(DRIVERS)('StoreCommitHooks on %s', (driver) => {
  async function withStore(
    hooks: StoreCommitHooks | undefined,
    body: (store: SqliteStore) => Promise<void>,
  ): Promise<void> {
    const { dir, dispose } = await makeTempDir();
    const store = await SqliteStore.open(
      { path: join(dir, 'otheater.db'), driver },
      new FakeClock(),
      hooks,
    );
    try {
      await body(store);
    } finally {
      await store.close();
      await dispose();
    }
  }

  it('runs beforeCommit and afterCommit once for each transaction, in that order', async () => {
    const calls: string[] = [];
    await withStore(
      {
        beforeCommit: () => {
          calls.push('before');
          return Promise.resolve();
        },
        afterCommit: () => {
          calls.push('after');
          return Promise.resolve();
        },
      },
      async (store) => {
        await store.events.append(event(1));
        expect(calls).toEqual(['before', 'after']);
        await store.events.append(event(2));
        expect(calls).toEqual(['before', 'after', 'before', 'after']);
      },
    );
  });

  it('a beforeCommit that rejects rolls the transaction back and rejects the call', async () => {
    await withStore(
      { beforeCommit: () => Promise.reject(new Error('injected')) },
      async (store) => {
        await expect(store.events.append(event(1))).rejects.toThrow('injected');
        expect(await store.events.readFrom(0, 10)).toEqual([]);
      },
    );
  });

  it('the commit is done when afterCommit runs', async () => {
    let seenByReader: number | undefined;
    const holder: { store?: SqliteStore } = {};
    await withStore(
      {
        afterCommit: async () => {
          seenByReader = (await holder.store?.events.readFrom(0, 10))?.length;
        },
      },
      async (store) => {
        holder.store = store;
        await store.events.append(event(1));
        expect(seenByReader).toBe(1);
      },
    );
  });

  it('with no hooks nothing changes', async () => {
    await withStore(undefined, async (store) => {
      await store.events.append(event(1));
      expect(await store.events.readFrom(0, 10)).toHaveLength(1);
    });
  });
});
