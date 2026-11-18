// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  QuotaExhausted,
  type AdapterImplements,
  type AgentSession,
  type ClientAdapterContract,
  type ContentBlock,
  type NormalizedUpdate,
  type Profile,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
  type UpdateListener,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { RecordingSituations } from '../test-helpers.js';
import { QuotaService, type UsageSink, type UsageUpdate } from './service.js';
import { tapClient } from './tap.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK = 'opencode/work';
const PROFILE: Profile = { id: WORK, client: 'opencode', profile: 'work', dir: '/profiles/work' };
const BLOCKS: readonly ContentBlock[] = [{ type: 'text', text: 'hi' }];

/** A probe that only counts what the service hands it. */
class CountingProbe implements QuotaProbe, UsageSink {
  readonly id = 'counting';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  readonly usages: { profile: string; sessionId: string; usage: UsageUpdate }[] = [];

  capabilities(): QuotaCapabilities {
    return { windows: [], delivery: 'poll', precision: 'approximate' };
  }

  read(): Promise<QuotaReading> {
    return Promise.reject(new AdapterUnavailable('nothing to read'));
  }

  recordUsage(profile: ProfileRef, sessionId: string, usage: UsageUpdate): void {
    this.usages.push({ profile: `${profile.client}/${profile.profile}`, sessionId, usage });
  }
}

/** A session the test drives: what the next prompt does, and the updates it emits. */
class ScriptedSession implements AgentSession {
  readonly canLoad = true;
  readonly configOptions = [];
  readonly listeners = new Set<UpdateListener>();
  closed = false;
  outcome: () => Promise<{ stopReason: 'end_turn' }> = () =>
    Promise.resolve({ stopReason: 'end_turn' });

  constructor(readonly sessionId: string) {}

  prompt(): Promise<{ stopReason: 'end_turn' }> {
    return this.outcome();
  }

