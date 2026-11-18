// SPDX-License-Identifier: MPL-2.0
import { Cancelled, InvalidInput } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeMemoryProbe,
  FakeProcessLauncher,
  FakeSessionTransport,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { Semaphore } from '../tools/semaphore.js';
import {
  ALWAYS_ADMIT,
  DEFAULT_ADMISSION,
  defaultSessionMb,
  localInstanceOf,
  reservedSlots,
  slotFree,
  type AdmissionSettings,
  type CanAdmit,
  type LocalInstance,
} from './admission.js';
import { SessionPool, type PoolRequest } from './pool.js';
import { executionSettingsOf, type PoolSettings } from './settings.js';

const OTHER_PROFILE = { ...TEST_PROFILE, profile: 'two', id: 'fake/two' };

/** Lets the async rounds of the admission (RAM read, quota, scan) run to their end. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface SetupOptions {
  admission?: Partial<AdmissionSettings>;
  /** `pool.fake.session_mb`. */
  sessionMb?: number | 'auto';
  max?: number;
  shared?: boolean;
  ram?: number | undefined;
  withoutProbe?: boolean;
  canAdmit?: CanAdmit;
  local?: Readonly<Record<string, LocalInstance>>;
  directorProfiles?: readonly string[];
}

function setup(options: SetupOptions = {}) {
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const clock = new FakeClock();
  const memory = new FakeMemoryProbe('ram' in options ? options.ram : 10_000);
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: [] },
    processModel: options.shared === true ? 'multi-session' : 'process-per-session',
  });
  const settings: PoolSettings = {
    sessionsPerProcess: 4,
    maxSessions: options.max ?? 10,
    idleMs: 60_000,
    sharedCancel: 'escalate',
    ...(options.admission === undefined
      ? {}
      : { admission: { ...DEFAULT_ADMISSION, ...options.admission } }),
    ...(options.sessionMb === undefined ? {} : { sessionMbByClient: { fake: options.sessionMb } }),
    ...(options.directorProfiles === undefined
      ? {}
      : { directorProfiles: options.directorProfiles }),
  };
  const local = options.local;
  const pool = new SessionPool({
    clients: [adapter],
    launcher,
    transport: () => transport,
    clock,
    settings,
    ...(options.withoutProbe === true ? {} : { memory }),
    ...(options.canAdmit === undefined ? {} : { canAdmit: options.canAdmit }),
    ...(local === undefined ? {} : { localInstance: (profile) => local[profile.id] }),
  });
  const request = (extra: Partial<PoolRequest> = {}): PoolRequest => ({
    client: 'fake',
    profile: TEST_PROFILE,
    policy: TEST_POLICY,
    cwd: '/work/one',
    ...extra,
  });
  return { launcher, transport, clock, memory, pool, request };
}

describe('admission helpers', () => {
  it('defaults to the behaviour from before P4', () => {
    expect(DEFAULT_ADMISSION.mode).toBe('slots');
  });

  it('takes the cost of a session from the N74 measurement, and 512 for an unknown client', () => {
    expect(defaultSessionMb('claude-code')).toBe(320);
    expect(defaultSessionMb('codex')).toBe(150);
    expect(defaultSessionMb('opencode')).toBe(520);
    expect(defaultSessionMb('other')).toBe(512);
  });

  it('reads slots: auto from the server, and 1 when it did not say', () => {
    const base = { reserve_for_director: 1, reserve_when: 'listed' } as const;
    expect(localInstanceOf({ ...base, slots: 3 }, 8).slots).toBe(3);
    expect(localInstanceOf({ ...base, slots: 'auto' }, 4).slots).toBe(4);
    expect(localInstanceOf({ ...base, slots: 'auto' }, undefined).slots).toBe(1);
  });

  it('reserves slots by reserve_when, never more than the instance has', () => {
    const instance = (reserveWhen: LocalInstance['reserveWhen'], reserve: number | 'all') =>
      ({ slots: 2, reserveForDirector: reserve, reserveWhen }) satisfies LocalInstance;
    expect(reservedSlots(instance('always', 1), false)).toBe(1);
    expect(reservedSlots(instance('never', 1), true)).toBe(0);
    expect(reservedSlots(instance('listed', 1), true)).toBe(1);
    expect(reservedSlots(instance('listed', 1), false)).toBe(0);
    expect(reservedSlots(instance('always', 'all'), false)).toBe(2);
    expect(reservedSlots(instance('always', 5), false)).toBe(2);
    expect(reservedSlots(instance('always', 0), false)).toBe(0);
  });

  it('gives the Director any free slot, and an Actor only the unreserved ones', () => {
    const instance: LocalInstance = { slots: 2, reserveForDirector: 1, reserveWhen: 'always' };
    expect(slotFree(instance, { directors: 0, actors: 0 }, false, false)).toBe(true);
    expect(slotFree(instance, { directors: 0, actors: 1 }, false, false)).toBe(false);
    expect(slotFree(instance, { directors: 0, actors: 1 }, true, false)).toBe(true);
    expect(slotFree(instance, { directors: 1, actors: 1 }, true, false)).toBe(false);
  });

  it('always says yes to the quota until P15 wires the QuotaService', async () => {
    expect(await ALWAYS_ADMIT(TEST_PROFILE)).toBe(true);
  });
});

