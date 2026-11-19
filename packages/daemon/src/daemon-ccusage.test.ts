// SPDX-License-Identifier: MPL-2.0
import type {
  UsageSource,
  UsageSourceEntry,
  UsageSourceQuery,
  UsageSourceStatus,
} from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { makeTempDataDir } from './test-helpers.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const NO_CLIENTS = { env: { PATH: '' }, findExecutable: () => undefined } as const;

const daemons: DaemonHandle[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop('shutdown')));
});

/**
 * Stops the daemons of the test, then removes its directory: on Windows an open `daemon.lock`
 * (or the journal of the store) cannot be deleted while a daemon still holds it.
 */
async function cleanUp(tmp: { dispose: () => Promise<void> }): Promise<void> {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop('shutdown')));
  await tmp.dispose();
}

class FakeSource implements UsageSource {
  readonly id = 'fake-ccusage';
  readonly implements = { port: 'UsageSource', range: '^0.1.0' } as const;
  readonly queries: UsageSourceQuery[] = [];
  constructor(
    readonly status: UsageSourceStatus,
    readonly entries: readonly UsageSourceEntry[] = [],
  ) {}
  check(): Promise<UsageSourceStatus> {
    return Promise.resolve(this.status);
  }
  read(query: UsageSourceQuery): Promise<readonly UsageSourceEntry[]> {
    this.queries.push(query);
    return Promise.resolve(this.entries);
  }
}

async function start(yaml: string, usageSource?: UsageSource) {
  const tmp = await makeTempDataDir();
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  await store.profiles.create({
    client: 'claude-code',
    name: 'work',
    kind: 'token_plan',
    provider: 'anthropic',
    dir: '/p/work',
  });
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(`backup:\n  when: manual\nsecurity:\n  unenforced: allow\n${yaml}`),
    overrides: {
      clock,
      store,
      vault: new InMemorySecretVault(),
      ...(usageSource ? { usageSource } : {}),
    },
    logger: createSilentLogger(),
    version: '9.9.9',
  });
  daemons.push(daemon);
  return { daemon, store, tmp };
}

async function notices(store: InMemoryStore): Promise<{ kind: string; profile: string | null }[]> {
  const events = await store.events.readFrom(0, 1000);
  return events
    .filter((e) => e.type === 'usage.notice')
    .map((e) => e.payload as { kind: string; profile: string | null });
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition did not come true');
}

const ON =
  'usage:\n  ccusage:\n    enabled: true\n    command: /opt/ccusage/ccusage\n    interval: 0\n';

describe('startDaemon with the ccusage check (P12, N118)', () => {
  it('is off by default: no audit and nothing asked', async () => {
    const { daemon, tmp } = await start('');
    try {
      expect(daemon.usageAudit).toBeUndefined();
    } finally {
      await cleanUp(tmp);
    }
  });

  it('with the wrong version the daemon starts and uses the signals alone, with a notice', async () => {
    const source = new FakeSource({
      ok: false,
      reason: 'wrong_version',
      detail: 'ccusage is 1.0.0',
    });
    const { daemon, store, tmp } = await start(ON, source);
    try {
      expect(daemon.status().state).toBe('running');
      await until(async () => (await notices(store)).length > 0);
      expect(await notices(store)).toEqual([
        expect.objectContaining({ kind: 'ccusage_wrong_version', profile: null }),
      ]);
      expect(daemon.usageAudit?.active).toBe(false);
      expect(source.queries).toEqual([]);
    } finally {
      await cleanUp(tmp);
    }
  });

  it('without the binary the real adapter fails the check: a notice, and the daemon runs', async () => {
    const { daemon, store, tmp } = await start(ON);
    try {
      expect(daemon.status().state).toBe('running');
      await until(async () => (await notices(store)).length > 0);
      expect(await notices(store)).toEqual([
        expect.objectContaining({ kind: 'ccusage_unavailable' }),
      ]);
    } finally {
      await cleanUp(tmp);
    }
  });

  it('with a good source it compares each profile and tells a divergence as an event', async () => {
    const source = new FakeSource({ ok: true, version: '20.0.48' }, [
      {
        day: '2026-11-18',
        model: 'm',
        inputTokens: 50_000,
        outputTokens: 10_000,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
      },
    ]);
    const { daemon, store, tmp } = await start(ON, source);
    try {
      await until(async () => (await notices(store)).length > 0);
      expect(source.queries[0]).toMatchObject({ clientId: 'claude-code', profileDir: '/p/work' });
      expect(await notices(store)).toEqual([
        expect.objectContaining({ kind: 'ccusage_divergence', profile: 'claude-code/work' }),
      ]);
      expect(daemon.usageAudit?.active).toBe(true);
    } finally {
      await cleanUp(tmp);
    }
  });
});
