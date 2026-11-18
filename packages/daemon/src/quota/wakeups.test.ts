// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  type AdapterImplements,
  type EventEnvelope,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { QuotaService } from './service.js';
import {
  WAKEUP_NEVER,
  WakeupManager,
  wakeupSettingsOf,
  type CostFreeProbe,
  type RestoreHookKind,
  type RestoredProfile,
} from './wakeups.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK = 'claude-code/work';
const HOME = 'claude-code/home';

/** The model the fake agent stands for: the recheck must never reach it. */
class FakeModel {
  calls = 0;
  prompt(): void {
    this.calls += 1;
  }
}

/** A probe that costs nothing: it reads what the test put there, and counts the reads. */
class FreeProbe implements QuotaProbe, CostFreeProbe {
  readonly id = 'free';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  readonly reads: string[] = [];
  readings = new Map<string, QuotaReading>();
  /** `unavailable` is a client with no signal; `broken` is a read that failed and may pass. */
  mode: 'ok' | 'unavailable' | 'broken' = 'unavailable';

  capabilities(): QuotaCapabilities {
    return { windows: ['5h', '7d'], delivery: 'poll', precision: 'exact' };
  }

  read(profile: ProfileRef): Promise<QuotaReading> {
    const id = `${profile.client}/${profile.profile}`;
    this.reads.push(id);
    if (this.mode === 'broken') return Promise.reject(new Error('the probe broke'));
    const reading = this.readings.get(id);
    if (this.mode === 'unavailable' || reading === undefined) {
      return Promise.reject(new AdapterUnavailable('no signal'));
    }
    return Promise.resolve(reading);
  }
}

const running: { service: QuotaService; manager: WakeupManager }[] = [];

interface SetupOptions {
  /** `quota.recheck_every` in ms; `null` is `off`. */
  recheckEvery?: number | null;
}

type Hooks = Record<RestoreHookKind, RestoredProfile[]>;

function setup(options: SetupOptions = {}): {
  clock: FakeClock;
  store: InMemoryStore;
  probe: FreeProbe;
  model: FakeModel;
  hooks: Hooks;
  boot: () => Promise<{ service: QuotaService; manager: WakeupManager }>;
} {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const probe = new FreeProbe();
  const model = new FakeModel();
  const hooks: Hooks = { awaiting_resume: [], queued_demands: [], scheduled_tasks: [] };
  const recheckEveryMs = options.recheckEvery === undefined ? 15 * MIN : options.recheckEvery;
  const boot = async (): Promise<{ service: QuotaService; manager: WakeupManager }> => {
    const logger = createSilentLogger();
    const service = new QuotaService({
      store,
      clock,
      settings: { nearLimitAt: 0.8, staleAfterMs: 10 * MIN, delivery: 'poll', pollEveryMs: HOUR },
      logger,
    });
    service.addProbe('claude-code', probe);
    const manager = new WakeupManager({
      store,
      clock,
      quota: service,
      settings: wakeupSettingsOf({ quota: { recheck_every: recheckEveryMs } } as never),
      logger,
      probes: (clientId) => (clientId === 'claude-code' ? probe : undefined),
    });
    for (const kind of Object.keys(hooks) as RestoreHookKind[]) {
      manager.setHook(kind, (restored) => {
        hooks[kind].push(restored);
      });
    }
    await service.start();
    await manager.start();
    running.push({ service, manager });
    return { service, manager };
  };
  return { clock, store, probe, model, hooks, boot };
}

afterEach(async () => {
  for (const { service, manager } of running.splice(0)) {
    await manager.stop();
    await service.stop();
  }
});

