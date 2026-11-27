// SPDX-License-Identifier: MPL-2.0
// Shared by the tests only (excluded from the build of the package).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import type { Clock } from '@otheater/core';
import { SQLITE_DRIVERS, type SqliteDriverName, type SqliteStoreConfigInput } from './config.js';
import { SqliteStore } from './store.js';

export const DRIVERS: readonly SqliteDriverName[] = SQLITE_DRIVERS;

/** A temporary directory removed by `dispose()`. */
export async function makeTempDir(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-store-'));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** An open store over a fresh temp-dir database; `dispose()` closes it and removes the folder. */
export async function openTempStore(
  driver: SqliteDriverName,
  extra: Partial<SqliteStoreConfigInput> = {},
): Promise<{
  store: SqliteStore;
  clock: Pick<Clock, 'now'> & { advance: (ms: number) => void };
  dir: string;
  dbPath: string;
  dispose: () => Promise<void>;
}> {
  const { dir, dispose: removeDir } = await makeTempDir();
  // A clock that only moves when a test says so (`advance`): this file may not import the fakes
  // of core/testing (only *.test.ts may).
  let instant = Date.UTC(2026, 0, 1);
  const clock = {
    now: () => instant,
    advance: (ms: number): void => {
      instant += ms;
    },
  };
  const dbPath = join(dir, 'otheater.db');
  try {
    const store = await SqliteStore.open({ path: dbPath, driver, ...extra }, clock);
    return {
      store,
      clock,
      dir,
      dbPath,
      dispose: async () => {
        await store.close();
        await removeDir();
      },
    };
  } catch (error) {
    await removeDir();
    throw error;
  }
}

/** Hard limits of every test writer: whichever comes first ends it (and `stop()`). */
export const WRITER_MAX_TRANSACTIONS = 500;
export const WRITER_MAX_MS = 2000;

/**
 * A background writer for the backup tests: transactions of `perTransaction` small events, until
 * `stop()`, {@link WRITER_MAX_TRANSACTIONS} transactions or {@link WRITER_MAX_MS}, whichever comes
 * first. It yields to the event loop after every transaction: a loop made only of microtasks
 * would starve timers, I/O and the backup itself (the cause of the runaway test that filled the
 * RAM disk). Roughly 0.3 MB of data at the limit.
 */
export function startBoundedWriter(
  store: SqliteStore,
  perTransaction = 3,
): { stop: () => Promise<number>; written: () => number } {
  const state = { stopped: false };
  let written = 0;
  const started = performance.now();
  const loop = (async () => {
    for (
      let transactions = 0;
      !state.stopped &&
      transactions < WRITER_MAX_TRANSACTIONS &&
      performance.now() - started < WRITER_MAX_MS;
      transactions++
    ) {
      await store.transaction(async (tx) => {
        for (let k = 0; k < perTransaction; k++) {
          await tx.events.append({
            type: 'test.live',
            schemaVersion: 1,
            payload: { n: written++ },
          });
        }
      });
      await nextMacrotask();
    }
  })();
  return {
    written: () => written,
    stop: async () => {
      state.stopped = true;
      await loop;
      return written;
    },
  };
}