describe('SessionPool admission, mode slots', () => {
  it('keeps today behaviour: the RAM is never read and a low value does not block', async () => {
    const { pool, memory, request } = setup({ ram: 1 });
    const lease = await pool.acquire(request());
    expect(memory.reads).toBe(0);
    await lease.release();
  });

  it('works with no MemoryProbe at all', async () => {
    const { pool, request } = setup({ withoutProbe: true, max: 1 });
    const first = await pool.acquire(request());
    const second = pool.acquire(request());
    await Promise.resolve();
    expect(pool.stats().queued).toBe(1);
    await first.release();
    await (await second).release();
  });

  it('serves a queue in the same turn, as before', async () => {
    const { pool, request } = setup({ max: 1, admission: { mode: 'slots' } });
    const first = await pool.acquire(request());
    const second = pool.acquire(request());
    await Promise.resolve();
    expect(pool.stats().queued).toBe(1);
    await first.release();
    expect(pool.stats().queued).toBe(0);
    await (await second).release();
  });

  it('refuses a mode that reads the RAM without a MemoryProbe', () => {
    expect(() => setup({ admission: { mode: 'ram' }, withoutProbe: true })).toThrow(InvalidInput);
  });
});

describe('SessionPool admission, mode ram', () => {
  const ram = { mode: 'ram', minFreeMb: 1000, recheckMs: 5000 } as const;

  it('waits, with no error, while the RAM is below the minimum, and enters when it rises', async () => {
    const { pool, memory, request } = setup({ admission: ram, sessionMb: 400, ram: 1200 });
    let admitted = false;
    const waiting = pool.acquire(request()).then((lease) => {
      admitted = true;
      return lease;
    });
    await settle();
    expect(admitted).toBe(false);
    expect(pool.stats()).toEqual({ processes: 0, sessions: 0, queued: 1 });
    memory.set(1400);
    pool.wake();
    await settle();
    expect(admitted).toBe(true);
    await (await waiting).release();
  });

  it('looks again by itself every pool.admission.recheck', async () => {
    const { pool, memory, clock, request } = setup({ admission: ram, sessionMb: 400, ram: 500 });
    const waiting = pool.acquire(request());
    await settle();
    expect(pool.stats().queued).toBe(1);
    memory.set(5000);
    await clock.advance(5000);
    await settle();
    expect(pool.stats().queued).toBe(0);
    await (await waiting).release();
  });

  it('stops looking when nobody waits and when the pool shuts down', async () => {
    const { pool, clock, request } = setup({ admission: ram, sessionMb: 400, ram: 500 });
    void pool.acquire(request()).catch(() => undefined);
    await settle();
    expect(clock.pendingSleeps).toBe(1);
    await pool.shutdown();
    expect(clock.pendingSleeps).toBe(0);
  });

  it('counts the RAM of a session still opening, so a burst does not overbook', async () => {
    const { pool, request } = setup({ admission: ram, sessionMb: 400, ram: 1900 });
    const leases = [pool.acquire(request()), pool.acquire(request()), pool.acquire(request())];
    await settle();
    // 900 MB above the minimum: two sessions of 400 MB fit, the third does not.
    expect(pool.stats().queued).toBe(1);
    const open = await Promise.all(leases.slice(0, 2));
    await Promise.all(open.map((lease) => lease.release()));
    await settle();
    expect(pool.stats().queued).toBe(0);
    const [, , third] = leases;
    if (third === undefined) throw new Error('no third lease');
    await (await third).release();
  });

  it('does not let a small session behind pass a big one waiting for RAM', async () => {
    const { pool, memory, request } = setup({ admission: ram, sessionMb: 400, ram: 1100 });
    const order: string[] = [];
    const big = pool.acquire(request()).then((lease) => (order.push('first'), lease));
    const next = pool.acquire(request()).then((lease) => (order.push('second'), lease));
    await settle();
    expect(order).toEqual([]);
    memory.set(1500);
    pool.wake();
    await settle();
    expect(order).toEqual(['first']);
    memory.set(5000);
    pool.wake();
    await settle();
    expect(order).toEqual(['first', 'second']);
    await (await big).release();
    await (await next).release();
  });

  it('still honours pool.max_sessions', async () => {
    const { pool, request } = setup({ admission: ram, ram: 100_000, max: 1 });
    const first = await pool.acquire(request());
    const second = pool.acquire(request());
    await settle();
    expect(pool.stats().queued).toBe(1);
    await first.release();
    await settle();
    await (await second).release();
  });

  it('leaves the queue when the wait is aborted', async () => {
    const { pool, request } = setup({ admission: ram, sessionMb: 400, ram: 0 });
    const controller = new AbortController();
    const waiting = pool.acquire(request({ signal: controller.signal }));
    await settle();
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(Cancelled);
    expect(pool.stats().queued).toBe(0);
  });

  it('admits when the probe cannot tell (unknown_ram: admit), and waits with wait', async () => {
    const open = setup({ admission: { ...ram, unknownRam: 'admit' }, ram: undefined });
    await (await open.pool.acquire(open.request())).release();
    const closed = setup({ admission: { ...ram, unknownRam: 'wait' }, ram: undefined });
    const waiting = closed.pool.acquire(closed.request());
    await settle();
    expect(closed.pool.stats().queued).toBe(1);
    closed.memory.set(5000);
    closed.pool.wake();
    await settle();
    await (await waiting).release();
  });

  it('gives the RAM back to the count when the open fails', async () => {
    const { pool, transport, request } = setup({ admission: ram, sessionMb: 400, ram: 1500 });
    transport.failWith = new Error('boom');
    await expect(pool.acquire(request())).rejects.toThrow(/could not be opened/);
    transport.failWith = undefined;
    // Nothing stays reserved: the next session of 400 MB fits again.
    await (await pool.acquire(request())).release();
    expect(pool.stats().sessions).toBe(0);
  });

  it('uses the default cost of a client without session_mb (512 MB for an unknown one)', async () => {
    // 512 MB is the cost of an unknown client: 1000 + 512 does not fit in 1400.
    const { pool, request } = setup({ admission: ram, ram: 1400 });
    const waiting = pool.acquire(request());
    await settle();
    expect(pool.stats().queued).toBe(1);
    void waiting.catch(() => undefined);
    await pool.shutdown();
  });

  it('learns the cost from the process tree with session_mb: auto', async () => {
    const { pool, memory, launcher, request } = setup({
      admission: ram,
      sessionMb: 'auto',
      shared: true,
      ram: 100_000,
    });
    const first = await pool.acquire(request());
    const pid = launcher.launched[0]?.pid ?? 0;
    memory.setTree(pid, 2400);
    const second = await pool.acquire(request());
    await settle();
    // Two sessions share the process of 2400 MB: 1200 MB each from now on.
    memory.set(1000 + 1100);
    const third = pool.acquire(request());
    await settle();
    expect(pool.stats().queued).toBe(1);
    memory.set(1000 + 1300);
    pool.wake();
    await settle();
    expect(pool.stats().queued).toBe(0);
    await first.release();
    await second.release();
    await (await third).release();
  });
});

