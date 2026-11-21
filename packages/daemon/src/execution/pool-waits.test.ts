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
import { WAIT_KIND } from '../telemetry/span-conventions.js';
import type { DirectWait } from '../telemetry/wait-recorder.js';
import { POOL_WAIT_REASON, SessionPool } from './pool.js';

/** The pool of a fake client with room for `max` sessions, telling its waits to `waits`. */
function setup(max: number, recorder?: (wait: DirectWait) => void) {
  const launcher = new FakeProcessLauncher();
  const clock = new FakeClock();
  const waits: DirectWait[] = [];
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
    onWait: recorder ?? ((wait) => waits.push(wait)),
  });
  const request = (extra: Record<string, unknown> = {}) => ({
    client: 'fake',
    profile: TEST_PROFILE,
    policy: TEST_POLICY,
    cwd: '/work/one',
    correlation: { playId: 'p1', attemptId: 'p1/alpha/1', role: 'actor' },
    ...extra,
  });
  return { pool, clock, waits, request };
}

describe('the waits of the pool for a vacancy (P4, N217 (a))', () => {
  it('tells nothing for a session that was admitted at once', async () => {
    const { pool, waits, request } = setup(2);
    await (await pool.acquire(request())).release();
    expect(waits).toEqual([]);
  });

  it('tells the wait of a session held back by max_sessions, with its time and who waited', async () => {
    const { pool, clock, waits, request } = setup(1);
    const first = await pool.acquire(request({ correlation: { playId: 'p1', attemptId: 'a/1' } }));
    const second = pool.acquire(request());
    await Promise.resolve();
    await clock.advance(250);
    await first.release();
    await (await second).release();
    expect(waits).toHaveLength(1);
    const wait = waits[0];
    if (wait === undefined) throw new Error('no wait was told');
    expect(wait).toMatchObject({
      kind: WAIT_KIND.poolAdmission,
      reason: POOL_WAIT_REASON.maxSessions,
      outcome: 'admitted',
      correlation: {
        playId: 'p1',
        attemptId: 'p1/alpha/1',
        role: 'actor',
        client: 'fake',
        profile: TEST_PROFILE.id,
      },
    });
    expect(wait.endMs - wait.startMs).toBe(250);
    expect(wait.key).toContain('p1/alpha/1');
  });

  it('tells a wait that ended because the caller gave up, and the ones a shutdown dropped', async () => {
    const { pool, waits, request } = setup(1);
    const first = await pool.acquire(request());
    const controller = new AbortController();
    const given = pool.acquire(request({ signal: controller.signal }));
    const dropped = pool.acquire(request());
    const droppedResult = dropped.catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    await expect(given).rejects.toBeInstanceOf(Cancelled);
    await pool.shutdown();
    await droppedResult;
    await first.release().catch(() => undefined);
    expect(waits.map((wait) => wait.outcome)).toEqual(['cancelled', 'pool_closed']);
    expect(new Set(waits.map((wait) => wait.key)).size).toBe(2);
  });

  it('does not let a recorder that throws hold the pool', async () => {
    const { pool, request } = setup(1, () => {
      throw new Error('recorder is broken');
    });
    const first = await pool.acquire(request());
    const second = pool.acquire(request());
    await Promise.resolve();
    await first.release();
    await (await second).release();
    expect(pool.stats().sessions).toBe(0);
  });
});
