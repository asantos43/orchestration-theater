// SPDX-License-Identifier: MPL-2.0
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput, type RegistryEntries, type Store } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { createSilentLogger } from './logger.js';
import type { ActivePlugin } from './plugins/registry.js';
import { buildDaemonRegistries, defaultRegistryEntries, RegistryHolder } from './registries.js';
import { makeTempDataDir, NO_CLIENTS } from './test-helpers.js';

const MANUAL = parseConfig('backup:\n  when: manual\n');

describe('the daemon registries', () => {
  it('are valid with the official entries and hold the 168 daemon and 2 play event types', () => {
    const registries = buildDaemonRegistries();
    expect(registries.events.size).toBe(170);
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
      expect(daemon.registries.events.size).toBe(170);
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

describe('RegistryHolder (hot swap of the snapshot, N235 (a))', () => {
  const plugin = (id: string, version = '1.0.0'): ActivePlugin => ({
    id,
    version,
    manifest: {} as ActivePlugin['manifest'],
    dir: `/plugins/${id}`,
    manifestHash: 'h'.repeat(64),
  });
  const withPlugins = (...ids: string[]): ReadonlyMap<string, readonly ActivePlugin[]> =>
    new Map([['p1', ids.map((id) => plugin(id))]]);

  it('starts at generation 0 with the registries it was given', () => {
    const registries = buildDaemonRegistries();
    const holder = new RegistryHolder(registries);
    expect(holder.current()).toMatchObject({ generation: 0, registries });
    expect(holder.current().plugins.size).toBe(0);
  });

  it('a swap makes a new frozen snapshot; the one a session holds does not change', () => {
    const holder = new RegistryHolder(buildDaemonRegistries());
    const open = holder.current();
    holder.swap(withPlugins('demo-db'));
    const next = holder.current();

    expect(next).not.toBe(open);
    expect(next.generation).toBe(1);
    expect(next.plugins.get('p1')?.map((entry) => entry.id)).toEqual(['demo-db']);
    // A session that started before keeps seeing what it saw.
    expect(open.generation).toBe(0);
    expect(open.plugins.size).toBe(0);
    expect(Object.isFrozen(next)).toBe(true);
    // No contributor: the registries are the same frozen object, with the same counts.
    expect(next.registries).toBe(open.registries);
    expect(next.registries.events.size).toBe(170);
    expect(next.registries.roles.size).toBe(7);
    expect(next.registries.ruleKeys.size).toBe(6);
  });

  it('tells the listeners, and stops telling after the function it returned is called', () => {
    const holder = new RegistryHolder(buildDaemonRegistries());
    const seen: number[] = [];
    const off = holder.onSwap((snapshot) => seen.push(snapshot.generation));
    holder.swap(withPlugins('a'));
    off();
    holder.swap(withPlugins('a', 'b'));
    expect(seen).toEqual([1]);
    expect(holder.current().generation).toBe(2);
  });

  it('a listener that throws does not stop the swap or the other listeners', () => {
    const holder = new RegistryHolder(buildDaemonRegistries());
    const seen: number[] = [];
    holder.onSwap(() => {
      throw new Error('boom');
    });
    holder.onSwap((snapshot) => seen.push(snapshot.generation));
    holder.swap(withPlugins('a'));
    expect(seen).toEqual([1]);
  });

  it('a contributor adds entries at the swap; a contributor that breaks the registries keeps the snapshot', () => {
    const holder = new RegistryHolder(buildDaemonRegistries());
    const [role] = defaultRegistryEntries().roles;
    if (role === undefined) throw new Error('no official role');
    holder.contribute((plugins) => ({
      roles: [...plugins.values()].flat().map((entry) => ({
        ...role,
        id: `role_${entry.id}`,
      })),
    }));
    holder.swap(withPlugins('demo'));
    expect(holder.current().registries.roles.size).toBe(8);
    expect(holder.current().generation).toBe(1);

    // The same id twice is invalid: the swap is refused and the snapshot stays.
    holder.swap(
      new Map([
        ['p1', [plugin('dup')]],
        ['p2', [plugin('dup')]],
      ]),
    );
    expect(holder.current().generation).toBe(1);
    expect(holder.current().registries.roles.size).toBe(8);
  });

  it('follows the plugin registry: the first snapshot and every change', () => {
    const listeners = new Set<() => void>();
    let active = withPlugins('a');
    const source = {
      activeSnapshot: () => active,
      onChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const holder = new RegistryHolder(buildDaemonRegistries());
    holder.follow(source as never);
    expect(holder.current().generation).toBe(1);
    active = withPlugins('a', 'b');
    for (const listener of listeners) listener();
    expect(holder.current().plugins.get('p1')).toHaveLength(2);
    holder.stop();
    expect(listeners.size).toBe(0);
  });
});
