// SPDX-License-Identifier: MPL-2.0
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Conflict, type EventEnvelope } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main } from './cli.js';
import { parseConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { makeTempDataDir, NO_CLIENTS, startNotices } from './test-helpers.js';

/**
 * The Phase 1 acceptance criterion that fits step 5 (architecture 5.21): the daemon starts over
 * the real SQLite, refuses a twin, takes a good copy while something writes, gives the old state
 * back through `ot restore`, and starts the same way over fakes.
 *
 * Small and bounded on purpose: /tmp is RAM, so the writer stops at 300 events or 2 s.
 */

const MAX_WRITES = 300;
const WRITER_BUDGET_MS = 2000;
const CONFIG = parseConfig('backup:\n  when: manual\n  content: store_only\n');

async function allEvents(store: {
  events: { readFrom(after: number, limit: number): Promise<readonly EventEnvelope[]> };
}): Promise<readonly EventEnvelope[]> {
  return store.events.readFrom(0, 10_000);
}

describe('acceptance: the daemon over the real SQLite', () => {
  it('starts, refuses a twin, copies under a writer, restores the copy, and starts over fakes', async () => {
    const tmp = await makeTempDataDir();
    try {
      // The vault is a fake on purpose: no test may touch the real keyring.
      const open = (): ReturnType<typeof startDaemon> =>
        startDaemon({
          dataDir: tmp.dir,
          clientSearch: NO_CLIENTS,
          config: CONFIG,
          overrides: { vault: new InMemorySecretVault() },
          logger: createSilentLogger(),
          version: '0.0.0-test',
        });

      // 1. real SQLite: daemon.started is in the log
      const daemon = await open();
      expect(daemon.status().state).toBe('running');
      expect(daemon.adapters.map((adapter) => `${adapter.port}:${adapter.id}`)).toEqual([
        'Clock:system',
        'SecretVault:override',
        'Store:sqlite',
        'CodeHost:auto', // Phase 11, P13
        'TelemetryStore:sqlite',
      ]);
      expect(
        await allEvents(daemon.store).then((events) => events.map((event) => event.type)),
      ).toEqual(['daemon.started', ...(await startNotices()), 'daemon.recovered']);

      // 2. a second daemon on the same data dir is refused by the instance lock
      const twin = await open().catch((error: unknown) => error);
      expect(twin).toBeInstanceOf(Conflict);
      expect(String(twin)).toMatch(new RegExp(`pid ${String(process.pid)}`));

      // 3. a copy taken while a bounded writer is appending passes integrity_check
      let written = 0;
      const deadline = Date.now() + WRITER_BUDGET_MS;
      let stopWriter = false;
      const isStopped = (): boolean => stopWriter;
      const writer = (async (): Promise<void> => {
        while (!isStopped() && written < MAX_WRITES && Date.now() < deadline) {
          await daemon.store.events.append({
            type: 'test.tick',
            schemaVersion: 1,
            payload: { n: written },
          });
          written += 1;
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      // Let the writer get going before the copy starts, so the copy really races with it.
      for (let turn = 0; turn < 10; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      const outcome = await daemon.backup('manual');
      stopWriter = true;
      await writer;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('unreachable');
      expect(written).toBeGreaterThan(0);

      const [folderName] = await readdir(join(tmp.dir, 'backups'));
      const folder = join(tmp.dir, 'backups', folderName ?? '');
      const copy = new DatabaseSync(join(folder, 'store.sqlite'), { readOnly: true });
      let inCopy: number;
      try {
        expect(copy.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
        const row = copy.prepare("SELECT count(*) AS n FROM events WHERE type = 'test.tick'").get();
        inCopy = Number(row?.n);
      } finally {
        copy.close();
      }
      expect(inCopy).toBeGreaterThan(0);
      expect(inCopy).toBeLessThanOrEqual(written);

      // 4. later events are written, the daemon stops, `ot restore` puts the copy back
      for (let n = 0; n < 5; n += 1) {
        await daemon.store.events.append({
          type: 'test.after-copy',
          schemaVersion: 1,
          payload: { n },
        });
      }
      await daemon.stop();

      const captured = { out: [] as string[], err: [] as string[] };
      const code = await main(['restore', folder, '--data-dir', tmp.dir], {
        env: {},
        platform: 'linux',
        homedir: tmp.dir,
        systemLocale: 'en',
        out: (line) => captured.out.push(line),
        err: (line) => captured.err.push(line),
      });
      expect(captured.err).toEqual([]);
      expect(code).toBe(0);
      const kept = (await readdir(tmp.dir)).filter((name) => name.includes('.before-restore-'));
      expect(kept.some((name) => name.startsWith('store.sqlite.before-restore-'))).toBe(true);

      const again = await open();
      const restored = await allEvents(again.store);
      await again.stop();
      const countOf = (type: string): number =>
        restored.filter((event) => event.type === type).length;
      expect(countOf('test.after-copy')).toBe(0);
      expect(countOf('test.tick')).toBe(inCopy);
      // Those of the copy, plus the daemon.started of the daemon that has just started.
      expect(countOf('daemon.started')).toBe(2);

      // 5. the same startDaemon over InMemoryStore and FakeClock
      const fakeDir = await makeTempDataDir();
      try {
        const clock = new FakeClock(Date.UTC(2026, 10, 16, 12, 0, 0));
        const fake = await startDaemon({
          dataDir: fakeDir.dir,
          clientSearch: NO_CLIENTS,
          config: CONFIG,
          overrides: {
            clock,
            store: new InMemoryStore({ clock }),
            vault: new InMemorySecretVault(),
          },
          logger: createSilentLogger(),
        });
        try {
          expect(fake.status()).toMatchObject({ state: 'running', startedAt: clock.now() });
          // The notices of the start-up (no client, no backup in this store, and no sandbox where
          // the platform has none) are recorded in the background, so the order among them and the
          // recovery is not fixed: compare the set.
          const types = (await allEvents(fake.store)).map((event) => event.type);
          expect(types[0]).toBe('daemon.started');
          expect([...types].sort()).toEqual(
            [
              ...(await startNotices()),
              'daemon.notice',
              'daemon.recovered',
              'daemon.started',
            ].sort(),
          );
        } finally {
          await fake.stop();
        }
      } finally {
        await fakeDir.dispose();
      }
    } finally {
      await tmp.dispose();
    }
  });
});
