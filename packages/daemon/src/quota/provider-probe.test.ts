// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  QuotaExhausted,
  type AdapterImplements,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import {
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { MiniMaxQuotaProbe } from './minimax-probe.js';
import { ProviderQuotaProbe, type LedgerProbe } from './provider-probe.js';
import { realLedger } from './test-clients.js';
import { QuotaService, type UsageSink } from './service.js';

const FAKES = () => ({
  launcher: new FakeProcessLauncher(),
  transport: new FakeSessionTransport(),
});
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const MM: ProfileRef = { client: 'opencode', profile: 'mm' };
const OAI: ProfileRef = { client: 'opencode', profile: 'oai' };

const PROVIDERS: Record<string, string> = { 'opencode/mm': 'minimax', 'opencode/oai': 'openai' };
const providerOf = (ref: ProfileRef): Promise<string | undefined> =>
  Promise.resolve(PROVIDERS[`${ref.client}/${ref.profile}`]);

/** A probe that says where it was asked, with the windows it announces. */
class StubProbe implements QuotaProbe, UsageSink {
  readonly id: string;
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  readonly reads: string[] = [];
  readonly usages: string[] = [];
  readonly pushers: ((reading: QuotaReading) => void)[] = [];

  constructor(
    id: string,
    readonly windows: readonly string[],
  ) {
    this.id = id;
  }

  capabilities(): QuotaCapabilities {
    return { windows: this.windows, delivery: 'poll', precision: 'approximate' };
  }

  read(profile: ProfileRef): Promise<QuotaReading> {
    this.reads.push(`${profile.client}/${profile.profile}`);
    return Promise.resolve({ observedAt: T0, windows: [] });
  }

  recordUsage(profile: ProfileRef, sessionId: string): void {
    this.usages.push(`${profile.profile}:${sessionId}`);
  }

  watch(
    _profile: ProfileRef,
    onChange: (reading: QuotaReading) => void,
  ): {
    dispose: () => void;
  } {
    this.pushers.push(onChange);
    return { dispose: () => undefined };
  }
}

describe('ProviderQuotaProbe routing', () => {
  it('reads a MiniMax profile at the MiniMax probe and any other one in the ledger', async () => {
    const ledger = new StubProbe('ledger', ['ledger_tokens']);
    const minimax = new StubProbe('minimax', ['5h']);
    const probe = new ProviderQuotaProbe({ ledger, minimax, providerOf });
    await probe.read(MM);
    await probe.read(OAI);
    expect(minimax.reads).toEqual(['opencode/mm']);
    expect(ledger.reads).toEqual(['opencode/oai']);
  });

  it('falls back to the ledger for a MiniMax profile when the MiniMax probe is off', async () => {
    const ledger = new StubProbe('ledger', ['ledger_tokens']);
    const probe = new ProviderQuotaProbe({ ledger, providerOf });
    await probe.read(MM);
    expect(ledger.reads).toEqual(['opencode/mm']);
  });

  it('reads a profile of the registry with an unknown provider in the ledger, and does not cache it', async () => {
    const ledger = new StubProbe('ledger', ['ledger_tokens']);
    const minimax = new StubProbe('minimax', ['5h']);
    const known: Record<string, string> = {};
    const probe = new ProviderQuotaProbe({
      ledger,
      minimax,
      providerOf: (ref) => Promise.resolve(known[ref.profile]),
    });
    await probe.read({ client: 'opencode', profile: 'late' });
    expect(ledger.reads).toEqual(['opencode/late']);
    known.late = 'minimax';
    await probe.read({ client: 'opencode', profile: 'late' });
    expect(minimax.reads).toEqual(['opencode/late']);
  });

  it('refuses to read when both are off, as the skeleton did', async () => {
    const probe = new ProviderQuotaProbe({ providerOf });
    await expect(probe.read(OAI)).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(probe.capabilities().windows).toEqual([]);
    expect(probe.watch).toBeUndefined();
  });

  it('hands every usage event to the ledger, whatever the provider', () => {
    const ledger = new StubProbe('ledger', ['ledger_tokens']);
    const minimax = new StubProbe('minimax', ['5h']);
    const probe = new ProviderQuotaProbe({ ledger, minimax, providerOf });
    probe.recordUsage(MM, 's1', { kind: 'usage', outputTokens: 1 });
    probe.recordUsage(OAI, 's2', { kind: 'usage', outputTokens: 1 });
    expect(ledger.usages).toEqual(['mm:s1', 'oai:s2']);
    expect(minimax.usages).toEqual([]);
  });

  it('expects the windows of the route of the profile, known after warm', async () => {
    const ledger = new StubProbe('ledger', ['ledger_tokens']);
    const minimax = new StubProbe('minimax', ['5h']);
    const probe = new ProviderQuotaProbe({ ledger, minimax, providerOf });
    expect(probe.capabilities()).toEqual({
      windows: ['5h', 'ledger_tokens'],
      delivery: 'both',
      precision: 'approximate',
    });
    expect(probe.windowsOf(MM)).toEqual(['ledger_tokens']);
    await probe.warm([MM, OAI]);
    expect(probe.windowsOf(MM)).toEqual(['5h']);
    expect(probe.windowsOf(OAI)).toEqual(['ledger_tokens']);
  });

  it('says exact and poll when only the MiniMax probe is on', () => {
    const minimax = new StubProbe('minimax', ['5h']);
    const probe = new ProviderQuotaProbe({ minimax, providerOf });
    expect(probe.capabilities()).toEqual({ windows: ['5h'], delivery: 'poll', precision: 'exact' });
    expect(probe.watch).toBeUndefined();
  });

  it('pushes the ledger only for a profile that is on the ledger route', async () => {
    const ledger = new StubProbe('ledger', ['ledger_tokens']);
    const minimax = new StubProbe('minimax', ['5h']);
    const probe = new ProviderQuotaProbe({ ledger, minimax, providerOf });
    await probe.warm([MM, OAI]);
    const seen: string[] = [];
    probe.watch?.(MM, () => seen.push('mm'));
    probe.watch?.(OAI, () => seen.push('oai'));
    const [forMm, forOai] = ledger.pushers;
    forMm?.({ observedAt: T0, windows: [] });
    forOai?.({ observedAt: T0, windows: [] });
    expect(seen).toEqual(['oai']);
  });
});

// ---- the aceite of P8, through the real QuotaService ----

const servers: Server[] = [];
const services: QuotaService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
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

async function fakeMiniMax(body: unknown): Promise<string> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function rig(options: { limitTokens?: number; minimaxBase?: string } = {}): {
  clock: FakeClock;
  store: InMemoryStore;
  service: QuotaService;
  ledger: LedgerProbe;
  probe: ProviderQuotaProbe;
} {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const logger = createSilentLogger();
  const ledger = realLedger(clock, { limitTokens: options.limitTokens ?? 1000 }, FAKES());
  const minimax =
    options.minimaxBase === undefined
      ? undefined
      : new MiniMaxQuotaProbe({
          baseUrl: options.minimaxBase,
          network: { allowHosts: ['127.0.0.1'], timeoutMs: 2000 },
          usageCountMeans: 'remaining',
          keyOf: () => Promise.resolve('sk-test-key'),
          clock,
          logger,
        });
  const probe = new ProviderQuotaProbe({ ledger, ...(minimax ? { minimax } : {}), providerOf });
  const service = new QuotaService({
    store,
    clock,
    settings: { nearLimitAt: 0.8, staleAfterMs: 10 * MIN, delivery: 'both', pollEveryMs: 5 * MIN },
    logger,
  });
  service.addProbe('opencode', probe);
  services.push(service);
  return { clock, store, service, ledger, probe };
}

describe('P8 aceite: the OpenCode probe is local accounting', () => {
  it('sums the consumption of a session and the profile moves to near_limit', async () => {
    const { service, probe } = rig({ limitTokens: 1000 });
    await probe.warm([OAI]);
    service.bindSession('s1', OAI);
    await service.ingestUpdate('s1', { kind: 'usage', inputTokens: 300, outputTokens: 100 });
    expect(await service.refresh(OAI)).toMatchObject({ state: 'ok' });
    await service.ingestUpdate('s1', { kind: 'usage', inputTokens: 300, outputTokens: 150 });
    const status = await service.refresh(OAI);
    expect(status).toMatchObject({ state: 'near_limit' });
    expect(status.windows[0]).toMatchObject({ window: 'ledger_tokens', usedPercent: 85 });
  });

  it('pushes the move to near_limit by itself when the service is running', async () => {
    const { clock, service, probe, store } = rig({ limitTokens: 1000 });
    await probe.warm([OAI]);
    service.bindSession('s1', OAI);
    await service.start();
    // Let the first poll settle, then move time so the pushed reading is the newer one.
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    await clock.advance(1000);
    await service.ingestUpdate('s1', { kind: 'usage', outputTokens: 900 });
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await service.statusOf(OAI)).toMatchObject({ state: 'near_limit' });
    const events = await store.events.readFrom(0, 100);
    expect(events.map((e) => e.type)).toContain('quota.near_limit');
  });

  it('a limit error without a time marks exhausted, and a later reading with room supersedes it', async () => {
    const { clock, service, probe } = rig({ limitTokens: 1000 });
    await probe.warm([OAI]);
    service.bindSession('s1', OAI);
    await service.ingestUpdate('s1', { kind: 'usage', outputTokens: 100 });
    // The provider says the limit is hit, with no reset time (P9's recheck does not exist yet).
    await service.ingestError('s1', new QuotaExhausted('limit reached'));
    expect(await service.statusOf(OAI)).toMatchObject({
      state: 'exhausted',
      cause: 'quota',
      untilReset: null,
    });
    // A fresh reading taken after the hit, with room in every window, supersedes it.
    await clock.advance(MIN);
    expect(await service.refresh(OAI)).toMatchObject({ state: 'ok', untilReset: null });
  });

  it('the ledger filling up marks exhausted until the oldest event leaves the window', async () => {
    const { service, probe } = rig({ limitTokens: 1000 });
    await probe.warm([OAI]);
    service.bindSession('s1', OAI);
    await service.ingestUpdate('s1', { kind: 'usage', outputTokens: 1000 });
    expect(await service.refresh(OAI)).toMatchObject({
      state: 'exhausted',
      untilReset: T0 + 5 * HOUR,
    });
  });
});