  onUpdate(listener: UpdateListener): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(update: NormalizedUpdate): void {
    for (const listener of [...this.listeners]) listener(update);
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  setConfig(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** The part of a client adapter the tap touches, with a private field to prove binding works. */
class StubClient {
  readonly id = 'opencode';
  readonly #secret = 'kept';
  readonly quota: QuotaProbe;
  next: () => Promise<AgentSession> = () => Promise.resolve(new ScriptedSession('s1'));
  opened = 0;

  constructor(quota: QuotaProbe) {
    this.quota = quota;
  }

  get secret(): string {
    return this.#secret;
  }

  openSession(): Promise<AgentSession> {
    this.opened += 1;
    return this.next();
  }

  loadSession(): Promise<AgentSession> {
    return this.next();
  }

  describe(): string {
    return `${this.id}:${this.#secret}`;
  }
}

const started: QuotaService[] = [];

function setup(): {
  clock: FakeClock;
  store: InMemoryStore;
  probe: CountingProbe;
  service: QuotaService;
  client: StubClient;
  tapped: ClientAdapterContract;
} {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const probe = new CountingProbe();
  const service = new QuotaService({
    store,
    clock,
    settings: { nearLimitAt: 0.8, staleAfterMs: 10 * MIN, delivery: 'poll', pollEveryMs: 5 * MIN },
    logger: createSilentLogger(),
  });
  service.addProbe('opencode', probe);
  started.push(service);
  const client = new StubClient(probe);
  const tapped = tapClient(
    client as unknown as ClientAdapterContract,
    service,
    createSilentLogger(),
  );
  return { clock, store, probe, service, client, tapped };
}

async function open(tapped: ClientAdapterContract): Promise<AgentSession> {
  return tapped.openSession(PROFILE, {} as never, '/work', {} as never);
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((service) => service.stop()));
});

describe('tapClient', () => {
  it('leaves the other members of the client as they were, bound to the client', () => {
    const { tapped, client } = setup();
    expect(tapped.id).toBe('opencode');
    expect(tapped.quota).toBe(client.quota);
    expect((tapped as unknown as StubClient).describe()).toBe('opencode:kept');
    expect((tapped as unknown as StubClient).secret).toBe('kept');
  });

  it('hands the usage updates of a session to the probe of its client, under its profile', async () => {
    const { tapped, client, probe, service } = setup();
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    const session = await open(tapped);
    expect(session.sessionId).toBe('s1');
    inner.emit({ kind: 'usage', costUsd: 0.5 });
    inner.emit({ kind: 'plan', entries: [] });
    await service.sync();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(probe.usages).toEqual([
      { profile: WORK, sessionId: 's1', usage: { kind: 'usage', costUsd: 0.5 } },
    ]);
  });

  it('marks the profile exhausted with the reset time and the source of a limit error', async () => {
    const { tapped, client, service, store } = setup();
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    const session = await open(tapped);
    const resetsAt = T0 + 30 * MIN;
    const normalized = { kind: 'quota_exhausted', message: 'over', resetsAt, limitSource: '429' };
    const error = new QuotaExhausted('over', { cause: normalized });
    inner.outcome = () => Promise.reject(error);
    // The error reaches the caller untouched, and the service already knows by then.
    await expect(session.prompt(BLOCKS)).rejects.toBe(error);
    expect(await service.statusOf(WORK)).toMatchObject({
      state: 'exhausted',
      cause: 'quota',
      untilReset: resetsAt,
    });
    const events = (await store.events.readFrom(0, 100)).filter(
      (e) => e.type === 'quota.exhausted',
    );
    expect(events[0]?.payload).toMatchObject({ source: 'limit_hit:429', untilReset: resetsAt });
  });

  it('takes a rate_limit event of the stream as a limit hit with its own source', async () => {
    const { tapped, client, service } = setup();
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    await open(tapped);
    const resetsAt = T0 + 10 * MIN;
    inner.emit({ kind: 'rate_limit', status: 'rejected', resetsAt });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await service.statusOf(WORK)).toMatchObject({
      state: 'exhausted',
      untilReset: resetsAt,
    });
  });

  it('leaves an error that is not about the quota alone', async () => {
    const { tapped, client, service } = setup();
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    const session = await open(tapped);
    inner.outcome = () => Promise.reject(new AdapterUnavailable('the client died'));
    await expect(session.prompt(BLOCKS)).rejects.toBeInstanceOf(AdapterUnavailable);
    expect((await service.statusOf(WORK)).state).toBe('unknown');
  });

  it('takes in a QuotaExhausted of openSession itself as a limit hit of the profile', async () => {
    const { tapped, client, service } = setup();
    client.next = () => Promise.reject(new QuotaExhausted('no quota to start'));
    await expect(open(tapped)).rejects.toBeInstanceOf(QuotaExhausted);
    expect(await service.statusOf(WORK)).toMatchObject({ state: 'exhausted', untilReset: null });
  });

  it('stops listening and forgets the session when it closes', async () => {
    const { tapped, client, probe } = setup();
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    const session = await open(tapped);
    await session.close();
    expect(inner.closed).toBe(true);
    expect(inner.listeners.size).toBe(0);
    inner.emit({ kind: 'usage', costUsd: 1 });
    expect(probe.usages).toEqual([]);
  });

  it('opens a session on loadSession the same way', async () => {
    const { tapped, client, probe } = setup();
    const inner = new ScriptedSession('s9');
    client.next = () => Promise.resolve(inner);
    const session = await tapped.loadSession(PROFILE, {} as never, '/work', 's9', {} as never);
    inner.emit({ kind: 'usage', outputTokens: 3 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.sessionId).toBe('s9');
    expect(probe.usages.map((u) => u.sessionId)).toEqual(['s9']);
  });
});

describe('tapClient, what it also tells as events (P24, N146)', () => {
  /** The same client, with a sink for the situations. */
  function tappedWithSituations() {
    const { service, client } = setup();
    const situations = new RecordingSituations();
    const tapped = tapClient(
      client as unknown as ClientAdapterContract,
      service,
      createSilentLogger(),
      situations,
    );
    return { service, client, tapped, situations };
  }

  it('quota.signal_dropped missed_update: the service fails to take an update', async () => {
    const { service, client, tapped, situations } = tappedWithSituations();
    vi.spyOn(service, 'ingestUpdate').mockRejectedValue(new Error('the store is gone'));
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    await open(tapped);
    inner.emit({ kind: 'usage', outputTokens: 3 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(situations.of('quota.signal_dropped')).toEqual([
      { reason: 'missed_update', profile: WORK, sessionId: 's1', detail: 'the store is gone' },
    ]);
  });

  it('quota.signal_dropped missed_limit_error: the service fails to take the error of a prompt', async () => {
    const { service, client, tapped, situations } = tappedWithSituations();
    vi.spyOn(service, 'ingestError').mockRejectedValue(new Error('the store is gone'));
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    const session = await open(tapped);
    inner.outcome = () => Promise.reject(new QuotaExhausted('over'));
    await expect(session.prompt(BLOCKS)).rejects.toBeInstanceOf(QuotaExhausted);
    expect(situations.of('quota.signal_dropped')).toEqual([
      { reason: 'missed_limit_error', profile: WORK, sessionId: 's1', detail: 'the store is gone' },
    ]);
  });

  it('quota.signal_dropped missed_limit_error: the service fails to take the error of openSession', async () => {
    const { service, client, tapped, situations } = tappedWithSituations();
    vi.spyOn(service, 'ingestLimitHit').mockRejectedValue(new Error('the store is gone'));
    client.next = () => Promise.reject(new QuotaExhausted('no quota to start'));
    await expect(open(tapped)).rejects.toBeInstanceOf(QuotaExhausted);
    expect(situations.of('quota.signal_dropped')).toEqual([
      { reason: 'missed_limit_error', profile: WORK, sessionId: null, detail: 'the store is gone' },
    ]);
  });

  it('says nothing when the service takes everything in', async () => {
    const { client, tapped, situations } = tappedWithSituations();
    const inner = new ScriptedSession('s1');
    client.next = () => Promise.resolve(inner);
    await open(tapped);
    inner.emit({ kind: 'usage', outputTokens: 3 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(situations.recorded).toEqual([]);
  });
});
