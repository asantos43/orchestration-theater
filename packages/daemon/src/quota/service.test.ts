// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  QuotaExhausted,
  type AdapterImplements,
  type Disposable,
  type EventEnvelope,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { QuotaService, limitHitOf, parseResetsAt } from './service.js';
import type { QuotaSettings } from './settings.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK = 'claude-code/work';
const HOME = 'claude-code/home';

/** A probe the test drives: what it reads, and when it fails or pushes. */
class SimProbe implements QuotaProbe {
  readonly id = 'sim';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  readonly reads: string[] = [];
  readonly watched: string[] = [];
  readings = new Map<string, QuotaReading>();
  failing = false;
  #pushers = new Map<string, (reading: QuotaReading) => void>();

  constructor(
    readonly windows: readonly string[],
    readonly canWatch = true,
  ) {
    if (!canWatch) Object.defineProperty(this, 'watch', { value: undefined });
  }

  capabilities(): QuotaCapabilities {
    return { windows: this.windows, delivery: 'both', precision: 'exact' };
  }

  read(profile: ProfileRef): Promise<QuotaReading> {
    const id = `${profile.client}/${profile.profile}`;
    this.reads.push(id);
    const reading = this.readings.get(id);
    if (this.failing || reading === undefined) {
      return Promise.reject(new AdapterUnavailable('no quota source yet'));
    }
    return Promise.resolve(reading);
  }

  watch(profile: ProfileRef, onChange: (reading: QuotaReading) => void): Disposable {
    const id = `${profile.client}/${profile.profile}`;
    this.watched.push(id);
    this.#pushers.set(id, onChange);
    return {
      dispose: () => {
        this.#pushers.delete(id);
      },
    };
  }

  push(id: string, reading: QuotaReading): void {
    this.#pushers.get(id)?.(reading);
  }

  get watching(): number {
    return this.#pushers.size;
  }
}

const started: QuotaService[] = [];

function setup(
  over: Partial<QuotaSettings> = {},
  windows: readonly string[] = ['5h', '7d'],
): {
  clock: FakeClock;
  store: InMemoryStore;
  probe: SimProbe;
  service: QuotaService;
  another: () => QuotaService;
} {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const probe = new SimProbe(windows);
  const make = (): QuotaService => {
    const service = new QuotaService({
      store,
      clock,
      settings: {
        nearLimitAt: 0.8,
        staleAfterMs: 10 * MIN,
        delivery: 'both',
        pollEveryMs: 5 * MIN,
        ...over,
      },
      logger: createSilentLogger(),
    });
    service.addProbe('claude-code', probe);
    started.push(service);
    return service;
  };
  return { clock, store, probe, service: make(), another: make };
}

const reading = (
  fiveHour: number,
  sevenDay: number,
  over: { observedAt?: number; resetsAt?: number } = {},
): QuotaReading => ({
  observedAt: over.observedAt ?? T0,
  windows: [
    { window: '5h', usedPercent: fiveHour, resetsAt: over.resetsAt ?? T0 + 120 * MIN },
    { window: '7d', usedPercent: sevenDay, resetsAt: over.resetsAt ?? T0 + 5000 * MIN },
  ],
});

const iso = (ms: number): string => new Date(ms).toISOString();

async function quotaEvents(store: InMemoryStore): Promise<EventEnvelope[]> {
  return (await store.events.readFrom(0, 1000)).filter((e) => e.type.startsWith('quota.'));
}

async function types(store: InMemoryStore): Promise<string[]> {
  return (await quotaEvents(store)).map((e) => e.type);
}

