// SPDX-License-Identifier: MPL-2.0
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  Conflict,
  hasErrorCode,
  PermissionDenied,
  Secret,
  type EventEnvelope,
  type SecretVault,
  type Store,
  type StoreBackupResult,
  type StoreMaintenance,
  type StoreTransaction,
} from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { MAX_PASSWORD_ATTEMPTS, startDaemon, type PasswordPrompt } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { makeTempDataDir } from './test-helpers.js';
import { writeFile } from 'node:fs/promises';

const AT = Date.UTC(2026, 10, 16, 15, 30, 5);
const RIGHT = 'correct horse';
/** No scheduler: the tests that count events must not race with the catch-up backup. */
const MANUAL = parseConfig('backup:\n  when: manual\n');

/** A vault with a master password, like the encrypted-file one, without scrypt. */
class FakeLockableVault implements SecretVault {
  readonly #inner = new InMemorySecretVault();
  #locked = true;
  unlocks = 0;
  locks = 0;

  get isLocked(): boolean {
    return this.#locked;
  }

  unlock(password: Secret): Promise<void> {
    this.unlocks += 1;
    if (password.reveal() !== RIGHT) return Promise.reject(new PermissionDenied('Wrong password'));
    this.#locked = false;
    return Promise.resolve();
  }

  lock(): void {
    this.locks += 1;
    this.#locked = true;
  }

  get = this.#inner.get.bind(this.#inner);
  set = this.#inner.set.bind(this.#inner);
  delete = this.#inner.delete.bind(this.#inner);
  list = this.#inner.list.bind(this.#inner);
}

/** `InMemoryStore` with the optional maintenance capability. */
class MaintainedStore implements Store, StoreMaintenance {
  readonly inner: InMemoryStore;
  closes = 0;
  problems: string[] = [];

  constructor(readonly clock: FakeClock) {
    this.inner = new InMemoryStore({ clock });
  }

  get events(): Store['events'] {
    return this.inner.events;
  }

  get attempts(): Store['attempts'] {
    return this.inner.attempts;
  }

  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }

  async close(): Promise<void> {
    this.closes += 1;
    await this.inner.close();
  }

  quickCheck(): Promise<string[]> {
    return Promise.resolve(this.problems);
  }

  async backup(dest: string): Promise<StoreBackupResult> {
    await writeFile(dest, 'copy');
    return { path: dest, bytes: 4, method: 'online_api', durationMs: 1, restarts: 0 };
  }
}

const types = (events: readonly EventEnvelope[]): string[] => events.map((event) => event.type);

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** The prompt answers in order and records how often it was asked. */
function scriptedPrompt(answers: readonly (string | undefined)[]): {
  prompt: PasswordPrompt;
  asked: () => number;
} {
  let asked = 0;
  return {
    asked: () => asked,
    prompt: () => {
      const answer = answers[asked];
      asked += 1;
      return Promise.resolve(answer === undefined ? undefined : new Secret(answer));
    },
  };
}

