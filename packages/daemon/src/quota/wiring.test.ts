// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  QUOTA_PROBE_PORT_VERSION,
  Secret,
  type ProfileRef,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import {
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { apiKeyRefOf } from '../profiles/secret-env.js';
import { builtClients, clientOf } from './test-clients.js';
import type { LedgerProbe } from './provider-probe.js';
import { quotaProbeOf, type QuotaWiringDeps } from './wiring.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const KEY = 'sk-test-0000-not-a-real-key';
const servers: Server[] = [];

afterEach(async () => {
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

async function serve(seenAuth: string[]): Promise<string> {
  const server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        base_resp: { status_code: 0, status_msg: 'success' },
        data: {
          current_interval_total_count: 100,
          current_interval_usage_count: 70,
          current_interval_reset_time: new Date(T0 + 3_600_000).toISOString(),
        },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

type Rig = QuotaWiringDeps & {
  store: InMemoryStore;
  vault: InMemorySecretVault;
  /** The adapters the daemon builds for this config (the real ones; nothing is launched). */
  clients: ReturnType<typeof builtClients>;
};

function rig(yaml: string): Rig {
  const clock = new FakeClock(T0);
  return {
    clients: builtClients(yaml, clock, {
      launcher: new FakeProcessLauncher(),
      transport: new FakeSessionTransport(),
    }),
    config: parseConfig(yaml),
    store: new InMemoryStore({ clock }),
    vault: new InMemorySecretVault(),
    clock,
    logger: createSilentLogger(),
  };
}

function opencodeClient(deps: Rig) {
  return clientOf(deps.clients, 'opencode');
}

/** The probe of Codex, as the daemon hands it: it says which profile it was asked about. */
function codexStub(): QuotaProbe & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    id: 'codex',
    implements: { port: 'QuotaProbe', range: `^${QUOTA_PROBE_PORT_VERSION}` },
    reads,
    capabilities: () => ({ windows: ['5h', '7d'], delivery: 'poll', precision: 'exact' }),
    read: (profile: ProfileRef): Promise<QuotaReading> => {
      reads.push(`${profile.client}/${profile.profile}`);
      return Promise.resolve({
        observedAt: T0,
        windows: [{ window: '5h', usedPercent: 40 }],
      });
    },
  };
}

describe('quotaProbeOf, codex_link (P25, N156)', () => {
  const LINKED = 'profiles:\n  opencode/oai:\n    codex_link: chatgpt\n';

  it('auto: reads a linked OpenCode profile at the probe of Codex, for the linked profile', async () => {
    const deps = rig(LINKED);
    const codexQuota = codexStub();
    const wiring = quotaProbeOf(opencodeClient(deps), { ...deps, codexQuota });
    const reading = await wiring.probe.read({ client: 'opencode', profile: 'oai' });
    expect(codexQuota.reads).toEqual(['codex/chatgpt']);
    expect(reading.windows).toEqual([{ window: '5h', usedPercent: 40 }]);
  });

  it('ledger: ignores the link, as P8 did', async () => {
    const deps = rig(`${LINKED}quota:\n  opencode:\n    mode: ledger\n`);
    const codexQuota = codexStub();
    const client = opencodeClient(deps);
    const wiring = quotaProbeOf(client, { ...deps, codexQuota });
    expect(wiring.probe.capabilities().windows).not.toContain('7d');
    await wiring.probe.read({ client: 'opencode', profile: 'oai' }).catch(() => undefined);
    expect(codexQuota.reads).toEqual([]);
  });

  it('auto with a limit and no link: the ledger, as the mode ledger', async () => {
    const deps = rig('quota:\n  opencode:\n    limit_tokens: 1000\n');
    const client = opencodeClient(deps);
    const wiring = quotaProbeOf(client, deps);
    expect(wiring.probe).not.toBe(client.quota);
    const profile = { client: 'opencode', profile: 'oai' };
    (wiring.probe as unknown as LedgerProbe).recordUsage(profile, 's1', {
      kind: 'usage',
      outputTokens: 250,
    });
    expect((await wiring.probe.read(profile)).windows[0]).toMatchObject({ usedPercent: 25 });
  });

  it('a link with Codex off: warns, says it as an event, and keeps the plain probe', () => {
    const deps = rig(`${LINKED}quota:\n  opencode:\n    mode: codex_link\n`);
    const events: { type: string; payload: unknown }[] = [];
    const client = opencodeClient(deps);
    const wiring = quotaProbeOf(client, {
      ...deps,
      situations: { record: (type, payload) => events.push({ type, payload }) },
    });
    expect(wiring.probe).toBe(client.quota);
    expect(events).toEqual([
      {
        type: 'daemon.notice',
        payload: {
          kind: 'client_warning',
          subject: 'opencode',
          detail: 'codex_link_without_codex',
        },
      },
    ]);
  });
});

describe('quotaProbeOf', () => {
  it('leaves the probe of every client as it is with the defaults (nothing to route)', () => {
    const deps = rig('');
    const client = opencodeClient(deps);
    const wiring = quotaProbeOf(client, deps);
    expect(wiring.probe).toBe(client.quota);
    expect(wiring.prepare).toBeUndefined();
  });

  it('never touches a client other than OpenCode, even with the modes on', () => {
    const deps = rig('quota:\n  minimax:\n    mode: token_plan\n  opencode:\n    mode: ledger\n');
    const claude = clientOf(deps.clients, 'claude-code');
    expect(quotaProbeOf(claude, deps).probe).toBe(claude.quota);
  });

  it('keeps the plain probe when the ledger is on but the client has no ledger', () => {
    const deps = rig('quota:\n  opencode:\n    mode: ledger\n');
    // The client brought a probe that has no `recordUsage` to count with.
    const { quota } = opencodeClient(deps);
    const bare = {
      id: 'opencode',
      quota: {
        id: quota.id,
        implements: quota.implements,
        capabilities: () => quota.capabilities(),
        read: (profile: ProfileRef) => quota.read(profile),
      },
    };
    expect(quotaProbeOf(bare, deps).probe).toBe(bare.quota);
  });

  it('puts the ledger of the client behind the composite when quota.opencode.mode is ledger', async () => {
    const deps = rig('quota:\n  opencode:\n    mode: ledger\n    limit_tokens: 1000\n');
    const client = opencodeClient(deps);
    const wiring = quotaProbeOf(client, deps);
    expect(wiring.probe).not.toBe(client.quota);
    const profile = { client: 'opencode', profile: 'oai' };
    (wiring.probe as unknown as LedgerProbe).recordUsage(profile, 's1', {
      kind: 'usage',
      outputTokens: 500,
    });
    const reading = await wiring.probe.read(profile);
    expect(reading.windows[0]).toMatchObject({ window: 'ledger_tokens', usedPercent: 50 });
  });

  it('reads a MiniMax profile at the endpoint with its vault key, under the network policy', async () => {
    const seen: string[] = [];
    const base = await serve(seen);
    const deps = rig(
      `quota:\n  minimax:\n    mode: token_plan\n    base_url: ${base}\n    allow_hosts: ['127.0.0.1']\n`,
    );
    const ref = apiKeyRefOf('opencode', 'mm');
    await deps.vault.set(ref, new Secret(KEY));
    await deps.store.profiles.create({
      client: 'opencode',
      name: 'mm',
      kind: 'api',
      provider: 'minimax',
      dir: '/p/mm',
      secretRef: ref,
    });
    await deps.store.profiles.create({
      client: 'opencode',
      name: 'gone',
      kind: 'api',
      provider: 'minimax',
      dir: '/p/gone',
      secretRef: null,
    });
    await deps.store.profiles.update('opencode/gone', { state: 'draining' });
    await deps.store.profiles.update('opencode/gone', { state: 'removed' });
    const wiring = quotaProbeOf(opencodeClient(deps), deps);
    const refs = await wiring.prepare?.();
    expect(refs).toEqual([{ client: 'opencode', profile: 'mm' }]);
    const reading = await wiring.probe.read({ client: 'opencode', profile: 'mm' });
    expect(reading.windows[0]).toMatchObject({ window: '5h', usedPercent: 30 });
    expect(seen).toEqual([`Bearer ${KEY}`]);
  });

  it('refuses a host outside quota.minimax.allow_hosts, without a call', async () => {
    const seen: string[] = [];
    const base = await serve(seen);
    const deps = rig(
      `quota:\n  minimax:\n    mode: token_plan\n    base_url: ${base}\n    allow_hosts: ['api.minimax.io']\n`,
    );
    const ref = apiKeyRefOf('opencode', 'mm');
    await deps.vault.set(ref, new Secret(KEY));
    await deps.store.profiles.create({
      client: 'opencode',
      name: 'mm',
      kind: 'api',
      provider: 'minimax',
      dir: '/p/mm',
      secretRef: ref,
    });
    const wiring = quotaProbeOf(opencodeClient(deps), deps);
    await expect(wiring.probe.read({ client: 'opencode', profile: 'mm' })).rejects.toThrow(
      /allowlist/,
    );
    expect(seen).toEqual([]);
  });
});
