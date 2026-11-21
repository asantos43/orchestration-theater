// SPDX-License-Identifier: MPL-2.0
import { apiError, type ApiDirectSession } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../client.js';
import { DAEMON_ID, FakeDaemon, event, play, scenario, setPlay } from './fixtures.test-support.js';
import { DaemonStores } from './sync.js';
import {
  failTrajectory,
  initialTrajectories,
  mergeTrajectoryEvents,
  openTrajectory,
  reduceTrajectories,
  selectTrajectory,
  settleDirectSessions,
  settleTrajectory,
} from './trajectories.js';

const hubs: DaemonStores[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

const chunk = (id: number, text: string, playId = 'P1') =>
  event(
    id,
    'session.update',
    { update: { kind: 'agent_message_chunk', content: { type: 'text', text } } },
    { playId },
  );

/** What the REST read answers: the envelope of the log, which has no `daemonId`. */
const plain = (value: ReturnType<typeof chunk>) => {
  const rest: Partial<typeof value> = { ...value };
  delete rest.daemonId;
  return rest;
};

describe('trajectories: the reducers', () => {
  it('merges two lists by id, oldest first, and cuts to the last `keep`', () => {
    const merged = mergeTrajectoryEvents(
      [chunk(1, 'a'), chunk(3, 'c')],
      [chunk(2, 'b'), chunk(3, 'c')],
      2,
    );
    expect(merged.events.map((e) => e.id)).toEqual([2, 3]);
    expect(merged.dropped).toBe(1);
  });

  it('keeps only the plays a screen opened, and only the events of a trajectory', () => {
    let state = initialTrajectories();
    state = reduceTrajectories(state, chunk(1, 'a'), 10);
    expect(state.plays).toEqual({});
    state = openTrajectory(state, 'P1');
    state = reduceTrajectories(state, chunk(2, 'a'), 10);
    state = reduceTrajectories(state, event(3, 'play.created', {}, { playId: 'P1' }), 10);
    state = reduceTrajectories(state, chunk(4, 'x', 'P2'), 10);
    expect(state.plays.P1?.events.map((e) => e.id)).toEqual([2]);
    expect(state.plays.P2).toBeUndefined();
  });

  it('settles the history under the events the stream brought meanwhile, with no repeat', () => {
    let state = openTrajectory(initialTrajectories(), 'P1');
    state = reduceTrajectories(state, chunk(5, 'e'), 10);
    state = reduceTrajectories(state, chunk(5, 'e'), 10);
    state = settleTrajectory(state, 'P1', [chunk(1, 'a'), chunk(2, 'b'), chunk(5, 'e')], 10);
    expect(state.plays.P1).toMatchObject({ load: 'loaded', dropped: 0 });
    expect(state.plays.P1?.events.map((e) => e.id)).toEqual([1, 2, 5]);
    expect(selectTrajectory(state, 'P1')?.attempts).toEqual([]);
    expect(selectTrajectory(state, 'nope')).toBeUndefined();
  });

  it('counts what `keep` drops and keeps the failure with the events it has', () => {
    let state = openTrajectory(initialTrajectories(), 'P1');
    for (let id = 1; id <= 5; id += 1) state = reduceTrajectories(state, chunk(id, 'a'), 3);
    expect(state.plays.P1).toMatchObject({ dropped: 2 });
    state = failTrajectory(state, 'P1', 'boom');
    expect(state.plays.P1).toMatchObject({ load: 'failed', error: 'boom' });
    expect(state.plays.P1?.events).toHaveLength(3);
  });
});

const directEvent = (
  id: number,
  type: string,
  payload: Record<string, unknown> = {},
  sessionId = 'direct-0a1b2c3d',
  scenarioId = 'S1',
) => event(id, type, { sessionId, ...payload }, { scenarioId });

const directSession = (
  id: string,
  state: ApiDirectSession['state'],
  at: { lastActivityAt: number; closedAt?: number | null },
): ApiDirectSession => ({
  id,
  scenarioId: 'S1',
  executor: 'fake-model@fake/one',
  profile: 'fake/one',
  client: 'fake',
  model: null,
  workspace: 'readonly',
  branch: null,
  state,
  turns: 1,
  openedAt: 1,
  lastActivityAt: at.lastActivityAt,
  closedAt: at.closedAt ?? null,
  commands: [],
});

describe('trajectories: the direct sessions (P27, N206)', () => {
  it('notes a session that opens, follows it to its closing and keeps the events of the ones a screen opened', () => {
    let state = initialTrajectories();
    // An event of a session nobody noted, other than its opening, is not enough to know it.
    state = reduceTrajectories(state, directEvent(1, 'direct.session.message', { turn: 1 }), 10);
    expect(state.direct).toEqual({});
    state = reduceTrajectories(state, directEvent(2, 'direct.session.opened'), 10);
    expect(state.direct['direct-0a1b2c3d']).toMatchObject({
      scenarioId: 'S1',
      closed: false,
      at: event(2, 'x', {}).timestamp,
    });
    // Nothing is kept until a screen opens the session; then the events of the stream are.
    expect(state.plays).toEqual({});
    state = openTrajectory(state, 'direct-0a1b2c3d');
    state = reduceTrajectories(state, directEvent(3, 'direct.session.message', { turn: 1 }), 10);
    state = reduceTrajectories(
      state,
      directEvent(4, 'direct.session.closed', { reason: 'closed' }),
      10,
    );
    expect(state.plays['direct-0a1b2c3d']?.events.map((e) => e.id)).toEqual([3, 4]);
    expect(state.direct['direct-0a1b2c3d']).toMatchObject({ closed: true });
    expect(selectTrajectory(state, 'direct-0a1b2c3d')?.attempts).toHaveLength(1);
    // A refusal has no session, so the trajectory does not take it.
    const before = state;
    state = reduceTrajectories(
      state,
      event(5, 'direct.session.refused', { code: 'waiting' }, { scenarioId: 'S1' }),
      10,
    );
    expect(state).toBe(before);
  });

  it('merges the list of the REST read with what the stream noted, and never reopens a closed one', () => {
    let state = initialTrajectories();
    expect(settleDirectSessions(state, [])).toBe(state);
    state = reduceTrajectories(
      state,
      directEvent(2, 'direct.session.opened', {}, 'direct-aaaaaaaa'),
      10,
    );
    state = reduceTrajectories(
      state,
      directEvent(3, 'direct.session.closed', {}, 'direct-aaaaaaaa'),
      10,
    );
    state = settleDirectSessions(state, [
      directSession('direct-aaaaaaaa', 'idle', { lastActivityAt: 1 }),
      directSession('direct-bbbbbbbb', 'closed', { lastActivityAt: 5, closedAt: 9 }),
    ]);
    expect(state.direct['direct-aaaaaaaa']).toMatchObject({ closed: true });
    expect(state.direct['direct-aaaaaaaa']?.at).toBeGreaterThan(1);
    expect(state.direct['direct-bbbbbbbb']).toMatchObject({
      scenarioId: 'S1',
      closed: true,
      at: 9,
    });
  });
});

describe('DaemonStores: trajectories', () => {
  function hubOf(daemon: FakeDaemon, keep?: number): DaemonStores {
    const client = new ApiClient({
      url: 'http://127.0.0.1:1',
      token: 'test-token',
      daemonId: DAEMON_ID,
      fetch: daemon.fetch,
      timeoutMs: 0,
    });
    const hub = new DaemonStores(client, {
      stream: { random: () => 0.5 },
      ...(keep === undefined ? {} : { trajectories: { keep } }),
    });
    hubs.push(hub);
    return hub;
  }

  function populated(): FakeDaemon {
    const daemon = new FakeDaemon();
    daemon.head = 10;
    daemon.scenarios = [scenario('S1')];
    setPlay(daemon, play('P1', 'S1', { state: 'EXECUTING' }), []);
    return daemon;
  }

  it('reads the history once, by pages, then follows the stream with no read per event', async () => {
    const daemon = populated();
    daemon.intercept = (request) => {
      if (request.path !== '/v1/plays/P1/trajectory') return undefined;
      const first = request.query.get('after') === null;
      return Response.json(
        first
          ? { items: [plain(chunk(1, 'Hel')), plain(chunk(2, 'lo'))], nextCursor: 'c1' }
          : { items: [plain(chunk(3, '!'))], nextCursor: null },
      );
    };
    const hub = hubOf(daemon);
    await hub.start();
    await hub.loadTrajectory('P1');
    expect(hub.trajectories.getState().plays.P1?.events.map((e) => e.id)).toEqual([1, 2, 3]);
    await hub.loadTrajectory('P1');
    const reads = (): number =>
      daemon.requests.filter((request) => request.path === '/v1/plays/P1/trajectory').length;
    expect(reads()).toBe(2);

    daemon.push(chunk(11, 'live'));
    await waitUntil(() => hub.trajectories.getState().plays.P1?.events.length === 4);
    expect(reads()).toBe(2);
    const folded = selectTrajectory(hub.trajectories.getState(), 'P1');
    expect(folded?.attempts).toEqual([]);
  });

  it('keeps the failure of the read in the store and reads again when asked', async () => {
    const daemon = populated();
    let fail = true;
    daemon.intercept = (request) => {
      if (request.path !== '/v1/plays/P1/trajectory') return undefined;
      return fail
        ? Response.json(apiError('internal', 'down'), { status: 500 })
        : Response.json({ items: [plain(chunk(1, 'a'))], nextCursor: null });
    };
    const hub = hubOf(daemon);
    await hub.start();
    await hub.loadTrajectory('P1');
    expect(hub.trajectories.getState().plays.P1?.load).toBe('failed');
    fail = false;
    await hub.loadTrajectory('P1');
    expect(hub.trajectories.getState().plays.P1).toMatchObject({ load: 'loaded' });
  });

  it('reads the history of a direct session and the sessions of a scenario', async () => {
    const daemon = populated();
    const sessionEvent = (id: number, type: string, payload: Record<string, unknown>) =>
      plain(directEvent(id, type, payload));
    daemon.intercept = (request) => {
      if (request.path === '/v1/direct/direct-0a1b2c3d/trajectory') {
        return Response.json({
          items: [
            sessionEvent(1, 'direct.session.opened', { client: 'fake', workspace: 'readonly' }),
            sessionEvent(2, 'direct.session.message', { turn: 1, from: 'producer', text: 'hi' }),
            sessionEvent(3, 'direct.session.closed', { reason: 'closed', turns: 1, work: 'none' }),
          ],
          nextCursor: null,
        });
      }
      if (request.path === '/v1/scenarios/S1/direct') {
        return Response.json({
          sessions: [
            directSession('direct-0a1b2c3d', 'closed', { lastActivityAt: 5, closedAt: 8 }),
          ],
        });
      }
      return undefined;
    };
    const hub = hubOf(daemon);
    await hub.start();
    await hub.loadDirectSessions('S1');
    expect(hub.trajectories.getState().direct['direct-0a1b2c3d']).toMatchObject({
      scenarioId: 'S1',
      closed: true,
    });
    await hub.loadDirectTrajectory('direct-0a1b2c3d');
    const state = hub.trajectories.getState();
    expect(state.plays['direct-0a1b2c3d']).toMatchObject({ load: 'loaded' });
    const folded = selectTrajectory(state, 'direct-0a1b2c3d');
    expect(folded?.attempts[0]).toMatchObject({ attemptId: 'direct-0a1b2c3d', state: 'closed' });
    // Held: a second call reads nothing.
    await hub.loadDirectTrajectory('direct-0a1b2c3d');
    expect(
      daemon.requests.filter((request) => request.path === '/v1/direct/direct-0a1b2c3d/trajectory'),
    ).toHaveLength(1);
  });

  it('keeps what it had when the list of the sessions cannot be read', async () => {
    const daemon = populated();
    daemon.intercept = (request) =>
      request.path === '/v1/scenarios/S1/direct'
        ? Response.json(apiError('internal', 'down'), { status: 500 })
        : undefined;
    const hub = hubOf(daemon);
    await hub.start();
    await expect(hub.loadDirectSessions('S1')).resolves.toBeUndefined();
    expect(hub.trajectories.getState().direct).toEqual({});
  });

  it('reads the diff of a demand and keeps it', async () => {
    const daemon = populated();
    daemon.intercept = (request) =>
      request.path === '/v1/plays/P1/demands/D1/diff'
        ? Response.json({
            playId: 'P1',
            demandId: 'D1',
            attemptId: 'P1/D1/1',
            available: true,
            unavailable: null,
            diff: 'diff --git a/x b/x',
            truncated: false,
          })
        : undefined;
    const hub = hubOf(daemon);
    await hub.start();
    await hub.loadDemandDiff('P1', 'D1');
    expect(hub.trajectories.getState().diffs['P1/D1']).toMatchObject({ load: 'loaded' });
    expect(hub.trajectories.getState().diffs['P1/D1']?.value?.diff).toContain('diff --git');
  });
});

async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
}