describe('startDaemon', () => {
  it('starts over fakes, records daemon.started, reports running and stops once', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const store = new MaintainedStore(clock);
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        config: MANUAL,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        version: '9.9.9',
      });
      expect(daemon.status()).toMatchObject({
        pid: process.pid,
        startedAt: AT,
        version: '9.9.9',
        state: 'running',
        dataDir: tmp.dir,
      });
      expect(daemon.adapters.map((adapter) => adapter.id)).toEqual([
        'override',
        'override',
        'override',
      ]);
      const started = await store.events.readFrom(0, 10);
      expect(types(started)).toEqual(['daemon.started']);
      expect(started[0]?.payload).toMatchObject({
        pid: process.pid,
        version: '9.9.9',
        adapters: { store: { id: 'override' } },
      });

      await clock.advance(1500);
      const first = daemon.stop('shutdown');
      expect(daemon.stop('signal')).toBe(first); // idempotent: the same promise, reason of the first call
      await first;
      await daemon.stopped;
      expect(store.closes).toBe(1);
      // The store is closed now, so read the log through the inner store's committed events.
      await expect(store.events.readFrom(0, 10)).rejects.toThrow(AdapterUnavailable);
      expect(await exists(join(tmp.dir, 'daemon.lock'))).toBe(true); // the file stays; the lock does not
    } finally {
      await tmp.dispose();
    }
  });

  it('writes daemon.stopped with the reason and the uptime before closing', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const store = new MaintainedStore(clock);
      const log: EventEnvelope[] = [];
      const realClose = store.close.bind(store);
      store.close = async () => {
        log.push(...(await store.events.readFrom(0, 10)));
        await realClose();
      };
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        config: MANUAL,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
      });
      await clock.advance(2500);
      await daemon.stop('signal');
      expect(types(log)).toEqual(['daemon.started', 'daemon.stopped']);
      expect(log[1]?.payload).toEqual({ reason: 'signal', uptimeMs: 2500 });
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses a second daemon on the same data dir and lets go of the lock on stop', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const open = (): ReturnType<typeof startDaemon> =>
        startDaemon({
          dataDir: tmp.dir,
          overrides: {
            clock,
            store: new InMemoryStore({ clock }),
            vault: new InMemorySecretVault(),
          },
          logger: createSilentLogger(),
        });
      const first = await open();
      await expect(open()).rejects.toThrow(Conflict);
      await first.stop();
      const again = await open();
      expect(again.status().state).toBe('running');
      await again.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses to start on a damaged store, says how to restore, and releases everything', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const store = new MaintainedStore(clock);
      store.problems = ['row 7 missing from index'];
      const options = {
        dataDir: tmp.dir,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
      };
      const failure = await startDaemon(options).catch((error: unknown) => error);
      expect(hasErrorCode(failure, 'ADAPTER_UNAVAILABLE')).toBe(true);
      expect(String(failure)).toMatch(/row 7 missing.*ot restore/s);
      expect(store.closes).toBe(1);
      // Nothing was appended to the log, and the lock is free again.
      const clock2 = new FakeClock(AT);
      const healthy = await startDaemon({
        dataDir: tmp.dir,
        overrides: {
          clock: clock2,
          store: new InMemoryStore({ clock: clock2 }),
          vault: new InMemorySecretVault(),
        },
        logger: createSilentLogger(),
      });
      await healthy.stop();
    } finally {
      await tmp.dispose();
    }
  });

  describe('vault master password', () => {
    async function start(
      vault: FakeLockableVault,
      prompt: PasswordPrompt | undefined,
      dataDir: string,
    ): Promise<Awaited<ReturnType<typeof startDaemon>>> {
      const clock = new FakeClock(AT);
      return startDaemon({
        dataDir,
        overrides: { clock, store: new InMemoryStore({ clock }), vault },
        logger: createSilentLogger(),
        passwordPrompt: prompt,
      });
    }

    it('unlocks with the right password and locks again on stop', async () => {
      const tmp = await makeTempDataDir();
      try {
        const vault = new FakeLockableVault();
        const { prompt, asked } = scriptedPrompt([RIGHT]);
        const daemon = await start(vault, prompt, tmp.dir);
        expect(asked()).toBe(1);
        expect(daemon.vaultLocked).toBe(false);
        await daemon.stop();
        expect(vault.isLocked).toBe(true);
      } finally {
        await tmp.dispose();
      }
    });

    it('asks again after a wrong password', async () => {
      const tmp = await makeTempDataDir();
      try {
        const vault = new FakeLockableVault();
        const { prompt, asked } = scriptedPrompt(['nope', RIGHT]);
        const daemon = await start(vault, prompt, tmp.dir);
        expect(asked()).toBe(2);
        expect(daemon.vaultLocked).toBe(false);
        await daemon.stop();
      } finally {
        await tmp.dispose();
      }
    });

    it('does not start after the last wrong password, and frees the lock', async () => {
      const tmp = await makeTempDataDir();
      try {
        const vault = new FakeLockableVault();
        const { prompt, asked } = scriptedPrompt(['a', 'b', 'c', RIGHT]);
        await expect(start(vault, prompt, tmp.dir)).rejects.toThrow(PermissionDenied);
        expect(asked()).toBe(MAX_PASSWORD_ATTEMPTS);
        expect(vault.unlocks).toBe(MAX_PASSWORD_ATTEMPTS);
        // The lock was released: another start works.
        const { prompt: second } = scriptedPrompt([RIGHT]);
        const daemon = await start(new FakeLockableVault(), second, tmp.dir);
        await daemon.stop();
      } finally {
        await tmp.dispose();
      }
    });

    it('stays locked, with a started daemon, when there is no prompt or no answer', async () => {
      const tmp = await makeTempDataDir();
      try {
        const noPrompt = await start(new FakeLockableVault(), undefined, tmp.dir);
        expect(noPrompt.vaultLocked).toBe(true);
        expect(noPrompt.status().state).toBe('running');
        await noPrompt.stop();

        const { prompt, asked } = scriptedPrompt([undefined]);
        const gaveUp = await start(new FakeLockableVault(), prompt, tmp.dir);
        expect(asked()).toBe(1);
        expect(gaveUp.vaultLocked).toBe(true);
        await gaveUp.stop();
      } finally {
        await tmp.dispose();
      }
    });

    it('does not ask when the vault has no master password', async () => {
      const tmp = await makeTempDataDir();
      try {
        const clock = new FakeClock(AT);
        const { prompt, asked } = scriptedPrompt([RIGHT]);
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          overrides: {
            clock,
            store: new InMemoryStore({ clock }),
            vault: new InMemorySecretVault(),
          },
          logger: createSilentLogger(),
          passwordPrompt: prompt,
        });
        expect(asked()).toBe(0);
        expect(daemon.vaultLocked).toBe(false);
        await daemon.stop();
      } finally {
        await tmp.dispose();
      }
    });
  });

  it('stops with the reason "signal" when the signal aborts, and when it was already aborted', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const store = new MaintainedStore(clock);
      const controller = new AbortController();
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        config: MANUAL,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        signal: controller.signal,
      });
      controller.abort();
      await daemon.stopped;
      expect(store.closes).toBe(1);

      const already = new AbortController();
      already.abort();
      const second = await startDaemon({
        dataDir: tmp.dir,
        overrides: { clock, store: new InMemoryStore({ clock }), vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        signal: already.signal,
      });
      await second.stopped;
    } finally {
      await tmp.dispose();
    }
  });

  describe('backups', () => {
    it('backs up on demand, records the event and keeps the data dir tidy', async () => {
      const tmp = await makeTempDataDir();
      try {
        const clock = new FakeClock(AT);
        const store = new MaintainedStore(clock);
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          config: MANUAL,
          overrides: { clock, store, vault: new InMemorySecretVault() },
          logger: createSilentLogger(),
        });
        const outcome = await daemon.backup();
        expect(outcome.ok).toBe(true);
        expect(await readdir(join(tmp.dir, 'backups'))).toHaveLength(1);
        expect(types(await store.events.readFrom(0, 10))).toEqual([
          'daemon.started',
          'daemon.backup',
        ]);
        await daemon.stop();
      } finally {
        await tmp.dispose();
      }
    });

    it('rejects a backup when the store cannot make copies', async () => {
      const tmp = await makeTempDataDir();
      try {
        const clock = new FakeClock(AT);
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          overrides: {
            clock,
            store: new InMemoryStore({ clock }),
            vault: new InMemorySecretVault(),
          },
          logger: createSilentLogger(),
        });
        await expect(daemon.backup()).rejects.toThrow(AdapterUnavailable);
        await daemon.stop();
      } finally {
        await tmp.dispose();
      }
    });

    it('makes the catch-up backup at start when the schedule is daily and there is none', async () => {
      const tmp = await makeTempDataDir();
      try {
        const clock = new FakeClock(AT);
        const store = new MaintainedStore(clock);
        const daemon = await startDaemon({
          dataDir: tmp.dir,
          overrides: { clock, store, vault: new InMemorySecretVault() },
          logger: createSilentLogger(),
        });
        // The scheduler runs the catch-up asynchronously: give it a bounded number of turns.
        const done = async (): Promise<boolean> =>
          types(await store.events.readFrom(0, 10)).includes('daemon.backup');
        for (let turn = 0; turn < 200 && !(await done()); turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        await daemon.stop();
        expect(await readdir(join(tmp.dir, 'backups'))).toHaveLength(1);
      } finally {
        await tmp.dispose();
      }
    });
  });
});
