// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Secret } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { apiKeyRefOf } from './profiles/secret-env.js';
import { makeTempDataDir } from './test-helpers.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const KEY = 'sk-test-0000-not-a-real-key';
/** Every client is "found" (nothing is launched), so the real adapters are built. */
const ALL_FOUND = {
  env: { PATH: '/usr/bin', HOME: '/home/u' },
  findExecutable: (command: string) => `/bin/${command}`,
};

const servers: Server[] = [];
const daemons: DaemonHandle[] = [];

/**
 * Stops the daemons of the test, then removes its directory: on Windows an open `daemon.lock`
 * cannot be deleted while a daemon still holds it.
 */
async function cleanUp(tmp: { dispose: () => Promise<void> }): Promise<void> {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop('shutdown')));
  await tmp.dispose();
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop('shutdown')));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function fakeMiniMax(calls: string[], usageCount: number): Promise<string> {
  const server = createServer((req, res) => {
    calls.push(`${req.method ?? ''} ${req.url ?? ''} ${req.headers.authorization ?? ''}`);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        base_resp: { status_code: 0, status_msg: 'success' },
        data: {
          current_interval_total_count: 100,
          current_interval_usage_count: usageCount,
          current_interval_reset_time: new Date(T0 + 3_600_000).toISOString(),
        },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition did not come true');
}

describe('startDaemon with the P8 quota probes', () => {
  it('reads a registered MiniMax profile at start, with its vault key, and no session open', async () => {
    const tmp = await makeTempDataDir();
    try {
      const calls: string[] = [];
      const base = await fakeMiniMax(calls, 15);
      const clock = new FakeClock(T0);
      const store = new InMemoryStore({ clock });
      const vault = new InMemorySecretVault();
      const ref = apiKeyRefOf('opencode', 'mm');
      await vault.set(ref, new Secret(KEY));
      await store.profiles.create({
        client: 'opencode',
        name: 'mm',
        kind: 'api',
        provider: 'minimax',
        dir: '/p/mm',
        secretRef: ref,
      });
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: ALL_FOUND,
        config: parseConfig(
          'backup:\n  when: manual\nsecurity:\n  unenforced: allow\n' +
            `quota:\n  minimax:\n    mode: token_plan\n    base_url: ${base}\n    allow_hosts: ['127.0.0.1']\n`,
        ),
        overrides: { clock, store, vault },
        logger: createSilentLogger(),
        version: '9.9.9',
      });
      daemons.push(daemon);
      const profile = { client: 'opencode', profile: 'mm' };
      await until(async () => (await daemon.quota.statusOf(profile)).state !== 'unknown');
      const status = await daemon.quota.statusOf(profile);
      // 15 left of 100 (`usage_count_means: remaining`): 85% used, so near the limit.
      expect(status.state).toBe('near_limit');
      expect(status.windows[0]).toMatchObject({ window: '5h', usedPercent: 85 });
      expect(calls[0]).toBe(`GET /v1/token_plan/remains Bearer ${KEY}`);
    } finally {
      await cleanUp(tmp);
    }
  });

  it('makes no call and keeps the probe of the client with the defaults (nothing to route)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const calls: string[] = [];
      await fakeMiniMax(calls, 15);
      const clock = new FakeClock(T0);
      const store = new InMemoryStore({ clock });
      await store.profiles.create({
        client: 'opencode',
        name: 'mm',
        kind: 'api',
        provider: 'minimax',
        dir: '/p/mm',
        secretRef: null,
      });
      const daemon = await startDaemon({
        dataDir: tmp.dir,
        clientSearch: ALL_FOUND,
        config: parseConfig('backup:\n  when: manual\nsecurity:\n  unenforced: allow\n'),
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
        version: '9.9.9',
      });
      daemons.push(daemon);
      expect(await daemon.quota.statusOf({ client: 'opencode', profile: 'mm' })).toMatchObject({
        state: 'unknown',
      });
      expect(calls).toEqual([]);
    } finally {
      await cleanUp(tmp);
    }
  });
});
