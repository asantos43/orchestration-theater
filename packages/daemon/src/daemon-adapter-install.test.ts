// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import {
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
} from '@otheater/core/testing';
import type { SetupAdapterInstallResult } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  fixtureAdapter,
  startFakeRegistry,
  type FakeRegistry,
} from './adapters/adapter-fixture.js';
import type { FindExecutable } from './clients.js';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { dataPaths } from './paths.js';
import { captureLogger, makeTempDataDir } from './test-helpers.js';

/**
 * P18b (N321): the setup assistant installs the ACP adapter of a client whose official program is
 * there (key I), then looks for the clients again, so the client enters the pool without a
 * restart. Only fakes: the registry is a local server with a fixture adapter, the search of `PATH`
 * answers from a set, and no client is started.
 */

const LINUX = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;

interface Rig {
  readonly daemon: DaemonHandle;
  readonly registry: FakeRegistry;
  send(method: string, path: string): Promise<{ status: number; text: string }>;
  notices(kind: string): Promise<(string | null)[]>;
  dispose(): Promise<void>;
}

async function start(): Promise<Rig> {
  const tmp = await makeTempDataDir();
  const fixture = fixtureAdapter();
  const registry = await startFakeRegistry(fixture);
  const { logger } = captureLogger();
  // The official Claude Code is there; its adapter is not, and `install: off` keeps it so.
  const have = new Set(['claude']);
  const find: FindExecutable = (command) => (have.has(command) ? `/bin/${command}` : undefined);
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config: parseConfig(
      `backup:\n  when: manual\nclients:\n  adapters:\n    install: off\n    registry: ${registry.url}\n`,
    ),
    overrides: {
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      launcher: new FakeProcessLauncher(),
      transport: new FakeSessionTransport(),
    },
    clientSearch: {
      env: { PATH: '/usr/bin' },
      findExecutable: find,
      adapters: {
        lockOf: (id) => ({ ...fixture.lock, id }),
        platform: LINUX,
        self: { sea: false, execPath: process.execPath },
        installOptions: { retryDelayMs: 0, retries: 0 },
      },
    },
    logger,
    version: '0.0.0-test',
  });
  const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
  let key = 0;
  return {
    daemon,
    registry,
    send: async (method, path) => {
      key += 1;
      const response = await fetch(`${daemon.api.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': `install-${String(key)}` },
      });
      return { status: response.status, text: await response.text() };
    },
    notices: async (kind) => {
      const events = await daemon.store.events.readFrom(0, 10_000);
      return events
        .filter((event) => event.type === 'daemon.notice')
        .map((event) => event.payload as { kind: string; subject: string | null })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.subject);
    },
    dispose: async () => {
      await daemon.stop();
      await registry.close();
      await tmp.dispose();
    },
  };
}

describe('POST /v1/setup/adapters/:client/install (P18b, N321)', () => {
  it('installs the adapter even with install: off, and the client enters the pool', async () => {
    const t = await start();
    try {
      expect(t.daemon.execution?.pool.clients()).toEqual([]);
      expect(t.daemon.clients?.reasonOf('claude-code')).toBe('adapter_missing');

      const answer = await t.send('POST', '/v1/setup/adapters/claude-code/install');
      expect(answer.status, answer.text).toBe(200);
      const result = JSON.parse(answer.text) as SetupAdapterInstallResult;
      expect(result).toMatchObject({
        client: 'claude-code',
        adapter: 'claude-agent-acp',
        version: '1.2.3',
        installed: true,
        failure: null,
        added: ['claude-code'],
      });
      expect(result.clients).toContainEqual({
        client: 'claude-code',
        installed: true,
        reason: 'managed_installed',
      });
      expect(t.daemon.execution?.pool.clients()).toEqual(['claude-code']);
      expect(await t.notices('adapter_installed')).toEqual(['claude-agent-acp']);
    } finally {
      await t.dispose();
    }
  });

  it('a failed download is an answer with why, not an error, and adds no client', async () => {
    const t = await start();
    try {
      t.registry.failNext(500, 10);
      const answer = await t.send('POST', '/v1/setup/adapters/claude-code/install');
      expect(answer.status, answer.text).toBe(200);
      const result = JSON.parse(answer.text) as SetupAdapterInstallResult;
      expect(result.installed).toBe(false);
      expect(result.failure).toMatch(/\S/);
      expect(result.added).toEqual([]);
      expect(t.daemon.execution?.pool.clients()).toEqual([]);
      expect(await t.notices('adapter_install_failed')).toEqual(['claude-agent-acp']);
    } finally {
      await t.dispose();
    }
  });

  it('refuses a client that has no managed adapter', async () => {
    const t = await start();
    try {
      const answer = await t.send('POST', '/v1/setup/adapters/opencode/install');
      expect(answer.status, answer.text).toBe(400);
      expect(JSON.parse(answer.text)).toMatchObject({ error: { code: 'invalid_input' } });
    } finally {
      await t.dispose();
    }
  });
});
