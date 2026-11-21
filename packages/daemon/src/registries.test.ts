// SPDX-License-Identifier: MPL-2.0
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput, type RegistryEntries, type Store } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { buildDaemonRegistries, defaultRegistryEntries } from './registries.js';
import { makeTempDataDir, NO_CLIENTS } from './test-helpers.js';

const MANUAL = parseConfig('backup:\n  when: manual\n');

describe('the daemon registries', () => {
  it('are valid with the official entries and hold the 125 daemon and 2 play event types', () => {
    const registries = buildDaemonRegistries();
    expect(registries.events.size).toBe(129);
    expect(registries.events.has('daemon.started')).toBe(true);
    expect(registries.roles.size).toBe(7);
    expect(registries.ruleKeys.size).toBe(6);
    expect(registries.scenarioTypes.keys()).toEqual(['project', 'task', 'chat']);
  });
});

describe('starting the daemon with an invalid registry', () => {
  function broken(): RegistryEntries {
    const entries = defaultRegistryEntries();
    return {
      ...entries,
      tools: entries.tools.map((tool) =>
        tool.name === 'open_pr' ? { ...tool, idempotencyKey: undefined } : tool,
      ),
      scenarioTypes: [{ id: 'project', defaultFlow: 'ghost', flows: ['ghost'] }],
    };
  }

  it('refuses to start, names every entry that failed and never opens the store', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(Date.UTC(2026, 10, 17, 12));
      const inner = new InMemoryStore({ clock });
      let touched = 0;
      const store = new Proxy(inner, {
        get(target, property) {
          touched += 1;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as Store;
      const failure: unknown = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: MANUAL,
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        registries: broken(),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(InvalidInput);
      const message = (failure as Error).message;
      expect(message).toContain('tools/open_pr');
      expect(message).toContain('scenarioTypes/project');
      expect(touched).toBe(0);
      await expect(inner.events.lastId()).resolves.toBe(0);

      // The lock was released: the same data directory starts with valid registries.
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: NO_CLIENTS,
        config: MANUAL,
        overrides: { clock, store: inner, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
      });
      expect(daemon.registries.events.size).toBe(129);
      await daemon.stop();
    } finally {
      await tmp.dispose();
    }
  });

  it('does not create the database file of the real store', async () => {
    const tmp = await makeTempDataDir();
    try {
      await expect(
        startDaemon({
          dataDir: tmp.dir,
          clientSearch: NO_CLIENTS,
          config: MANUAL,
          overrides: { vault: new InMemorySecretVault() },
          logger: createSilentLogger(),
          registries: broken(),
        }),
      ).rejects.toThrow(InvalidInput);
      await expect(access(join(tmp.dir, 'store.sqlite'))).rejects.toThrow();
      // And the lock file holds no live owner after the failure.
      const lockInfo = await readFile(join(tmp.dir, 'daemon.lock.json'), 'utf8').catch(() => '');
      expect(lockInfo).not.toContain(String(process.pid));
    } finally {
      await tmp.dispose();
    }
  });
});
