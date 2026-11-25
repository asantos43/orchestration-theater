// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, Cancelled, type SharedCancelMode } from '@otheater/core';
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

function setup(options: {
  shared: boolean;
  k?: number;
  max?: number;
  idleMs?: number;
  sharedCancel?: SharedCancelMode;
  env?: () => Record<string, string>;
}) {
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const clock = new FakeClock();
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: [] },
    processModel: options.shared ? 'multi-session' : 'process-per-session',
    ...(options.env === undefined ? {} : { env: options.env }),
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
      sharedCancel: options.sharedCancel ?? 'escalate',
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

describe('SessionPool, K per client', () => {
  function twoClients(byClient: Record<string, number>) {
    const launcher = new FakeProcessLauncher();
    const transport = new FakeSessionTransport();
    const make = (id: string) =>
      new FakeClientAdapter({
        id,
        launcher,
        baseEnv: {},
        adapterVersion: '1.0.0',
        command: { cmd: `${id}-client`, args: [] },
        processModel: 'multi-session',
      });
    const pool = new SessionPool({
      clients: [make('fake'), make('other')],
      launcher,
      transport: () => transport,
      clock: new FakeClock(),
      settings: {
        sessionsPerProcess: 4,
        sessionsPerProcessByClient: byClient,
        maxSessions: 20,
        idleMs: 60_000,
        sharedCancel: 'escalate',
      },
    });
    const request = (client: string) => ({
      client,
      profile: TEST_PROFILE,
      policy: TEST_POLICY,
      cwd: '/work/one',
    });
    return { launcher, pool, request };
  }

  it('opens processes at the K of each client', async () => {
    const { launcher, pool, request } = twoClients({ fake: 2, other: 3 });
    const leases = [];
    for (let i = 0; i < 5; i += 1) leases.push(await pool.acquire(request('fake')));
    // 5 sessions at K=2: three processes.
    expect(launcher.launched).toHaveLength(3);
    for (let i = 0; i < 5; i += 1) leases.push(await pool.acquire(request('other')));
    // 5 sessions at K=3: two more processes.
    expect(launcher.launched).toHaveLength(5);
    for (const lease of leases) await lease.release();
  });

  it('uses the global K for a client without a value of its own', async () => {
    const { launcher, pool, request } = twoClients({ fake: 1 });
    const leases = [];
    for (let i = 0; i < 4; i += 1) leases.push(await pool.acquire(request('other')));
    expect(launcher.launched).toHaveLength(1);
    for (let i = 0; i < 2; i += 1) leases.push(await pool.acquire(request('fake')));
    expect(launcher.launched).toHaveLength(3);
    for (const lease of leases) await lease.release();
  });

  it('acquires at the same time split each process at the K of its client', async () => {
    const { launcher, pool, request } = twoClients({ fake: 2, other: 3 });
    // Ten acquires at once, the two clients interleaved.
    const clients = [1, 2, 3, 4, 5].flatMap(() => ['fake', 'other']);
    const leases = await Promise.all(clients.map((client) => pool.acquire(request(client))));
    // 5 at K=2 (2, 2, 1) and 5 at K=3 (3, 2): five processes.
    expect(launcher.launched).toHaveLength(5);
    const perProcess = (client: string): number[] => {
      const counts = new Map<number, number>();
      for (const lease of leases.filter((candidate) => candidate.client === client)) {
        counts.set(lease.pid, (counts.get(lease.pid) ?? 0) + 1);
      }
      return [...counts.values()].sort((a, b) => b - a);
    };
    expect(perProcess('fake')).toEqual([2, 2, 1]);
    expect(perProcess('other')).toEqual([3, 2]);
    for (const lease of leases) await lease.release();
    expect(pool.stats().sessions).toBe(0);
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

  it('does not share a process between launch specs that differ, and shares equal ones', async () => {
    let permission = 'ask';
    const { pool, launcher, request } = setup({
      shared: true,
      k: 4,
      env: () => ({ OPENCODE_PERMISSION: permission }),
    });
    const a = await pool.acquire(request());
    const b = await pool.acquire(request());
    expect(launcher.launched).toHaveLength(1);
    expect(a.pid).toBe(b.pid);
    permission = 'allow';
    const c = await pool.acquire(request());
    expect(launcher.launched).toHaveLength(2);
    expect(c.pid).not.toBe(a.pid);
    const d = await pool.acquire(request());
    expect(d.pid).toBe(c.pid);
    expect(launcher.launched).toHaveLength(2);
    // Back to the first spec: it joins the first process again.
    permission = 'ask';
    const e = await pool.acquire(request());
    expect(e.pid).toBe(a.pid);
    for (const lease of [a, b, c, d, e]) await lease.release();
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

  describe('pool.shared_cancel', () => {
    const deaf = [{ type: 'text' as const, text: '#script:deaf\n' }];

    async function trio(sharedCancel?: SharedCancelMode) {
      const rig = setup({
        shared: true,
        k: 3,
        ...(sharedCancel === undefined ? {} : { sharedCancel }),
      });
      const a = await rig.pool.acquire(rig.request());
      const b = await rig.pool.acquire(rig.request());
      const c = await rig.pool.acquire(rig.request());
      return { ...rig, a, b, c };
    }

    it('escalate: a cancel the client honours leaves the process to the others', async () => {
      const { launcher, a, b, c } = await trio();
      await a.session.cancel();
      expect(launcher.running).toHaveLength(1);
      expect(a.escalation).toBeUndefined();
      expect(b.casualty).toBe(false);
      for (const lease of [a, b, c]) await lease.release();
    });

    it('escalate: a cancel the client ignores ends the process and marks who fell', async () => {
      const { pool, launcher, a, b, c } = await trio();
      const running = a.session.prompt(deaf);
      const sibling = b.session.prompt(deaf).catch((error: unknown) => error);
      await Promise.resolve();
      await a.session.cancel();
      await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(launcher.running).toHaveLength(0);
      expect(a.escalation).toEqual({ pid: a.pid, siblings: 2 });
      expect(a.casualty).toBe(false);
      expect(b.escalation).toBeUndefined();
      expect(b.casualty).toBe(true);
      expect(c.casualty).toBe(true);
      expect(await sibling).toBeInstanceOf(AdapterUnavailable);
      expect(pool.stats().processes).toBe(0);
      // The next session gets a new process.
      const d = await pool.acquire({
        client: 'fake',
        profile: TEST_PROFILE,
        policy: TEST_POLICY,
        cwd: '/work/one',
      });
      expect(launcher.launched).toHaveLength(2);
      expect(d.casualty).toBe(false);
      for (const lease of [a, b, c, d]) await lease.release();
      expect(pool.stats().sessions).toBe(0);
    });

    it('escalate: the last session of a process that ignores the cancel is no escalation', async () => {
      const { pool, launcher, request } = setup({ shared: true, k: 2 });
      const only = await pool.acquire(request());
      const running = only.session.prompt(deaf);
      await Promise.resolve();
      await only.session.cancel();
      await running;
      expect(launcher.running).toHaveLength(0);
      expect(only.escalation).toBeUndefined();
      await only.release();
    });

    it('always_kill: a cancel the client honours ends the process anyway', async () => {
      const { launcher, a, b, c } = await trio('always_kill');
      await a.session.cancel();
      expect(launcher.running).toHaveLength(0);
      expect(a.escalation).toEqual({ pid: a.pid, siblings: 2 });
      expect(b.casualty).toBe(true);
      for (const lease of [a, b, c]) await lease.release();
    });

    it('release: not even a cancel the client ignores ends the process', async () => {
      const { launcher, a, b, c } = await trio('release');
      const running = a.session.prompt(deaf);
      await Promise.resolve();
      await a.session.cancel();
      await running;
      expect(launcher.running).toHaveLength(1);
      expect(a.escalation).toBeUndefined();
      expect(b.casualty).toBe(false);
      for (const lease of [a, b, c]) await lease.release();
    });

    it('a plain close never ends the others, in any mode', async () => {
      for (const mode of ['escalate', 'always_kill', 'release'] as const) {
        const { launcher, a, b, c } = await trio(mode);
        await a.release();
        expect(launcher.running).toHaveLength(1);
        await b.release();
        await c.release();
      }
    });
  });

  it('shutdown ends every process and refuses new sessions', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 2 });
    await pool.acquire(request());
    await pool.shutdown();
    expect(launcher.running).toHaveLength(0);
    await expect(pool.acquire(request())).rejects.toThrow(/closed/);
  });
});

describe('SessionPool, acquires at the same time', () => {
  function pids(leases: readonly { pid: number }[]): number[] {
    const counts = new Map<number, number>();
    for (const lease of leases) counts.set(lease.pid, (counts.get(lease.pid) ?? 0) + 1);
    return [...counts.values()].sort((a, b) => b - a);
  }

  /** Makes the `n`-th `open` of the transport (from 1) reject. */
  function failOpen(transport: FakeSessionTransport, n: number): void {
    const open = transport.open.bind(transport);
    let calls = 0;
    transport.open = (params) => {
      calls += 1;
      return calls === n ? Promise.reject(new Error('boom')) : open(params);
    };
  }

  it('K=4: four at once share one process', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 4 });
    const leases = await Promise.all([1, 2, 3, 4].map(() => pool.acquire(request())));
    expect(launcher.launched).toHaveLength(1);
    expect(pids(leases)).toEqual([4]);
    expect(pool.stats()).toEqual({ processes: 1, sessions: 4, queued: 0 });
    for (const lease of leases) await lease.release();
  });

  it('K=2: five at once open three processes', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 2 });
    const leases = await Promise.all([1, 2, 3, 4, 5].map(() => pool.acquire(request())));
    expect(launcher.launched).toHaveLength(3);
    expect(pids(leases)).toEqual([2, 2, 1]);
    for (const lease of leases) await lease.release();
    expect(pool.stats().sessions).toBe(0);
  });

  it('an open that fails in the middle gives its slot on the process back', async () => {
    const { pool, launcher, transport, request } = setup({ shared: true, k: 4 });
    failOpen(transport, 2);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => pool.acquire(request())));
    const leases = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(leases).toHaveLength(3);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(launcher.launched).toHaveLength(1);
    expect(pool.stats()).toEqual({ processes: 1, sessions: 3, queued: 0 });
    // The freed slot takes the next session, on the same process.
    const next = await pool.acquire(request());
    expect(launcher.launched).toHaveLength(1);
    expect(next.pid).toBe(leases[0]?.pid);
    for (const lease of [...leases, next]) await lease.release();
  });

  it('a process whose every open failed starts its idle timer', async () => {
    const { pool, launcher, transport, clock, request } = setup({
      shared: true,
      k: 2,
      idleMs: 5_000,
    });
    transport.failWith = new Error('boom');
    const results = await Promise.allSettled([1, 2].map(() => pool.acquire(request())));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(launcher.launched).toHaveLength(1);
    expect(pool.stats()).toEqual({ processes: 1, sessions: 0, queued: 0 });
    await clock.advance(5_000);
    expect(launcher.running).toHaveLength(0);
    expect(pool.stats().processes).toBe(0);
  });

  it('a launch that fails rejects every session waiting on it and frees their slots', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 2 });
    launcher.failWith = new Error('no binary');
    const results = await Promise.allSettled([1, 2, 3].map(() => pool.acquire(request())));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(pool.stats()).toEqual({ processes: 0, sessions: 0, queued: 0 });
    launcher.failWith = undefined;
    const leases = await Promise.all([1, 2].map(() => pool.acquire(request())));
    expect(launcher.launched).toHaveLength(1);
    expect(pids(leases)).toEqual([2]);
    for (const lease of leases) await lease.release();
  });

  it('a shutdown during the launch ends the process and rejects every session on it', async () => {
    const { pool, launcher, request } = setup({ shared: true, k: 4 });
    const waiting = Promise.allSettled([1, 2, 3].map(() => pool.acquire(request())));
    await pool.shutdown();
    const results = await waiting;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(String(result.reason)).toMatch(/closed/);
    }
    expect(launcher.launched).toHaveLength(1);
    expect(launcher.running).toHaveLength(0);
  });

  it('process per session (Claude Code): four at once still start four processes', async () => {
    const { pool, launcher, request } = setup({ shared: false });
    const leases = await Promise.all([1, 2, 3, 4].map(() => pool.acquire(request())));
    expect(launcher.launched).toHaveLength(4);
    expect(leases.every((lease) => !lease.shared)).toBe(true);
    for (const lease of leases) await lease.release();
    expect(launcher.running).toHaveLength(0);
  });
});