describe('SessionPool admission, local instance slots', () => {
  const instance: LocalInstance = { slots: 2, reserveForDirector: 0, reserveWhen: 'listed' };

  it('makes the 3rd session of a profile with slots: 2 wait', async () => {
    const { pool, request } = setup({ local: { [TEST_PROFILE.id]: instance } });
    const a = await pool.acquire(request());
    const b = await pool.acquire(request());
    let admitted = false;
    const third = pool.acquire(request()).then((lease) => {
      admitted = true;
      return lease;
    });
    await settle();
    expect(admitted).toBe(false);
    expect(pool.stats()).toMatchObject({ sessions: 2, queued: 1 });
    await a.release();
    await settle();
    expect(admitted).toBe(true);
    await b.release();
    await (await third).release();
  });

  it('does not hold another profile back behind a profile that is full', async () => {
    const { pool, request } = setup({
      local: { [TEST_PROFILE.id]: { ...instance, slots: 1 } },
    });
    const first = await pool.acquire(request());
    const blocked = pool.acquire(request());
    const other = await pool.acquire(request({ profile: OTHER_PROFILE }));
    expect(pool.stats()).toMatchObject({ sessions: 2, queued: 1 });
    await first.release();
    await (await blocked).release();
    await other.release();
  });

  it('also applies in mode ram', async () => {
    const { pool, request } = setup({
      admission: { mode: 'ram', minFreeMb: 0 },
      ram: 100_000,
      local: { [TEST_PROFILE.id]: { ...instance, slots: 1 } },
    });
    const first = await pool.acquire(request());
    const second = pool.acquire(request());
    await settle();
    expect(pool.stats().queued).toBe(1);
    await first.release();
    await settle();
    await (await second).release();
  });

  it('keeps a slot for the Director: an Actor does not get it', async () => {
    const reserved: LocalInstance = { slots: 2, reserveForDirector: 1, reserveWhen: 'always' };
    const { pool, request } = setup({ local: { [TEST_PROFILE.id]: reserved } });
    const actor = await pool.acquire(request());
    let second = false;
    const secondActor = pool.acquire(request()).then((lease) => {
      second = true;
      return lease;
    });
    await settle();
    expect(second).toBe(false);
    // The Director takes the reserved slot while the second Actor waits.
    const director = await pool.acquire(request({ director: true }));
    expect(second).toBe(false);
    await director.release();
    await settle();
    // Free again, and still reserved: the Actor keeps waiting until its own session ends.
    expect(second).toBe(false);
    await actor.release();
    await settle();
    expect(second).toBe(true);
    await (await secondActor).release();
  });

  it('reserves nothing with reserve_when: never, and only listed profiles with listed', async () => {
    const never = setup({
      local: { [TEST_PROFILE.id]: { slots: 2, reserveForDirector: 1, reserveWhen: 'never' } },
    });
    const a = await never.pool.acquire(never.request());
    const b = await never.pool.acquire(never.request());
    expect(never.pool.stats().sessions).toBe(2);
    await a.release();
    await b.release();

    const listed: LocalInstance = { slots: 2, reserveForDirector: 1, reserveWhen: 'listed' };
    const notListed = setup({ local: { [TEST_PROFILE.id]: listed }, directorProfiles: [] });
    const c = await notListed.pool.acquire(notListed.request());
    const d = await notListed.pool.acquire(notListed.request());
    expect(notListed.pool.stats().sessions).toBe(2);
    await c.release();
    await d.release();

    const inList = setup({
      local: { [TEST_PROFILE.id]: listed },
      directorProfiles: [TEST_PROFILE.id],
    });
    const e = await inList.pool.acquire(inList.request());
    void inList.pool.acquire(inList.request()).catch(() => undefined);
    await settle();
    expect(inList.pool.stats()).toMatchObject({ sessions: 1, queued: 1 });
    await e.release();
    await inList.pool.shutdown();
  });

  it('reserve_for_director: all leaves nothing to an Actor', async () => {
    const all: LocalInstance = { slots: 2, reserveForDirector: 'all', reserveWhen: 'always' };
    const { pool, request } = setup({ local: { [TEST_PROFILE.id]: all } });
    void pool.acquire(request()).catch(() => undefined);
    await settle();
    expect(pool.stats()).toMatchObject({ sessions: 0, queued: 1 });
    const director = await pool.acquire(request({ director: true }));
    await director.release();
    await pool.shutdown();
  });
});

