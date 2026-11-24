// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { DiskFull } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { SqliteStore, type StoreCommitHooks } from './store.js';
import { DRIVERS, makeTempDir } from './test-helpers.js';

const big = (n: number) => ({
  type: 'test.happened',
  schemaVersion: 1,
  payload: { n, filler: 'x'.repeat(3000) },
});

/** The disk full of the store (Phase 11, P5): `max_page_count` makes SQLite answer `SQLITE_FULL`. */
describe.each(DRIVERS)('a full database on %s', (driver) => {
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

  async function fill(store: SqliteStore): Promise<{ written: number; error: unknown }> {
    let written = 0;
    for (;;) {
      try {
        await store.events.append(big(written + 1));
        written += 1;
      } catch (error) {
        return { written, error };
      }
    }
  }

  it('rejects with DiskFull, keeps nothing of the failed write and takes writes again when the cap is lifted', async () => {
    await withStore(undefined, async (store) => {
      await store.events.append(big(0));
      // Room for a few more pages only.
      expect(await store.limitGrowth(24)).toBeGreaterThan(24);
      const { written, error } = await fill(store);
      expect(error).toBeInstanceOf(DiskFull);
      expect((error as DiskFull).code).toBe('DISK_FULL');
      const kept = await store.events.readFrom(0, 1000);
      // Whatever was committed is there whole; the write that failed left no event.
      expect(kept).toHaveLength(written + 1);
      expect(kept.map((event) => (event.payload as { n: number }).n)).toEqual(
        Array.from({ length: written + 1 }, (_, index) => index),
      );
      expect(await store.quickCheck()).toEqual([]);

      await store.limitGrowth(undefined);
      await store.events.append(big(9999));
      expect(await store.events.readFrom(0, 1000)).toHaveLength(written + 2);
    });
  });

  it('tells onFailure the typed error, and a hook that throws changes nothing', async () => {
    const told: unknown[] = [];
    await withStore(
      {
        onFailure: (error) => {
          told.push(error);
          throw new Error('a bad hook');
        },
      },
      async (store) => {
        await store.limitGrowth(24);
        const { error } = await fill(store);
        expect(error).toBeInstanceOf(DiskFull);
        expect(told).toHaveLength(1);
        expect(told[0]).toBe(error);
      },
    );
  });

  it('probeWrite rejects with DiskFull while the cap leaves no room, and resolves once it is lifted', async () => {
    await withStore(undefined, async (store) => {
      await store.events.append(big(0));
      await store.probeWrite();
      await store.limitGrowth(24);
      await fill(store);
      await expect(store.probeWrite()).rejects.toBeInstanceOf(DiskFull);
      await store.limitGrowth(undefined);
      await store.probeWrite();
      expect(await store.quickCheck()).toEqual([]);
    });
  });
});