/** Lets the work that is already queued (reads, pushes, the loops) run to its next wait. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settle(manager: WakeupManager): Promise<void> {
  await flush();
  await manager.idle();
  await flush();
}

async function events(store: InMemoryStore): Promise<EventEnvelope[]> {
  const all = await store.events.readFrom(0, 1000);
  return all.filter((e) => e.type.startsWith('quota.') || e.type.startsWith('budget.'));
}

async function types(store: InMemoryStore): Promise<string[]> {
  return (await events(store)).map((e) => e.type);
}

const roomAt = (observedAt: number): QuotaReading => ({
  observedAt,
  windows: [
    { window: '5h', usedPercent: 10, resetsAt: observedAt + 120 * MIN },
    { window: '7d', usedPercent: 10, resetsAt: observedAt + 5000 * MIN },
  ],
});

describe('WakeupManager, the wakeup of an exhausted profile (architecture 5.6)', () => {
  it('writes a wakeup at the reset time when a profile is exhausted', async () => {
    const { store, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 90 * MIN });
    await settle(manager);
    const rows = await store.wakeups.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profileId: WORK,
      cause: 'quota',
      at: T0 + 90 * MIN,
      state: 'scheduled',
    });
  });

  it('does not duplicate the wakeup when the profile is exhausted twice in a row (unique key)', async () => {
    const { store, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'a', resetsAt: T0 + 90 * MIN });
    await settle(manager);
    await service.ingestLimitHit(WORK, { source: 'b', resetsAt: T0 + 90 * MIN });
    await settle(manager);
    expect(await store.wakeups.list({})).toHaveLength(1);
    // A hit with another end moves the one wakeup, it does not add another.
    await service.ingestLimitHit(WORK, { source: 'c', resetsAt: T0 + 120 * MIN });
    await settle(manager);
    // Two turns of the manager at once look at the same profile: still one.
    await Promise.all([manager.reconcile(WORK), manager.reconcile(WORK)]);
    const rows = await store.wakeups.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.at).toBe(T0 + 120 * MIN);
  });

  it('keeps one wakeup while a quota and a cap hold together, at the later end', async () => {
    const { store, clock, hooks, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'q', resetsAt: T0 + 60 * MIN });
    await service.ingestLimitHit(WORK, { source: 'b', cause: 'budget', resetsAt: T0 + 90 * MIN });
    await settle(manager);
    const rows = await store.wakeups.list({});
    expect(rows.map((r) => [r.cause, r.state, r.at])).toEqual([
      ['quota', 'scheduled', T0 + 90 * MIN],
    ]);
    await clock.advance(61 * MIN);
    await settle(manager);
    expect(hooks.awaiting_resume).toEqual([]);
    await clock.advance(30 * MIN);
    await settle(manager);
    expect(hooks.awaiting_resume).toHaveLength(1);
  });

  it('moves to the cap when a quota with no end is let go while the cap still holds', async () => {
    const { store, clock, hooks, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'q' });
    await service.ingestLimitHit(WORK, { source: 'b', cause: 'budget', resetsAt: T0 + 90 * MIN });
    await settle(manager);
    await clock.advance(16 * MIN);
    await settle(manager);
    // The recheck let the quota go; the profile is not back, the cap has not ended.
    expect(hooks.awaiting_resume).toEqual([]);
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    const rows = await store.wakeups.list({});
    expect(rows.map((r) => [r.cause, r.state])).toEqual([
      ['quota', 'cancelled'],
      ['budget', 'scheduled'],
    ]);
    expect(rows[1]?.at).toBe(T0 + 90 * MIN);
    await clock.advance(80 * MIN);
    await settle(manager);
    expect(hooks.awaiting_resume).toHaveLength(1);
    expect(hooks.awaiting_resume[0]?.causes).toEqual(['budget']);
  });

  it('on time returns the profile to ok, says quota.restored and calls the three hooks once', async () => {
    const { store, clock, probe, hooks, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 5 * MIN });
    await settle(manager);
    // The probe that costs nothing sees room after the reset.
    probe.mode = 'ok';
    probe.readings.set(WORK, roomAt(T0 + 5 * MIN));
    await clock.advance(5 * MIN + 2000);
    await settle(manager);
    expect((await service.statusOf(WORK)).state).toBe('ok');
    const restored = (await events(store)).filter((e) => e.type === 'quota.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ profile: WORK, cause: 'quota', reason: 'reset' });
    for (const kind of ['awaiting_resume', 'queued_demands', 'scheduled_tasks'] as const) {
      expect(hooks[kind]).toHaveLength(1);
      expect(hooks[kind][0]).toMatchObject({ profile: WORK, causes: ['quota'], state: 'ok' });
    }
    const [row] = await store.wakeups.list({});
    expect(row?.state).toBe('fired');
  });

  it('says budget.restored, and not quota.restored, when the cap ends', async () => {
    const { store, clock, probe, hooks, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'cap', cause: 'budget', resetsAt: T0 + 5 * MIN });
    await settle(manager);
    probe.mode = 'ok';
    probe.readings.set(WORK, roomAt(T0 + 5 * MIN));
    await clock.advance(5 * MIN + 2000);
    await settle(manager);
    const all = await types(store);
    expect(all).toContain('budget.restored');
    expect(all).not.toContain('quota.restored');
    const restored = (await events(store)).find((e) => e.type === 'budget.restored');
    // The event says how it stood at the reset: nobody had read it yet.
    expect(restored?.payload).toMatchObject({ profile: WORK, state: 'unknown', reason: 'reset' });
    expect(hooks.queued_demands[0]?.state).toBe('ok');
    expect(hooks.queued_demands).toHaveLength(1);
    expect(hooks.queued_demands[0]?.causes).toEqual(['budget']);
  });

  it('leaves the profile unknown when the reset came and nothing that costs nothing has read it', async () => {
    const { clock, hooks, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 5 * MIN });
    await settle(manager);
    await clock.advance(5 * MIN + 2000);
    await settle(manager);
    expect((await service.statusOf(WORK)).state).toBe('unknown');
    // The attempts that waited still wake: the next session is the test.
    expect(hooks.awaiting_resume).toHaveLength(1);
    expect(hooks.awaiting_resume[0]?.state).toBe('unknown');
  });

  it('keeps the other hooks running when one fails, and still closes the wakeup', async () => {
    const { store, clock, hooks, boot } = setup();
    const { service, manager } = await boot();
    manager.setHook('awaiting_resume', () => {
      throw new Error('the hook broke');
    });
    await service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 5 * MIN });
    await settle(manager);
    await clock.advance(5 * MIN + 2000);
    await settle(manager);
    expect(hooks.queued_demands).toHaveLength(1);
    expect(hooks.scheduled_tasks).toHaveLength(1);
    expect((await store.wakeups.list({}))[0]?.state).toBe('fired');
  });

  it('does not touch the wakeup of another profile', async () => {
    const { store, clock, hooks, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 't', resetsAt: T0 + 5 * MIN });
    await service.ingestLimitHit(HOME, { source: 't', resetsAt: T0 + 50 * MIN });
    await settle(manager);
    await clock.advance(6 * MIN);
    await settle(manager);
    expect(hooks.awaiting_resume.map((r) => r.profile)).toEqual([WORK]);
    const rows = await store.wakeups.list({ states: ['scheduled'] });
    expect(rows.map((r) => r.profileId)).toEqual([HOME]);
  });
});

describe('WakeupManager, restart (architecture 5.21)', () => {
  it('keeps the wakeup when the daemon restarts before the time', async () => {
    const { store, clock, hooks, boot } = setup();
    const first = await boot();
    await first.service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 30 * MIN });
    await settle(first.manager);
    await first.manager.stop();
    await first.service.stop();
    await clock.advance(10 * MIN);
    const second = await boot();
    await settle(second.manager);
    const rows = await store.wakeups.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ at: T0 + 30 * MIN, state: 'scheduled' });
    expect(hooks.awaiting_resume).toEqual([]);
    // And it still comes due, at its time, in the new life.
    await clock.advance(21 * MIN);
    await settle(second.manager);
    expect(hooks.awaiting_resume).toHaveLength(1);
    expect((await store.wakeups.list({}))[0]?.state).toBe('fired');
  });

  it('runs at start-up a wakeup that came due while the daemon was stopped', async () => {
    const { store, clock, probe, hooks, boot } = setup();
    const first = await boot();
    await first.service.ingestLimitHit(WORK, { source: 'test', resetsAt: T0 + 5 * MIN });
    await settle(first.manager);
    await first.manager.stop();
    await first.service.stop();
    await clock.advance(3 * HOUR);
    probe.mode = 'ok';
    probe.readings.set(WORK, roomAt(clock.now()));
    const second = await boot();
    await settle(second.manager);
    expect(hooks.awaiting_resume).toHaveLength(1);
    expect(hooks.awaiting_resume[0]).toMatchObject({ profile: WORK, state: 'ok' });
    expect((await store.wakeups.list({}))[0]?.state).toBe('fired');
    expect((await second.service.statusOf(WORK)).state).toBe('ok');
    const restored = (await events(store)).filter((e) => e.type === 'quota.restored');
    expect(restored).toHaveLength(1);
  });

  it('writes the wakeup at start-up when the last daemon died before writing it', async () => {
    const { store, clock, boot } = setup();
    // The hit is in the store, the wakeup is not.
    await store.quotaSnapshots.put({
      profileId: WORK,
      window: 'limit_hit',
      usedPercent: 100,
      resetsAt: T0 + 40 * MIN,
      source: 'test',
      observedAt: clock.now(),
    });
    const { manager } = await boot();
    await settle(manager);
    const rows = await store.wakeups.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profileId: WORK, at: T0 + 40 * MIN });
  });
});

describe('WakeupManager, the recheck that never calls the model (quota.recheck_every)', () => {
  it('lets a profile with no signal that costs nothing go from exhausted to unknown after the interval', async () => {
    const { store, clock, model, probe, hooks, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test' });
    await settle(manager);
    const [row] = await store.wakeups.list({});
    expect(row?.at).toBe(T0 + 15 * MIN);
    await clock.advance(14 * MIN);
    await settle(manager);
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    expect(probe.reads).toEqual([]);
    await clock.advance(2 * MIN);
    await settle(manager);
    expect((await service.statusOf(WORK)).state).toBe('unknown');
    const restored = (await events(store)).filter((e) => e.type === 'quota.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({
      profile: WORK,
      cause: 'quota',
      state: 'unknown',
      reason: 'recheck',
    });
    expect(hooks.awaiting_resume).toHaveLength(1);
    expect(model.calls).toBe(0);
  });

  it('settles the profile with the reading of a probe that costs nothing, and the model is never called', async () => {
    const { store, clock, model, probe, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test' });
    await settle(manager);
    probe.mode = 'ok';
    await clock.advance(14 * MIN);
    probe.readings.set(WORK, roomAt(clock.now()));
    await clock.advance(2 * MIN);
    await settle(manager);
    expect((await service.statusOf(WORK)).state).toBe('ok');
    expect(probe.reads.length).toBeGreaterThan(0);
    const restored = (await events(store)).filter((e) => e.type === 'quota.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ state: 'ok', reason: 'reading' });
    expect(model.calls).toBe(0);
  });

  it('tries again later when the probe only failed, without letting the profile go', async () => {
    const { store, clock, probe, boot } = setup();
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test' });
    await settle(manager);
    probe.mode = 'broken';
    await clock.advance(16 * MIN);
    await settle(manager);
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    const [row] = await store.wakeups.list({ states: ['scheduled'] });
    expect(row?.at).toBeGreaterThan(clock.now());
    expect(row?.at).not.toBe(WAKEUP_NEVER);
  });

  it('does not query anything when recheck_every is off, and the wakeup never comes due', async () => {
    const { store, clock, model, probe, hooks, boot } = setup({ recheckEvery: null });
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test' });
    await settle(manager);
    const [row] = await store.wakeups.list({});
    expect(row?.at).toBe(WAKEUP_NEVER);
    await clock.advance(48 * HOUR);
    await settle(manager);
    expect(probe.reads).toEqual([]);
    expect(model.calls).toBe(0);
    expect((await service.statusOf(WORK)).state).toBe('exhausted');
    expect(hooks.awaiting_resume).toEqual([]);
    // A fresh reading with room still settles it, as it always did.
    await service.ingestReading(WORK, roomAt(clock.now()), 'probe');
    await settle(manager);
    expect((await service.statusOf(WORK)).state).toBe('ok');
    expect(hooks.awaiting_resume).toHaveLength(1);
  });

  it('gives the wakeup a time when a later hit brings the end of the limit', async () => {
    const { store, clock, boot } = setup({ recheckEvery: null });
    const { service, manager } = await boot();
    await service.ingestLimitHit(WORK, { source: 'test' });
    await settle(manager);
    expect((await store.wakeups.list({}))[0]?.at).toBe(WAKEUP_NEVER);
    await service.ingestLimitHit(WORK, { source: 'again', resetsAt: clock.now() + 30 * MIN });
    await settle(manager);
    const rows = await store.wakeups.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.at).toBe(clock.now() + 30 * MIN);
  });
});