describe('SessionPool, framework MCP server', () => {
  const framework = {
    name: 'otheater',
    url: 'http://127.0.0.1:1/mcp',
    headers: { Authorization: 'Bearer t' },
  };

  it.each([false, true])(
    'hands the MCP servers of the request to the session, new and reloaded (shared: %s)',
    async (shared) => {
      const { pool, transport, request } = setup({ shared });
      const policy = { ...TEST_POLICY, mcpServers: ['otheater'] };
      const lease = await pool.acquire({ ...request(), policy, mcpServers: [framework] });
      expect(transport.opened[0]?.mcpServers).toEqual([framework]);
      const reloaded = await pool.acquire({
        ...request(TEST_PROFILE, { resumeSessionId: lease.session.sessionId }),
        policy,
        mcpServers: [framework],
      });
      expect(transport.loaded[0]?.mcpServers).toEqual([framework]);
      await reloaded.release();
      await lease.release();
    },
  );

  it('refuses a server the policy of the role does not list', async () => {
    const { pool, request } = setup({ shared: false });
    await expect(pool.acquire({ ...request(), mcpServers: [framework] })).rejects.toThrow(
      /otheater/,
    );
  });
});

describe('SessionPool, the profile that leaves (P21)', () => {
  it('sessionsOf counts the sessions of one profile, per profile', async () => {
    const { pool, request } = setup({ shared: false });
    expect(pool.sessionsOf('fake/one')).toBe(0);
    const one = await pool.acquire(request());
    const two = await pool.acquire(request(OTHER_PROFILE));
    expect(pool.sessionsOf('fake/one')).toBe(1);
    expect(pool.sessionsOf('fake/two')).toBe(1);
    // A process of its own per session: there is no shared process to end.
    expect(await pool.endProcessesOf('fake/one')).toBe(0);
    await one.release();
    await two.release();
    expect(pool.sessionsOf('fake/one')).toBe(0);
    expect(pool.sessionsOf('fake/two')).toBe(0);
  });

  it('endProcessesOf ends the shared processes of that profile only, idle ones included', async () => {
    const { pool, launcher, request } = setup({ shared: true, idleMs: 3_600_000 });
    await (await pool.acquire(request())).release();
    const other = await pool.acquire(request(OTHER_PROFILE));
    expect(launcher.running).toHaveLength(2);
    expect(await pool.endProcessesOf('fake/one')).toBe(1);
    expect(launcher.running).toHaveLength(1);
    expect(await pool.endProcessesOf('fake/one')).toBe(0);
    await other.release();
  });
});

describe('SessionPool.addClient (P18, N321)', () => {
  it('takes a client found after the start and opens sessions on it', async () => {
    const { pool, launcher, request } = setup({ shared: false });
    const late = new FakeClientAdapter({
      id: 'late',
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'late-client', args: [] },
      processModel: 'process-per-session',
    });
    expect(pool.has('late')).toBe(false);
    pool.addClient(late);
    expect(pool.has('late')).toBe(true);
    expect(pool.clients()).toEqual(['fake', 'late']);
    expect(pool.adapterOf('late')).toBe(late);
    const lease = await pool.acquire({ ...request(), client: 'late' });
    expect(launcher.running.some((proc) => proc.options.cmd === 'late-client')).toBe(true);
    await lease.release();
  });

  it('refuses an id it has, and any client once it is shut down', async () => {
    const { pool, adapter } = setup({ shared: false });
    expect(() => {
      pool.addClient(adapter);
    }).toThrow(/share the id fake/);
    await pool.shutdown();
    const other = new FakeClientAdapter({
      id: 'other',
      launcher: new FakeProcessLauncher(),
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'other', args: [] },
      processModel: 'process-per-session',
    });
    expect(() => {
      pool.addClient(other);
    }).toThrow(/closed/);
  });
});