describe('P8 aceite: a MiniMax profile next to an OpenAI one on the same client', () => {
  it('reads each one at its own source, and neither is unknown for the other window', async () => {
    const reset = new Date(T0 + 3 * HOUR).toISOString();
    const base = await fakeMiniMax({
      base_resp: { status_code: 0 },
      data: {
        current_interval_total_count: 100,
        current_interval_usage_count: 10,
        current_interval_reset_time: reset,
      },
    });
    const { service, probe } = rig({ minimaxBase: base });
    await probe.warm([MM, OAI]);
    expect(await service.refresh(MM)).toMatchObject({ state: 'near_limit' });
    expect((await service.statusOf(MM)).windows.map((w) => w.window)).toEqual(['5h']);
    expect(await service.refresh(OAI)).toMatchObject({ state: 'ok' });
    expect((await service.statusOf(OAI)).windows.map((w) => w.window)).toEqual(['ledger_tokens']);
  });

  it('a MiniMax 1004 leaves its profile unknown while the other one reads fine', async () => {
    const base = await fakeMiniMax({ base_resp: { status_code: 1004, status_msg: 'login fail' } });
    const { service, probe } = rig({ minimaxBase: base });
    await probe.warm([MM, OAI]);
    expect(await service.refresh(MM)).toMatchObject({ state: 'unknown' });
    expect(await service.refresh(OAI)).toMatchObject({ state: 'ok' });
  });
});
