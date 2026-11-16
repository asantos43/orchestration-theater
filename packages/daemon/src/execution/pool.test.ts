// SPDX-License-Identifier: MPL-2.0
import { Cancelled } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { SessionPool } from './pool.js';

const OTHER_PROFILE = { ...TEST_PROFILE, profile: 'two', id: 'fake/two' };

function setup(options: { shared: boolean; k?: number; max?: number; idleMs?: number }) {
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const clock = new FakeClock();
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: [] },
    processModel: options.shared ? 'multi-session' : 'process-per-session',
  });
  const pool = new SessionPool({
    clients: [adapter],
    launcher,
    transport: () => transport,
    clock,
    settings: {
      sessionsPerProcess: options.k ?? 2,
      maxSessions: options.max ?? 10,
      idleMs: options.idleMs ?? 60_000,
    },
  });
  const request = (profile = TEST_PROFILE, extra: { resumeSessionId?: string } = {}) => ({
    client: 'fake',
    profile,
    policy: TEST_POLICY,
    cwd: '/work/one',
    ...extra,
  });
  return { launcher, transport, clock, adapter, pool, request };
}

describe('SessionPool, process per session', () => {
  it('starts one process per session and ends it on release', async () => {
    const { pool, launcher, request } = setup({ shared: false });
    const a = await pool.acquire(request());
    const b = await pool.acquire(request());
    expect(launcher.launched).toHaveLength(2);
    expect(pool.stats().sessions).toBe(2);
    await a.release();
    await b.release();
    expect(launcher.running).toHaveLength(0);
    expect(pool.stats().sessions).toBe(0);
  });

  it('queues the sessions above max_sessions, first in first out', async () => {
    const { pool, launcher, request } = setup({ shared: false, max: 1 });
    const first = await pool.acquire(request());
    const order: string[] = [];
    const second = pool.acquire(request()).then((lease) => {
      order.push('second');
      return lease;
    });
    const third = pool.acquire(request()).then((lease) => {
      order.push('third');
      return lease;
    });
    await Promise.resolve();
    expect(pool.stats().queued).toBe(2);
    expect(launcher.launched).toHaveLength(1);
    await first.release();
    const secondLease = await second;
    expect(order).toEqual(['second']);
    await secondLease.release();
    await (await third).release();
    expect(order).toEqual(['second', 'third']);
    expect(pool.stats()).toEqual({ processes: 0, sessions: 0, queued: 0 });
  });

  it('gives the slot back when the open fails', async () => {
    const { pool, transport, request } = setup({ shared: false, max: 1 });
    transport.failWith = new Error('boom');
    await expect(pool.acquire(request())).rejects.toThrow(/could not be opened/);
    expect(pool.stats().sessions).toBe(0);
    transport.failWith = undefined;
    await (await pool.acquire(request())).release();
  });

  it('leaves the queue when the wait is aborted', async () => {
    const { pool, request } = setup({ shared: false, max: 1 });
    const first = await pool.acquire(request());
    const controller = new AbortController();
    const waiting = pool.acquire({ ...request(), signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(Cancelled);
    expect(pool.stats().queued).toBe(0);
    await first.release();
    expect(pool.stats().sessions).toBe(0);
  });

  it('reloads a conversation with session/load', async () => {
    const { pool, transport, request } = setup({ shared: false });
    const first = await pool.acquire(request());
    const id = first.session.sessionId;
    await first.release();
    const again = await pool.acquire(request(TEST_PROFILE, { resumeSessionId: id }));
    expect(again.session.sessionId).toBe(id);
    expect(transport.loaded).toHaveLength(1);
    await again.release();
  });

  it('refuses a client it does not know', async () => {
    const { pool, request } = setup({ shared: false });
    await expect(pool.acquire({ ...request(), client: 'nope' })).rejects.toThrow(
      /no client adapter/,
    );
  });
});

describe('SessionPool, shared process', () => {
  it('puts up to K sessions on one process and opens another above that', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 2 });
    const leases = [];
    for (let i = 0; i < 3; i += 1) leases.push(await pool.acquire(request()));
    expect(launcher.launched).toHaveLength(2);
    expect(leases[0]?.pid).toBe(leases[1]?.pid);
    expect(leases[2]?.pid).not.toBe(leases[0]?.pid);
    expect(leases.every((lease) => lease.shared)).toBe(true);
    for (const lease of leases) await lease.release();
  });

  it('keeps one process per profile', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 4 });
    const a = await pool.acquire(request(TEST_PROFILE));
    const b = await pool.acquire(request(OTHER_PROFILE));
    expect(launcher.launched).toHaveLength(2);
    await a.release();
    await b.release();
  });

  it('keeps the process alive when one session closes, and closes it after idleMs', async () => {
    const { pool, launcher, clock, request } = setup({ shared: true, k: 2, idleMs: 5_000 });
    const a = await pool.acquire(request());
    const b = await pool.acquire(request());
    await a.release();
    await clock.advance(10_000);
    expect(launcher.running).toHaveLength(1);
    await b.release();
    await clock.advance(4_999);
    expect(launcher.running).toHaveLength(1);
    await clock.advance(1);
    expect(launcher.running).toHaveLength(0);
    expect(pool.stats().processes).toBe(0);
  });

  it('reuses an idle process that has not timed out yet and cancels its timer', async () => {
    const { pool, launcher, clock, request } = setup({ shared: true, k: 2, idleMs: 5_000 });
    const a = await pool.acquire(request());
    await a.release();
    await clock.advance(3_000);
    const b = await pool.acquire(request());
    expect(launcher.launched).toHaveLength(1);
    await clock.advance(60_000);
    expect(launcher.running).toHaveLength(1);
    await b.release();
  });

  it('kills a stuck process and the sessions on it lose their connection', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 2 });
    const a = await pool.acquire(request());
    const b = await pool.acquire(request());
    const hung = b.session.prompt([{ type: 'text', text: '#script:hang\n' }]);
    await Promise.resolve();
    const report = await a.kill();
    expect(report.found).toBe(1);
    await expect(hung).rejects.toThrow(/closed|connection|unavailable/i);
    expect(launcher.running).toHaveLength(0);
    // The next session gets a new process.
    const c = await pool.acquire(request());
    expect(launcher.launched).toHaveLength(2);
    await a.release();
    await b.release();
    await c.release();
    expect(pool.stats().sessions).toBe(0);
  });

  it('drops a process that crashed from the pool', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 4 });
    const a = await pool.acquire(request());
    launcher.launched[0]?.exit(1);
    await Promise.resolve();
    await Promise.resolve();
    const b = await pool.acquire(request());
    expect(launcher.launched).toHaveLength(2);
    await a.release();
    await b.release();
  });

  it('does not end the shared process when a session is cancelled or closed', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 2 });
    const a = await pool.acquire(request());
    const b = await pool.acquire(request());
    await a.session.cancel();
    await a.release();
    expect(launcher.running).toHaveLength(1);
    await b.release();
  });

  it('shutdown ends every process and refuses new sessions', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 2 });
    await pool.acquire(request());
    await pool.shutdown();
    expect(launcher.running).toHaveLength(0);
    await expect(pool.acquire(request())).rejects.toThrow(/closed/);
  });
});