/** Lets the work that is already queued (reads, pushes, the loops) run to its next wait. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function openSession(
  store: InMemoryStore,
  id: string,
  profile: string,
  clientSessionId: string | null = null,
): Promise<void> {
  await store.sessions.open({ id, client: 'claude-code', profile, clientSessionId });
}

afterEach(async () => {
  for (const service of started.splice(0)) await service.stop();
});

describe('QuotaService, state of a profile (architecture 5.6)', () => {
  it('moves a profile to near_limit when a window reaches 85%, and still lets it be used', async () => {
    const { service, store } = setup();
    await service.ingestReading(WORK, reading(85, 20));
    const status = await service.statusOf(WORK);
    expect(status.state).toBe('near_limit');
    expect(status.nearLimitWindow?.window).toBe('5h');
    expect(await service.canUse(WORK)).toBe(true);
    const events = await quotaEvents(store);
    expect(events.map((e) => e.type)).toEqual(['quota.updated', 'quota.near_limit']);
    expect(events[1]?.payload).toMatchObject({
      profile: WORK,
      window: '5h',
      usedPercent: 85,
      thresholdPercent: 80,
    });
  });

  it('is ok below the threshold, and says nothing more than the update', async () => {
    const { service, store } = setup();
    await service.ingestReading(WORK, reading(30, 20));
    expect((await service.statusOf(WORK)).state).toBe('ok');
    expect(await types(store)).toEqual(['quota.updated']);
  });

  it('makes a -32001 error with resetsAt exhausted until that time', async () => {
    const { service, store } = setup();
    service.bindSession('s1', WORK);
    const resetsAt = T0 + 90 * MIN;
    const taken = await service.ingestError('s1', {
      code: -32001,
      message: 'quota exhausted',
      data: { type: 'QuotaExhausted', resetsAt: iso(resetsAt) },
    });
    expect(taken).toBe(true);
    const status = await service.statusOf(WORK);
    expect(status).toMatchObject({ state: 'exhausted', cause: 'quota', untilReset: resetsAt });
    expect(await service.canUse(WORK)).toBe(false);
    const exhausted = (await quotaEvents(store)).find((e) => e.type === 'quota.exhausted');
    expect(exhausted?.payload).toMatchObject({
      profile: WORK,
      cause: 'quota',
      untilReset: resetsAt,
    });
  });

  it('takes the error the fake agent plays (-32001 with no time) as exhausted with no end', async () => {
    const { service } = setup();
    service.bindSession('s1', WORK);
    const error = Object.assign(new Error('quota exhausted'), {
      code: -32001,
      data: { type: 'QuotaExhausted' },
    });
    expect(await service.ingestError('s1', error)).toBe(true);
    expect(await service.statusOf(WORK)).toMatchObject({ state: 'exhausted', untilReset: null });
    // A QuotaExhausted that the managed session already typed counts the same.
    service.bindSession('s2', HOME);
    expect(await service.ingestError('s2', new QuotaExhausted('over'))).toBe(true);
    expect((await service.statusOf(HOME)).state).toBe('exhausted');
  });

  it('ignores an error that is not about the quota', async () => {
    const { service, store } = setup();
    service.bindSession('s1', WORK);
    expect(await service.ingestError('s1', new Error('boom'))).toBe(false);
    expect(await service.ingestError('s1', { code: -32603 })).toBe(false);
    expect(await quotaEvents(store)).toEqual([]);
  });

  it('turns a stale reading into unknown, and canUse refuses', async () => {
    const { service, clock } = setup();
    await service.ingestReading(WORK, reading(10, 10));
    expect(await service.canUse(WORK)).toBe(true);
    await clock.advance(11 * MIN);
    const status = await service.statusOf(WORK);
    expect(status.state).toBe('unknown');
    expect(await service.canUse(WORK)).toBe(false);
  });

  it('is unknown while a window has no reading', async () => {
    const { service } = setup();
    await service.ingestReading(WORK, {
      observedAt: T0,
      windows: [{ window: '5h', usedPercent: 10, resetsAt: T0 + 60 * MIN }],
    });
    expect((await service.statusOf(WORK)).state).toBe('unknown');
    expect(await service.canUse(WORK)).toBe(false);
  });

  it('is unknown for a profile nobody has read, with no event', async () => {
    const { service, store } = setup();
    expect((await service.statusOf(WORK)).state).toBe('unknown');
    expect(await service.canUse(WORK)).toBe(false);
    expect(await quotaEvents(store)).toEqual([]);
  });

  it('adds the signals of two sessions of the same profile to one state', async () => {
    const { service, store } = setup();
    await openSession(store, 'sess-a', 'work', 'acp-a');
    await openSession(store, 'sess-b', 'claude-code/work');
    await service.ingestNotification({
      sessionId: 'acp-a',
      signal: { kind: 'window', window: '5h', usedPercent: 30, resetsAt: iso(T0 + 60 * MIN) },
    });
    expect((await service.statusOf(WORK)).state).toBe('unknown');
    await service.ingestNotification({
      sessionId: 'sess-b',
      signal: { kind: 'window', window: '7d', usedPercent: 90, resetsAt: iso(T0 + 600 * MIN) },
    });
    const status = await service.statusOf(WORK);
    expect(status.state).toBe('near_limit');
    expect(status.windows.map((w) => w.window).sort()).toEqual(['5h', '7d']);
    await service.ingestNotification({
      sessionId: 'sess-a',
      signal: { kind: 'limit_hit', source: 'client', resetsAt: iso(T0 + 30 * MIN) },
    });
    expect(await service.statusOf(WORK)).toMatchObject({
      state: 'exhausted',
      untilReset: T0 + 30 * MIN,
    });
  });

  it('keeps one profile apart from another', async () => {
    const { service } = setup();
    service.bindSession('s-work', WORK);
    service.bindSession('s-home', HOME);
    await service.ingestReading(HOME, reading(10, 10));
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 30 * MIN });
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    expect((await service.statusOf(HOME)).state).toBe('ok');
    expect(await service.canUse(HOME)).toBe(true);
    await service.ingestReading(HOME, reading(95, 10));
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    expect((await service.statusOf(HOME)).state).toBe('near_limit');
  });

  it('refuses a signal of a session it cannot tie to a profile, and a signal that does not parse', async () => {
    const { service, store } = setup();
    const signal = { kind: 'window', window: '5h', usedPercent: 50 };
    expect(await service.ingestNotification({ sessionId: 'nobody', signal })).toBe(false);
    expect(await service.ingestNotification({ sessionId: 's', signal: { kind: 'mystery' } })).toBe(
      false,
    );
    expect(await service.ingestNotification('not even an object')).toBe(false);
    // The launcher's own rows carry no profile.
    await openSession(store, 'l1', 'launcher');
    expect(await service.ingestNotification({ sessionId: 'l1', signal })).toBe(false);
    expect(await quotaEvents(store)).toEqual([]);
  });

  it('takes a usage signal without moving the state', async () => {
    const { service, store } = setup();
    service.bindSession('s1', WORK);
    const taken = await service.ingestSignal('s1', {
      kind: 'usage',
      model: 'm',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(taken).toBe(true);
    expect(await quotaEvents(store)).toEqual([]);
  });

  it('reads the rate_limit update of the normalized stream', async () => {
    const { service } = setup();
    service.bindSession('s1', WORK);
    await service.ingestUpdate('s1', {
      kind: 'rate_limit',
      status: 'warning',
      window: '5h',
      usedPercent: 82,
      resetsAt: T0 + 60 * MIN,
    });
    expect((await service.statusOf(WORK)).windows.find((w) => w.window === '5h')?.usedPercent).toBe(
      82,
    );
    await service.ingestUpdate('s1', {
      kind: 'rate_limit',
      status: 'rejected',
      resetsAt: T0 + 20 * MIN,
    });
    expect(await service.statusOf(WORK)).toMatchObject({
      state: 'exhausted',
      untilReset: T0 + 20 * MIN,
    });
    expect(await service.ingestUpdate('s1', { kind: 'config_changed', options: [] } as never)).toBe(
      false,
    );
  });

  it('keeps the known reset time when a later hit does not carry one', async () => {
    const { service } = setup();
    await service.ingestLimitHit(WORK, { source: 'a', resetsAt: T0 + 40 * MIN });
    await service.ingestLimitHit(WORK, { source: 'b' });
    expect((await service.statusOf(WORK)).untilReset).toBe(T0 + 40 * MIN);
  });

  it('does not give a budget exhaustion an end the quota did not state', async () => {
    const { service, store } = setup();
    await service.ingestLimitHit(WORK, { source: 'cap', cause: 'budget' });
    expect(await service.statusOf(WORK)).toMatchObject({
      state: 'exhausted',
      cause: 'budget',
      untilReset: null,
    });
    await service.ingestReading(WORK, reading(10, 10, { observedAt: T0 + 1 }));
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    const exhausted = (await quotaEvents(store)).filter((e) => e.type === 'quota.exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.payload).toMatchObject({ cause: 'budget' });
  });

  it('drops a probe reading that does not fit the schema', async () => {
    const { service, store } = setup();
    const bad = { observedAt: -1, windows: [] } as QuotaReading;
    expect((await service.ingestReading(WORK, bad)).state).toBe('unknown');
    expect(await quotaEvents(store)).toEqual([]);
  });
});

describe('QuotaService, exhaustion and recovery', () => {
  it('stays exhausted until the reset and then says quota.restored by itself', async () => {
    const { service, store, clock } = setup();
    await service.start();
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 5 * MIN });
    await flush();
    expect(await types(store)).toEqual(['quota.updated', 'quota.exhausted']);
    await clock.advance(5 * MIN + 2000);
    await flush();
    const events = await quotaEvents(store);
    expect(events.map((e) => e.type)).toEqual([
      'quota.updated',
      'quota.exhausted',
      'quota.updated',
      'quota.restored',
    ]);
    expect(events[3]?.payload).toMatchObject({ profile: WORK, cause: 'quota', reason: 'reset' });
    // Nobody has read it since: it is not usable on faith.
    expect(await service.canUse(WORK)).toBe(false);
  });

  it('stays exhausted with no end until a fresh reading with room says otherwise', async () => {
    const { service, store, clock } = setup();
    await service.ingestLimitHit(WORK, { source: 'test' });
    await clock.advance(3 * 60 * MIN);
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    await service.ingestReading(
      WORK,
      reading(10, 10, { observedAt: clock.now(), resetsAt: clock.now() + 60 * MIN }),
    );
    expect((await service.statusOf(WORK)).state).toBe('ok');
    const restored = (await quotaEvents(store)).find((e) => e.type === 'quota.restored');
    expect(restored?.payload).toMatchObject({ state: 'ok', reason: 'reading' });
  });

  it('is still exhausted after a restart of the daemon, and does not announce it again', async () => {
    const { service, store, another } = setup();
    const resetsAt = T0 + 50 * MIN;
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt });
    const before = await types(store);
    await service.stop();
    const restarted = another();
    await restarted.start();
    expect(await restarted.statusOf(WORK)).toMatchObject({
      state: 'exhausted',
      untilReset: resetsAt,
    });
    expect(await restarted.canUse(WORK)).toBe(false);
    expect(await types(store)).toEqual(before);
  });

  it('settles a limit that ended while the daemon was down', async () => {
    const { service, store, clock, another } = setup();
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 5 * MIN });
    await service.stop();
    await clock.advance(30 * MIN);
    const restarted = another();
    await restarted.start();
    const restored = (await quotaEvents(store)).filter((e) => e.type === 'quota.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ profile: WORK, reason: 'reset' });
  });

  it('says quota.exhausted again when the end of the limit changes', async () => {
    const { service, store } = setup();
    await service.ingestLimitHit(WORK, { source: 'a', resetsAt: T0 + 5 * MIN });
    await service.ingestLimitHit(WORK, { source: 'b', resetsAt: T0 + 50 * MIN });
    const exhausted = (await quotaEvents(store)).filter((e) => e.type === 'quota.exhausted');
    expect(exhausted.map((e) => e.payload.untilReset)).toEqual([T0 + 5 * MIN, T0 + 50 * MIN]);
  });
});

describe('QuotaService, probes and delivery (quota.probe.delivery)', () => {
  it('both: reads at start, then on the timer, and watches', async () => {
    const { service, probe, clock } = setup({ delivery: 'both' });
    probe.readings.set(WORK, reading(20, 20, { resetsAt: T0 + 24 * 60 * MIN }));
    service.track(WORK);
    await service.start();
    await flush();
    expect(probe.reads).toEqual([WORK]);
    expect(probe.watched).toEqual([WORK]);
    expect((await service.statusOf(WORK)).state).toBe('ok');
    await clock.advance(5 * MIN);
    await flush();
    expect(probe.reads).toEqual([WORK, WORK]);
  });

  it('push: watches and never reads', async () => {
    const { service, probe, clock } = setup({ delivery: 'push' });
    service.track(WORK);
    await service.start();
    await clock.advance(30 * MIN);
    await flush();
    expect(probe.reads).toEqual([]);
    expect(probe.watched).toEqual([WORK]);
    probe.push(
      WORK,
      reading(30, 30, { observedAt: clock.now(), resetsAt: clock.now() + 60 * MIN }),
    );
    await flush();
    expect((await service.statusOf(WORK)).state).toBe('ok');
  });

  it('poll: reads and never watches', async () => {
    const { service, probe } = setup({ delivery: 'poll' });
    probe.readings.set(WORK, reading(90, 20));
    service.track(WORK);
    await service.start();
    await flush();
    expect(probe.watched).toEqual([]);
    expect(probe.reads).toEqual([WORK]);
    expect((await service.statusOf(WORK)).state).toBe('near_limit');
  });

  it('push with a probe that cannot watch falls silent instead of reading', async () => {
    const { service, probe } = setup({ delivery: 'push' });
    const mute = new SimProbe(['5h', '7d'], false);
    service.addProbe('claude-code', mute);
    service.track(WORK);
    await service.start();
    await flush();
    expect(mute.reads).toEqual([]);
    expect(probe.reads).toEqual([]);
    expect((await service.statusOf(WORK)).state).toBe('unknown');
  });

  it('both with a probe that cannot watch still polls', async () => {
    const { service } = setup({ delivery: 'both' });
    const mute = new SimProbe(['5h', '7d'], false);
    mute.readings.set(WORK, reading(10, 10, { resetsAt: T0 + 24 * 60 * MIN }));
    service.addProbe('claude-code', mute);
    service.track(WORK);
    await service.start();
    await flush();
    expect(mute.reads).toEqual([WORK]);
    expect((await service.statusOf(WORK)).state).toBe('ok');
  });

  it('leaves the state alone when a read fails, and the old reading just gets older', async () => {
    const { service, probe, store } = setup();
    await service.ingestReading(WORK, reading(40, 40));
    probe.failing = true;
    const status = await service.refresh(WORK);
    expect(status.state).toBe('ok');
    expect(await types(store)).toEqual(['quota.updated']);
  });

  it('stops watching when it stops', async () => {
    const { service, probe } = setup({ delivery: 'both' });
    service.track(WORK);
    await service.start();
    await flush();
    expect(probe.watching).toBe(1);
    await service.stop();
    expect(probe.watching).toBe(0);
  });

  it('writes the plan type the probe reports into the update event', async () => {
    const { service, store } = setup();
    await service.ingestReading(WORK, { ...reading(10, 10), planType: 'max' });
    const [updated] = await quotaEvents(store);
    expect(updated?.payload).toMatchObject({ profile: WORK, planType: 'max', source: 'probe' });
  });
});

describe('helpers', () => {
  it('reads a reset time as an ISO date, epoch seconds or epoch milliseconds', () => {
    expect(parseResetsAt(iso(T0))).toBe(T0);
    expect(parseResetsAt(String(Math.floor(T0 / 1000)))).toBe(Math.floor(T0 / 1000) * 1000);
    expect(parseResetsAt(T0)).toBe(T0);
    expect(parseResetsAt(undefined)).toBeNull();
    expect(parseResetsAt('')).toBeNull();
    expect(parseResetsAt('tomorrow-ish')).toBeNull();
    expect(parseResetsAt(-5)).toBeNull();
  });

  it('recognizes the shapes of a limit error', () => {
    expect(limitHitOf(new QuotaExhausted('x'))).toBeDefined();
    expect(limitHitOf({ kind: 'quota_exhausted', resetsAt: 5 })).toMatchObject({ resetsAt: 5 });
    expect(
      limitHitOf({ code: -32001, data: { type: 'QuotaExhausted', resetsAt: 'x' } }),
    ).toMatchObject({ resetsAt: 'x' });
    expect(limitHitOf({ code: -32001 })).toBeDefined();
    expect(limitHitOf('nope')).toBeUndefined();
    expect(limitHitOf({ code: 1 })).toBeUndefined();
  });
});

describe('QuotaService, what P9 builds on', () => {
  it('says budget.restored (not quota.restored) when a cap ends', async () => {
    const { service, store, clock } = setup();
    await service.start();
    await service.ingestLimitHit(WORK, { source: 'cap', cause: 'budget', resetsAt: T0 + 5 * MIN });
    await clock.advance(5 * MIN + 2000);
    await flush();
    const all = await store.events.readFrom(0, 1000);
    const restored = all.filter((e) => e.type === 'budget.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({
      profile: WORK,
      state: 'unknown',
      reason: 'reset',
    });
    expect(all.map((e) => e.type)).not.toContain('quota.restored');
  });

  it('tells the listeners about a change of state, and survives one that throws', async () => {
    const { service } = setup();
    const seen: string[] = [];
    service.onChange(() => {
      throw new Error('a listener broke');
    });
    const listening = service.onChange((change) => {
      seen.push(`${change.profile}:${change.before?.state ?? 'none'}>${change.status.state}`);
    });
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 5 * MIN });
    expect(seen).toEqual([`${WORK}:none>exhausted`]);
    listening.dispose();
    await service.ingestLimitHit(HOME, { source: 'test', resetsAt: T0 + 5 * MIN });
    expect(seen).toHaveLength(1);
  });

  it('lets go of a limit that has no end, as restored by recheck, and leaves one with an end alone', async () => {
    const { service, store } = setup();
    await service.ingestLimitHit(WORK, { source: 'test' });
    await service.ingestLimitHit(HOME, { source: 'test', resetsAt: T0 + 50 * MIN });
    expect((await service.releaseLimit(WORK, 'quota')).state).toBe('unknown');
    expect((await service.releaseLimit(HOME, 'quota')).state).toBe('exhausted');
    const restored = (await quotaEvents(store)).filter((e) => e.type === 'quota.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ profile: WORK, reason: 'recheck' });
  });
});