describe('SessionPool admission, mode ram_and_quota', () => {
  const both = { mode: 'ram_and_quota', minFreeMb: 0, recheckMs: 5000 } as const;

  it('refuses while the quota hook says exhausted, and admits when it says yes', async () => {
    let exhausted = true;
    const { pool, request } = setup({
      admission: both,
      sessionMb: 100,
      canAdmit: () => !exhausted,
    });
    let admitted = false;
    const waiting = pool.acquire(request()).then((lease) => {
      admitted = true;
      return lease;
    });
    await settle();
    expect(admitted).toBe(false);
    expect(pool.stats().queued).toBe(1);
    exhausted = false;
    pool.wake();
    await settle();
    expect(admitted).toBe(true);
    await (await waiting).release();
  });

  it('asks again at the recheck when the quota comes back by itself', async () => {
    let exhausted = true;
    const { pool, clock, request } = setup({
      admission: both,
      canAdmit: () => Promise.resolve(!exhausted),
    });
    const waiting = pool.acquire(request());
    await settle();
    exhausted = false;
    await clock.advance(5000);
    await settle();
    expect(pool.stats().queued).toBe(0);
    await (await waiting).release();
  });

  it('holds only the profile whose quota is exhausted', async () => {
    const { pool, request } = setup({
      admission: both,
      canAdmit: (profile) => profile.id !== TEST_PROFILE.id,
    });
    void pool.acquire(request()).catch(() => undefined);
    const other = await pool.acquire(request({ profile: OTHER_PROFILE }));
    expect(pool.stats()).toMatchObject({ sessions: 1, queued: 1 });
    await other.release();
    await pool.shutdown();
  });

  it('treats a hook that throws as a no, with no error for the session', async () => {
    const { pool, request } = setup({
      admission: both,
      canAdmit: () => {
        throw new Error('quota down');
      },
    });
    void pool.acquire(request()).catch(() => undefined);
    await settle();
    expect(pool.stats().queued).toBe(1);
    await pool.shutdown();
  });

  it('asks the quota once per profile per round', async () => {
    let calls = 0;
    const { pool, request } = setup({
      admission: both,
      canAdmit: () => {
        calls += 1;
        return false;
      },
    });
    for (let i = 0; i < 3; i += 1) void pool.acquire(request()).catch(() => undefined);
    await settle();
    expect(calls).toBeGreaterThanOrEqual(1);
    const afterFirst = calls;
    await settle();
    expect(calls).toBe(afterFirst);
    await pool.shutdown();
  });

  it('is not asked in mode ram', async () => {
    let calls = 0;
    const { pool, request } = setup({
      admission: { mode: 'ram', minFreeMb: 0 },
      canAdmit: () => {
        calls += 1;
        return false;
      },
    });
    await (await pool.acquire(request())).release();
    expect(calls).toBe(0);
  });

  it('admits by default: the hook is always yes until P15', async () => {
    const { pool, request } = setup({ admission: both });
    await (await pool.acquire(request())).release();
  });
});

