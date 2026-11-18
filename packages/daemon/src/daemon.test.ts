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
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { MAX_PASSWORD_ATTEMPTS, startDaemon, unlockVault, type PasswordPrompt } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { makeTempDataDir, NO_CLIENTS, RecordingSituations } from './test-helpers.js';
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

  get scenarios(): Store['scenarios'] {
    return this.inner.scenarios;
  }

  get scenarioRepos(): Store['scenarioRepos'] {
    return this.inner.scenarioRepos;
  }

  get attachments(): Store['attachments'] {
    return this.inner.attachments;
  }

  get plays(): Store['plays'] {
    return this.inner.plays;
  }

  get stages(): Store['stages'] {
    return this.inner.stages;
  }

  get demands(): Store['demands'] {
    return this.inner.demands;
  }

  get decisions(): Store['decisions'] {
    return this.inner.decisions;
  }

  get blackboard(): Store['blackboard'] {
    return this.inner.blackboard;
  }

  get promptQueue(): Store['promptQueue'] {
    return this.inner.promptQueue;
  }

  get sideEffects(): Store['sideEffects'] {
    return this.inner.sideEffects;
  }

  get sessions(): Store['sessions'] {
    return this.inner.sessions;
  }

  get directives(): Store['directives'] {
    return this.inner.directives;
  }

  get ideas(): Store['ideas'] {
    return this.inner.ideas;
  }

  get profiles(): Store['profiles'] {
    return this.inner.profiles;
  }

  get executors(): Store['executors'] {
    return this.inner.executors;
  }

  get interruptions(): Store['interruptions'] {
    return this.inner.interruptions;
  }

  get quotaSnapshots(): Store['quotaSnapshots'] {
    return this.inner.quotaSnapshots;
  }

  get usage(): Store['usage'] {
    return this.inner.usage;
  }

  get wakeups(): Store['wakeups'] {
    return this.inner.wakeups;
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
        clientSearch: NO_CLIENTS,
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
      expect(types(started)).toEqual(['daemon.started', 'daemon.notice', 'daemon.recovered']);
      expect(started[0]?.payload).toMatchObject({
        pid: process.pid,
        version: '9.9.9',
        adapters: { store: { id: 'override' } },
      });
      // P24 (N146): the execution that stays off is also an event, written after `daemon.started`.
      expect(started[1]?.payload).toEqual({
        kind: 'execution_off',
        subject: expect.stringMatching(/^no_(launcher|client)$/) as string,
        detail: null,
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
        clientSearch: NO_CLIENTS,
        config: MANUAL,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
      });
      await clock.advance(2500);
      await daemon.stop('signal');
      expect(types(log)).toEqual([
        'daemon.started',
        'daemon.notice',
        'daemon.recovered',
        'daemon.stopped',
      ]);
      expect(log[3]?.payload).toEqual({ reason: 'signal', uptimeMs: 2500 });
    } finally {
      await tmp.dispose();
    }
  });

  it('runs at start-up the wakeup that came due while stopped, and keeps the one that did not (P9)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const store = new InMemoryStore({ clock });
      for (const [profile, resetsAt] of [
        ['claude-code/old', AT - 60_000],
        ['claude-code/later', AT + 3_600_000],
      ] as const) {
        await store.quotaSnapshots.put({
          profileId: profile,
          window: 'limit_hit',
          usedPercent: 100,
          resetsAt,
          source: 'test',
          observedAt: AT - 3_600_000,
        });
        await store.wakeups.create({ profileId: profile, cause: 'quota', at: resetsAt });
      }
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: MANUAL,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
      });
      expect(daemon.wakeups.running).toBe(true);
      const rows = await store.wakeups.list({});
      expect(rows.map((row) => [row.profileId, row.state])).toEqual([
        ['claude-code/old', 'fired'],
        ['claude-code/later', 'scheduled'],
      ]);
      await daemon.stop('shutdown');
      expect(daemon.wakeups.running).toBe(false);
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
          clientSearch: NO_CLIENTS,
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
        clientSearch: NO_CLIENTS,
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
        clientSearch: NO_CLIENTS,
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
        clientSearch: NO_CLIENTS,
        overrides: { clock, store: new InMemoryStore({ clock }), vault },
        logger: createSilentLogger(),
        passwordPrompt: prompt,
      });
    }

    it('daemon.notice vault_locked / vault_wrong_password: what the daemon logs about the vault is also an event (P24, N146)', async () => {
      const logger = createSilentLogger();
      const notices = (situations: RecordingSituations) => situations.of('daemon.notice');

      const noPrompt = new RecordingSituations();
      await unlockVault(new FakeLockableVault(), undefined, logger, noPrompt);
      expect(notices(noPrompt)).toEqual([
        { kind: 'vault_locked', subject: 'no_prompt', detail: null },
      ]);

      const noPassword = new RecordingSituations();
      await unlockVault(
        new FakeLockableVault(),
        () => Promise.resolve(undefined),
        logger,
        noPassword,
      );
      expect(notices(noPassword)).toEqual([
        { kind: 'vault_locked', subject: 'no_password', detail: null },
      ]);

      // A wrong password, then the right one: one event, naming the attempt, and no password in it.
      const wrongOnce = new RecordingSituations();
      const answers = ['not the one', RIGHT];
      await unlockVault(
        new FakeLockableVault(),
        () => Promise.resolve(new Secret(answers.shift() ?? '')),
        logger,
        wrongOnce,
      );
      expect(notices(wrongOnce)).toEqual([
        {
          kind: 'vault_wrong_password',
          subject: null,
          detail: `attempt 1 of ${String(MAX_PASSWORD_ATTEMPTS)}`,
        },
      ]);
      expect(JSON.stringify(wrongOnce.recorded)).not.toContain('not the one');

      // An unlocked vault says nothing.
      const vault = new FakeLockableVault();
      await vault.unlock(new Secret(RIGHT));
      const quiet = new RecordingSituations();
      await unlockVault(vault, undefined, logger, quiet);
      expect(quiet.recorded).toEqual([]);
    });

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
          clientSearch: NO_CLIENTS,
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
        clientSearch: NO_CLIENTS,
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
        clientSearch: NO_CLIENTS,
        overrides: { clock, store: new InMemoryStore({ clock }), vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        signal: already.signal,
      });
      await second.stopped;
    } finally {
      await tmp.dispose();
    }
  });

  it('daemon.notice backup_unsupported and deprecated_config: what the start only logged is also an event (P24, N146)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const store = new InMemoryStore({ clock });
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: parseConfig(
          'orchestration:\n  executor: { client: claude-code, profile: a, model: claude-sonnet, effort: medium }\n',
        ),
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
      });
      // The sink writes in the background (ordered): give it a bounded number of turns.
      const noticeEvents = async () =>
        (await store.events.readFrom(0, 20)).filter((event) => event.type === 'daemon.notice');
      for (let turn = 0; turn < 200 && (await noticeEvents()).length < 3; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const notices = (await noticeEvents()).map(
        (event) => event.payload as { kind: string; subject: string | null; detail: string | null },
      );
      expect(notices.map((notice) => notice.kind)).toEqual(
        expect.arrayContaining(['backup_unsupported', 'deprecated_config']),
      );
      expect(notices.find((notice) => notice.kind === 'backup_unsupported')).toEqual({
        kind: 'backup_unsupported',
        subject: null,
        detail: null,
      });
      expect(notices.find((notice) => notice.kind === 'deprecated_config')?.detail).toMatch(
        /orchestration\.executor is deprecated/u,
      );
      await daemon.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('daemon.notice cross_check_unsatisfiable: a strict cross-review the list of a role cannot meet is a log warning and an event (P15b, N150)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(AT);
      const store = new InMemoryStore({ clock });
      const warnings: string[] = [];
      const logger = pino({ level: 'warn' }, { write: (line: string) => warnings.push(line) });
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: parseConfig(`
executors:
  claude-opus-high@claude-code/empresa: { client: claude-code, profile: empresa, model: claude-opus, effort: high }
  claude-opus-high@claude-code/pessoal: { client: claude-code, profile: pessoal, model: claude-opus, effort: high }
  codex-sol-high@codex/conta-1: { client: codex, profile: conta-1, model: codex-sol, effort: high }
selection:
  cross_check: require_other_provider
roles:
  reviewer: { executors: [claude-opus-high@claude-code/empresa, claude-opus-high@claude-code/pessoal] }
  critic: { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1] }
`),
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger,
      });
      const noticeEvents = async () =>
        (await store.events.readFrom(0, 20)).filter((event) => event.type === 'daemon.notice');
      const unsatisfiable = async () =>
        (await noticeEvents())
          .map((event) => event.payload as { kind: string; subject: string | null; detail: string })
          .filter((notice) => notice.kind === 'cross_check_unsatisfiable');
      for (let turn = 0; turn < 200 && (await unsatisfiable()).length < 1; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const found = await unsatisfiable();
      expect(found).toHaveLength(1);
      expect(found[0]?.subject).toBe('reviewer');
      expect(found[0]?.detail).toMatch(/one provider only \(anthropic\)/u);
      expect(
        warnings.some((line) => line.includes('list of reviewer has Executors of one provider')),
      ).toBe(true);
      await daemon.stop();
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
          clientSearch: NO_CLIENTS,
          config: MANUAL,
          overrides: { clock, store, vault: new InMemorySecretVault() },
          logger: createSilentLogger(),
        });
        const outcome = await daemon.backup();
        expect(outcome.ok).toBe(true);
        expect(await readdir(join(tmp.dir, 'backups'))).toHaveLength(1);
        expect(types(await store.events.readFrom(0, 10))).toEqual([
          'daemon.started',
          'daemon.notice',
          'daemon.recovered',
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
          clientSearch: NO_CLIENTS,
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
          clientSearch: NO_CLIENTS,
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
