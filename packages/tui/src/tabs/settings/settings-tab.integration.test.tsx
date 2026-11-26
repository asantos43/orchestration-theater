// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from '../../ink.test-support.js';
import { startTuiTestDaemon, type TuiTestDaemon } from '../../test-daemon.test-support.js';
import { apiOf } from './api.js';
import { errorText } from './settings-tab.js';

/**
 * The tab Settings against a real daemon of this process (P16 of Phase 7): the keys travel the
 * real `PUT /v1/config`, the file is the one the daemon writes, and the event is the one it emits.
 * Nothing real runs (N57): in-memory store, clock and vault, no client found, loopback only.
 */

const daemons: TuiTestDaemon[] = [];

async function startDaemon(): Promise<TuiTestDaemon> {
  const clock = new FakeClock();
  const daemon = await startTuiTestDaemon({
    clock,
    store: new InMemoryStore({ clock }),
    vault: new InMemorySecretVault(),
  });
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  cleanupApps();
  for (const daemon of daemons.splice(0)) await daemon.dispose();
});

async function configFile(daemon: TuiTestDaemon): Promise<string> {
  return readFile(join(daemon.dataDir, 'config.yaml'), 'utf8').catch(() => '');
}

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timeout waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function key(app: RenderedApp, sequence: string): Promise<string> {
  app.press(sequence);
  return app.settle();
}

async function openLimits(daemon: TuiTestDaemon): Promise<RenderedApp> {
  const app = await renderApp({
    connector: daemon.connector,
    size: { columns: 140, rows: 60 },
  });
  await app.waitForText('SCENARIOS');
  app.press('\x1b[15~');
  await app.waitForText('Limits');
  // The sections: accounts, Executors, roles, limits; then the fourth key of the limits.
  for (let index = 0; index < 3; index += 1) await key(app, '\x1b[B');
  // Limits starts folded (`ui.settingsTab.limits`): Enter opens it.
  await key(app, '\r');
  for (let index = 0; index < 3; index += 1) await key(app, 'j');
  return app;
}

describe('the tab Settings, with a daemon', () => {
  it('writes a hot key through PUT /v1/config, shows it, and the daemon says config.changed', async () => {
    const daemon = await startDaemon();
    // A second client watches the stream, the way a plugin or another interface would.
    const watcher = await daemon.connector.connect();
    if (watcher.kind !== 'online') throw new Error('the daemon is not online');
    try {
      await watcher.daemon.stores.start();
      const app = await openLimits(daemon);
      await key(app, 'e');
      await key(app, '7');
      await key(app, '\r');
      await app.waitForText(/attempts_per_demand +=\s7/);
      expect(await configFile(daemon)).toMatch(/attempts_per_demand:\s*7/);
      await waitUntil(() =>
        watcher.daemon.stores.events
          .getState()
          .events.some((event) => event.type === 'config.changed'),
      );
    } finally {
      watcher.daemon.close();
    }
  }, 20_000);

  it('refuses an invalid value, names the key and leaves the file as it was', async () => {
    const daemon = await startDaemon();
    const before = await configFile(daemon);
    const app = await openLimits(daemon);
    await key(app, 'e');
    await key(app, '0');
    await key(app, '\r');
    const frame = await app.waitForText('attempts_per_demand takes a whole number');
    expect(frame).not.toMatch(/attempts_per_demand +=\s0/);
    expect(await configFile(daemon)).toBe(before);
  });

  it('the daemon refuses what the screen let through, names the key and writes nothing', async () => {
    const daemon = await startDaemon();
    const before = await configFile(daemon);
    const online = await daemon.connector.connect();
    if (online.kind !== 'online') throw new Error('the daemon is not online');
    try {
      const api = apiOf(online.daemon.stores.client);
      const failure = await api
        .putConfig({ set: [{ path: ['limits', 'attempts_per_demand'], value: 0 }], remove: [] })
        .catch((error: unknown) => error);
      expect(errorText(failure)).toContain('limits.attempts_per_demand');
      expect(await configFile(daemon)).toBe(before);
    } finally {
      online.daemon.close();
    }
  });

  it('writes the new order of a role as the daemon keeps it, and back', async () => {
    const daemon = await startDaemon();
    const online = await daemon.connector.connect();
    if (online.kind !== 'online') throw new Error('the daemon is not online');
    try {
      const api = apiOf(online.daemon.stores.client);
      const first = 'opus-high@claude-code/main';
      const second = 'sonnet-high@claude-code/main';
      const result = await api.putConfig({
        set: [{ path: ['roles', 'author', 'executors'], value: [first, second] }],
        remove: [],
      });
      expect(result.appliesOn).toBe('hot');
      expect(await configFile(daemon)).toMatch(new RegExp(`${first}[\\s\\S]*${second}`));
      await api.putConfig({
        set: [{ path: ['roles', 'author', 'executors'], value: [second, first] }],
        remove: [],
      });
      expect(await configFile(daemon)).toMatch(new RegExp(`${second}[\\s\\S]*${first}`));
      const config = await api.config();
      expect((config.config.roles as { author: { executors: string[] } }).author.executors).toEqual(
        [second, first],
      );
    } finally {
      online.daemon.close();
    }
  });
});
