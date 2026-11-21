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
import { WaitEvents, type WaitTracker } from '../telemetry/wait-events.js';
import { RecordingSituations } from '../telemetry/wait-events-fixture.js';
import { POOL_WAIT_REASON, SessionPool } from './pool.js';

/**
 * The pool of a fake client with room for `max` sessions, telling its waits (those that last
 * `thresholdMs`) to the situations it returns.
 */
function setup(max: number, thresholdMs = 100, tracker?: WaitTracker) {
  const launcher = new FakeProcessLauncher();
  const clock = new FakeClock();
  const situations = new RecordingSituations();
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: [] },
    processModel: 'process-per-session',
  });
  const pool = new SessionPool({
    clients: [adapter],
    launcher,
    transport: () => new FakeSessionTransport(),
    clock,
    settings: { sessionsPerProcess: 1, maxSessions: max, idleMs: 60_000, sharedCancel: 'escalate' },
    waits: tracker ?? new WaitEvents({ situations, clock, thresholdMs }),
  });
  const request = (extra: Record<string, unknown> = {}) => ({
    client: 'fake',
    profile: TEST_PROFILE,
    policy: TEST_POLICY,
    cwd: '/work/one',
    correlation: { playId: 'p1', attemptId: 'p1/alpha/1', role: 'actor' },
    ...extra,
  });
  return { pool, clock, situations, request };
}

describe('the waits of the pool for a vacancy (P15, N222 (a))', () => {
  it('tells nothing for a session that was admitted at once', async () => {
    const { pool, situations, request } = setup(2, 0);
    await (await pool.acquire(request())).release();
    expect(situations.told).toEqual([]);
  });

  it('tells nothing for a wait under the threshold', async () => {
    const { pool, clock, situations, request } = setup(1, 500);
    const first = await pool.acquire(request());
    const second = pool.acquire(request());
    await Promise.resolve();
    await clock.advance(499);
    await first.release();
    await (await second).release();
    expect(situations.told).toEqual([]);
    expect(clock.pendingSleeps).toBe(0);
  });

  it('tells a wait past the threshold held by max_sessions, with its time and who waited', async () => {
    const { pool, clock, situations, request } = setup(1, 100);
    const first = await pool.acquire(request({ correlation: { playId: 'p1', attemptId: 'a/1' } }));
    const second = pool.acquire(request());
    await Promise.resolve();
    await clock.advance(250);
    expect(situations.types).toEqual(['wait.started']);
    await first.release();
    await (await second).release();
    expect(situations.types).toEqual(['wait.started', 'wait.ended']);
    const [started, ended] = situations.told;
    expect(started?.payload).toMatchObject({
      kind: 'pool_admission',
      reasons: [POOL_WAIT_REASON.maxSessions],
      playId: 'p1',
      attemptId: 'p1/alpha/1',
      role: 'actor',
      client: 'fake',
      profile: TEST_PROFILE.id,
      thresholdMs: 100,
    });
    expect(ended?.payload).toMatchObject({ outcome: 'admitted', waitedMs: 250 });
    expect(ended?.payload.waitId).toContain('p1/alpha/1');
    expect(ended?.correlation).toMatchObject({ playId: 'p1', attemptId: 'p1/alpha/1' });
  });

  it('tells a wait that ended because the caller gave up, and the ones a shutdown dropped', async () => {
    const { pool, clock, situations, request } = setup(1, 0);
    const first = await pool.acquire(request());
    const controller = new AbortController();
    const given = pool.acquire(request({ signal: controller.signal }));
    const dropped = pool.acquire(request());
    const droppedResult = dropped.catch((error: unknown) => error);
    await Promise.resolve();
    await clock.advance(1);
    controller.abort();
    await expect(given).rejects.toBeInstanceOf(Cancelled);
    await pool.shutdown();
    await droppedResult;
    await first.release().catch(() => undefined);
    const ended = situations.told.filter((entry) => entry.type === 'wait.ended');
    expect(ended.map((entry) => entry.payload.outcome)).toEqual(['cancelled', 'pool_closed']);
    expect(new Set(ended.map((entry) => entry.payload.waitId)).size).toBe(2);
  });

  it('does not let a tracker that throws hold the pool', async () => {
    const { pool, request } = setup(1, 0, {
      begin: () => {
        throw new Error('tracker is broken');
      },
    });
    const first = await pool.acquire(request());
    const second = pool.acquire(request());
    await Promise.resolve();
    await first.release();
    await (await second).release();
    expect(pool.stats().sessions).toBe(0);
  });
});