describe('executionSettingsOf, admission', () => {
  it('carries pool.admission and session_mb to the pool in the units the pool uses', () => {
    const settings = executionSettingsOf(
      parseConfig(
        'pool:\n  admission:\n    mode: ram\n    min_free_mb: 3000\n    recheck: 2s\n  codex:\n    session_mb: auto\n',
      ),
    ).pool;
    expect(settings.admission).toEqual({
      mode: 'ram',
      minFreeMb: 3000,
      recheckMs: 2000,
      unknownRam: 'admit',
    });
    expect(settings.sessionMbByClient).toEqual({
      'claude-code': 320,
      codex: 'auto',
      opencode: 520,
    });
  });
});

describe('admission and the heavy-commands semaphore', () => {
  it('keep two queues: a full pool does not hold a heavy command, and the other way round', async () => {
    const { pool, request } = setup({ admission: { mode: 'ram', minFreeMb: 0 }, ram: 0 });
    const heavy = new Semaphore(1);
    void pool.acquire(request()).catch(() => undefined);
    await settle();
    expect(pool.stats().queued).toBe(1);
    // A session waiting for RAM does not take a permit, and a permit does not take a session.
    const release = await heavy.acquire();
    expect(heavy.active).toBe(1);
    expect(heavy.waiting).toBe(0);
    expect(pool.stats().queued).toBe(1);
    release();
    await pool.shutdown();
  });
});
