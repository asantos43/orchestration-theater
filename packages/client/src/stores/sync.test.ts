// SPDX-License-Identifier: MPL-2.0
import { API_ROUTES, apiError } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../client.js';
import type { Clock } from '../connection.js';
import { waitFor } from '../test-clock.test-support.js';
import {
  DAEMON_ID,
  FakeDaemon,
  attempt,
  decision,
  decisionAnswered,
  decisionCreated,
  demand,
  demandTransitioned,
  event,
  play,
  playCreated,
  playTransitioned,
  profileOf,
  quota,
  scenario,
  scenarioArchived,
  setPlay,
} from './fixtures.test-support.js';
import { DaemonStores, type DaemonStoresOptions, type SyncProblem } from './sync.js';

const HEAD_TIMEOUT = 123_456;
const hubs: DaemonStores[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

/** Sleeps end after a turn, but the wait for the head of the log lasts until it is aborted. */
const clock: Clock = {
  async sleep(ms, signal) {
    if (ms === HEAD_TIMEOUT) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) resolve();
        else
          signal?.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
      });
      return;
    }
    if (signal?.aborted === true) return;
    await Promise.resolve();
  },
};

function hubOf(daemon: FakeDaemon, options: DaemonStoresOptions = {}): DaemonStores {
  const client = new ApiClient({
    url: 'http://127.0.0.1:1',
    token: 'test-token',
    daemonId: DAEMON_ID,
    fetch: daemon.fetch,
    timeoutMs: 0,
  });
  const hub = new DaemonStores(client, {
    clock,
    headTimeoutMs: HEAD_TIMEOUT,
    stream: { random: () => 0.5 },
    ...options,
  });
  hubs.push(hub);
  return hub;
}

/** One scenario, one open play with a demand, one pending decision, one account. */
function populated(): FakeDaemon {
  const daemon = new FakeDaemon();
  daemon.head = 10;
  daemon.scenarios = [scenario('S1'), scenario('S2', { state: 'archived' })];
  setPlay(daemon, play('P1', 'S1', { state: 'PLANNING' }), [demand('P1', 'D1')]);
  setPlay(daemon, play('P0', 'S1', { state: 'DONE', finishedAt: 5 }));
  daemon.decisions.set('S1', [decision('K1', 'S1')]);
  daemon.profiles = [profileOf(quota('codex/main')), profileOf(null, 'claude-code/work')];
  return daemon;
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5));
const count = (daemon: FakeDaemon, path: string): number =>
  daemon.requests.filter((request) => request.path === path).length;

describe('DaemonStores: the first read', () => {
  it('reads every snapshot, installs it at the head of the log and goes live', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    expect(hub.status.getState()).toMatchObject({ phase: 'live', cursor: 10 });
    expect(Object.keys(hub.scenarios.getState().byId)).toEqual(['S1', 'S2']);
    // Only the open plays, and the demands of those.
    expect(Object.keys(hub.plays.getState().byId)).toEqual(['P1']);
    expect(hub.demands.getState().byPlay.P1?.demands).toHaveLength(1);
    expect(Object.keys(hub.decisions.getState().byScenario)).toEqual(['S1']);
    expect(Object.keys(hub.quotas.getState().byProfile)).toEqual(['codex/main']);
    for (const store of [
      hub.scenarios,
      hub.plays,
      hub.demands,
      hub.decisions,
      hub.quotas,
      hub.events,
    ]) {
      expect(store.getState()).toMatchObject({ loaded: true, lastEventId: 10 });
    }
  });

  it('shows a play paused before the connection as paused, with its Actors (P25)', async () => {
    const daemon = populated();
    setPlay(daemon, play('P1', 'S1', { state: 'EXECUTING', paused: true }), [demand('P1', 'D1')]);
    daemon.attempts = [
      attempt('P1', 'D1', { state: 'awaiting_resume', cause: 'paused', paused: 'play' }),
      attempt('P1', 'D2', { state: 'completed' }),
      attempt('P0', 'D1'),
    ];
    const hub = hubOf(daemon);
    await hub.start();
    expect(hub.plays.getState().byId.P1?.paused).toBe(true);
    const activity = hub.activity.getState();
    expect(activity.pausedPlays).toHaveProperty('P1');
    // Only the attempts still open, of the plays still open.
    expect(Object.keys(activity.actors)).toEqual(['P1/D1/1']);
    expect(activity.actors['P1/D1/1']).toMatchObject({ paused: 'play', playId: 'P1' });
    expect(count(daemon, '/v1/plays/P1/attempts')).toBe(1);
    expect(count(daemon, '/v1/plays/P0/attempts')).toBe(0);
  });

  it('does not read the attempts when `activity` is `none` (P25)', async () => {
    const daemon = populated();
    daemon.attempts = [attempt('P1', 'D1')];
    const hub = hubOf(daemon, { activity: 'none' });
    await hub.start();
    expect(hub.activity.getState().actors).toEqual({});
    expect(count(daemon, '/v1/plays/P1/attempts')).toBe(0);
  });

  it('asks the finished plays too when `plays` is `all`', async () => {
    const daemon = populated();
    const hub = hubOf(daemon, { plays: 'all' });
    await hub.start();
    expect(Object.keys(hub.plays.getState().byId).sort()).toEqual(['P0', 'P1']);
  });

  it('reads the last finished plays when asked, before and after going live (P11)', async () => {
    const daemon = populated();
    // The fake lists in the order of insertion, as the daemon lists, oldest first: F1, F2.
    setPlay(daemon, play('F1', 'S1', { state: 'CANCELLED', finishedAt: 6, createdAt: 1 }));
    setPlay(daemon, play('F2', 'S1', { state: 'DONE', finishedAt: 7, createdAt: 2 }));
    const early = hubOf(daemon);
    await early.loadFinishedPlays(1);
    // Not live yet: the limit is kept for the snapshot.
    expect(early.plays.getState().byId).toEqual({});
    await early.start();
    expect(Object.keys(early.plays.getState().byId).sort()).toEqual(['F2', 'P1']);

    // Asked after the start: it merges and keeps what it had.
    const late = hubOf(daemon);
    await late.start();
    expect(Object.keys(late.plays.getState().byId)).toEqual(['P1']);
    await late.loadFinishedPlays(5);
    expect(Object.keys(late.plays.getState().byId).sort()).toEqual(['F1', 'F2', 'P0', 'P1']);
    expect(late.plays.getState().byId.P1?.state).toBe('PLANNING');

    // Zero turns it off for the next snapshot.
    await late.loadFinishedPlays(0);
    await late.resync();
    expect(Object.keys(late.plays.getState().byId)).toEqual(['P1']);
  });

  it('reads every page of a list', async () => {
    const daemon = populated();
    daemon.scenarios = ['S1', 'S2', 'S3'].map((id) => scenario(id));
    const hub = hubOf(daemon, { pageLimit: 1 });
    await hub.start();
    expect(Object.keys(hub.scenarios.getState().byId)).toEqual(['S1', 'S2', 'S3']);
    expect(count(daemon, '/v1/scenarios')).toBe(3);
  });

  it('follows only the plays asked for when `demands` is `none`', async () => {
    const daemon = populated();
    const hub = hubOf(daemon, { demands: 'none' });
    await hub.start();
    expect(hub.demands.getState().byPlay).toEqual({});
    hub.trackPlay('P1');
    await hub.whenIdle();
    expect(hub.demands.getState().byPlay.P1?.demands).toHaveLength(1);
    expect(hub.demands.getState().stale).toEqual({});
  });

  it('rejects `start()` and fails when the stream is refused', async () => {
    const daemon = populated();
    daemon.intercept = (request) =>
      request.path === '/v1/events'
        ? Response.json(apiError('unauthorized', 'no'), { status: 401 })
        : undefined;
    const hub = hubOf(daemon);
    await expect(hub.start()).rejects.toThrow();
    expect(hub.status.getState().phase).toBe('failed');
    expect(hub.status.getState().error).toBeDefined();
  });

  it('is closed for good after `close()`', async () => {
    const hub = hubOf(populated());
    await hub.start();
    hub.close();
    expect(hub.status.getState().phase).toBe('closed');
    await expect(hub.start()).rejects.toThrow('closed');
  });
});

describe('DaemonStores: no event is lost between the read and the stream', () => {
  it('applies the events that came while the snapshot was being read', async () => {
    const daemon = populated();
    let pushed = false;
    daemon.intercept = async (request) => {
      if (request.path === '/v1/scenarios' && !pushed) {
        pushed = true;
        // The snapshot below is read before these events; they are above the head (10).
        daemon.push(
          playTransitioned(11, 'S1', 'P1', 'EXECUTING', { plan_reviews: 1 }),
          playCreated(12, 'S1', 'P2'),
        );
        await tick();
      }
      return undefined;
    };
    const hub = hubOf(daemon);
    await hub.start();
    expect(hub.plays.getState().byId.P1?.state).toBe('EXECUTING');
    expect(hub.plays.getState().byId.P2?.state).toBe('NEED');
    expect(hub.status.getState().cursor).toBe(12);
    expect(hub.events.getState().events.map((e) => e.id)).toEqual([11, 12]);
  });

  it('ends in the same state when the snapshot already holds what the buffered events say', async () => {
    const daemon = populated();
    let pushed = false;
    daemon.intercept = async (request) => {
      if (request.path === '/v1/scenarios' && !pushed) {
        pushed = true;
        daemon.push(
          playTransitioned(11, 'S1', 'P1', 'EXECUTING'),
          playTransitioned(12, 'S1', 'P1', 'DONE'),
        );
        await tick();
        // The daemon moved on: the snapshot read from here on is the end of the play.
        setPlay(
          daemon,
          play('P1', 'S1', {
            state: 'DONE',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_012,
            finishedAt: 1_700_000_000_012,
          }),
        );
      }
      return undefined;
    };
    const hub = hubOf(daemon, { plays: 'all' });
    await hub.start();
    expect(hub.plays.getState().byId.P1).toMatchObject({
      state: 'DONE',
      finishedAt: 1_700_000_000_012,
    });
  });

  it('takes the id of the first message as the head when there is no head frame', async () => {
    const daemon = populated();
    daemon.head = undefined;
    const hub = hubOf(daemon);
    const started = hub.start();
    await waitFor(() => daemon.streamCount === 1, 'the stream');
    // The event 5 was committed before it was sent, so the snapshot read next already has it.
    setPlay(daemon, play('P1', 'S1', { state: 'EXECUTING' }), [demand('P1', 'D1')]);
    daemon.push(playTransitioned(5, 'S1', 'P1', 'EXECUTING'));
    await started;
    expect(hub.status.getState().cursor).toBe(5);
    expect(hub.plays.getState().byId.P1?.state).toBe('EXECUTING');
    expect(hub.events.getState().events).toEqual([]);
  });

  it('goes on at `0` when the head never comes, and applies what arrives', async () => {
    const daemon = populated();
    daemon.head = undefined;
    // The wait for the head ends at once: this clock does not hold it.
    const hub = hubOf(daemon, { clock: { sleep: () => Promise.resolve() } });
    await hub.start();
    expect(hub.status.getState().phase).toBe('live');
    daemon.push(playTransitioned(1, 'S1', 'P1', 'DONE'));
    await waitFor(() => hub.status.getState().cursor === 1, 'the event');
    expect(hub.plays.getState().byId.P1?.state).toBe('DONE');
  });
});

describe('DaemonStores: following the stream', () => {
  it('applies live events to every store and keeps the recent ones up to `events.keep`', async () => {
    const daemon = populated();
    const hub = hubOf(daemon, { events: { keep: 2 } });
    await hub.start();
    daemon.push(
      event(
        11,
        'scenario.director_slept',
        { scenarioId: 'S1', idleMs: 1000 },
        { scenarioId: 'S1' },
      ),
      playTransitioned(12, 'S1', 'P1', 'EXECUTING'),
      event(13, 'brand.new_type', { x: 1 }),
    );
    await waitFor(() => hub.status.getState().cursor === 13, 'the events');
    expect(hub.scenarios.getState().byId.S1?.directorState).toBe('asleep');
    expect(hub.plays.getState().byId.P1?.state).toBe('EXECUTING');
    expect(hub.events.getState().events.map((e) => e.id)).toEqual([12, 13]);
  });

  it('applies an event once when the stream sends it again', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    daemon.push(
      playTransitioned(11, 'S1', 'P1', 'EXECUTING'),
      playTransitioned(11, 'S1', 'P1', 'DONE'),
    );
    daemon.push(playTransitioned(12, 'S1', 'P1', 'CRITIQUING'));
    await waitFor(() => hub.status.getState().cursor === 12, 'the events');
    expect(hub.events.getState().events.map((e) => e.id)).toEqual([11, 12]);
    expect(hub.plays.getState().byId.P1?.state).toBe('CRITIQUING');
  });

  it('resumes after a dropped connection with the last id, and gives no event twice', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    daemon.push(playTransitioned(11, 'S1', 'P1', 'EXECUTING'));
    await waitFor(() => hub.status.getState().cursor === 11, 'the event');
    daemon.drop();
    await waitFor(() => daemon.streamCount === 2, 'the second stream');
    expect(daemon.requests.filter((r) => r.path === '/v1/events').at(-1)?.lastEventId).toBe('11');
    daemon.push(
      playTransitioned(11, 'S1', 'P1', 'EXECUTING'),
      playTransitioned(12, 'S1', 'P1', 'DONE'),
    );
    await waitFor(() => hub.status.getState().cursor === 12, 'the event after the resume');
    expect(hub.events.getState().events.map((e) => e.id)).toEqual([11, 12]);
    expect(hub.status.getState().phase).toBe('live');
  });
});

describe('DaemonStores: what the events cannot keep is read again', () => {
  it('keeps the pending decisions from the events, with no read of the list (N173)', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    const reads = count(daemon, '/v1/scenarios/S1/decisions');
    const second = decision('K2', 'S1', 2);
    daemon.push(
      playTransitioned(11, 'S1', 'P1', 'AWAITING_PRODUCER'),
      decisionCreated(12, second),
      decisionAnswered(13, decision('K1', 'S1')),
    );
    await waitFor(() => hub.status.getState().cursor === 13, 'the events');
    await hub.whenIdle();
    expect(hub.decisions.getState().byScenario.S1?.map((d) => d.id)).toEqual(['K2']);
    expect(hub.decisions.getState().stale).toEqual({});
    expect(count(daemon, '/v1/scenarios/S1/decisions')).toBe(reads);
  });

  it('reads a new scenario by REST, and builds a new play from events with no read of its detail', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    daemon.scenarios.push(scenario('S3'));
    const born = demand('P2', 'D1');
    daemon.push(
      event(
        11,
        'scenario.created',
        { scenarioId: 'S3', type: 'project', flow: 'f', name: 'n', folder: '/f' },
        { scenarioId: 'S3' },
      ),
      playCreated(12, 'S1', 'P2'),
      demandTransitioned(13, 'S1', 'P2', 'D1', null, 'pending', born),
      demandTransitioned(14, 'S1', 'P2', 'D1', 'pending', 'ready'),
    );
    await waitFor(() => hub.scenarios.getState().byId.S3 !== undefined, 'the new scenario');
    await waitFor(() => hub.status.getState().cursor === 14, 'the events');
    await hub.whenIdle();
    expect(hub.demands.getState().byPlay.P2?.demands.map((d) => d.state)).toEqual(['ready']);
    expect(hub.scenarios.getState().stale).toEqual({});
    expect(hub.demands.getState().stale).toEqual({});
    expect(count(daemon, '/v1/plays/P2')).toBe(0);
  });

  it('archives a scenario from `scenario.archived` with no read of it (N173)', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    const reads = count(daemon, '/v1/scenarios/S1');
    daemon.push(scenarioArchived(11, 'S1'));
    await waitFor(() => hub.scenarios.getState().byId.S1?.state === 'archived', 'the archive');
    await hub.whenIdle();
    expect(hub.decisions.getState().byScenario.S1).toBeUndefined();
    expect(count(daemon, '/v1/scenarios/S1')).toBe(reads);
  });

  it('reads the quota of an account again after its event, and the read has the last word', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    daemon.profiles = [profileOf(quota('codex/main', { state: 'near_limit', reason: 'high use' }))];
    daemon.push(
      event(11, 'quota.updated', {
        profile: 'codex/main',
        state: 'near_limit',
        source: 'probe',
        windows: [],
      }),
    );
    await waitFor(
      () => hub.quotas.getState().byProfile['codex/main']?.reason === 'high use',
      'the read',
    );
    await hub.whenIdle();
    expect(hub.quotas.getState().stale).toEqual({});
  });

  it('keeps a key stale when an event marks it again while its read is in flight', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const detail = (record: ReturnType<typeof scenario>) =>
      Response.json({
        scenario: record,
        conventions: null,
        configOverride: {},
        repos: [],
        counts: { openPlays: 0, pendingDecisions: 0, attachments: 0 },
      });
    daemon.intercept = async (request) => {
      if (request.path === '/v1/scenarios/S3' && !gated) {
        gated = true;
        // The answer of the first read is the old record, delivered late.
        const old = detail(scenario('S3'));
        await gate;
        return old;
      }
      return undefined;
    };
    daemon.scenarios.push(scenario('S3', { state: 'archived' }));
    daemon.push(scenarioArchived(11, 'S3'));
    await waitFor(() => gated, 'the read to start');
    daemon.push(scenarioArchived(12, 'S3'));
    await waitFor(() => hub.status.getState().cursor === 12, 'the second event');
    release();
    await waitFor(() => hub.scenarios.getState().byId.S3?.state === 'archived', 'the second read');
    await hub.whenIdle();
    expect(hub.scenarios.getState().stale).toEqual({});
  });

  it('drops a record whose read answers 404 and does not ask again', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await hub.start();
    daemon.push(playTransitioned(11, 'S1', 'P9', 'DONE'));
    await waitFor(() => hub.status.getState().cursor === 11, 'the event');
    await hub.whenIdle();
    expect(hub.plays.getState().byId.P9).toBeUndefined();
    expect(hub.plays.getState().stale).toEqual({});
    expect(count(daemon, '/v1/plays/P9')).toBe(1);
  });

  it('gives up after `refreshAttempts`, tells it, and reads again at the next event', async () => {
    const daemon = populated();
    const problems: SyncProblem[] = [];
    const hub = hubOf(daemon, { refreshAttempts: 2, onProblem: (p) => problems.push(p) });
    await hub.start();
    let failing = true;
    daemon.intercept = (request) =>
      failing && request.path === '/v1/scenarios/S3'
        ? Response.json(apiError('internal', 'boom'), { status: 500 })
        : undefined;
    daemon.scenarios.push(scenario('S3'));
    daemon.push(scenarioArchived(11, 'S3'));
    await waitFor(() => problems.length === 1, 'the give up');
    await hub.whenIdle();
    expect(problems[0]).toMatchObject({ kind: 'refresh_failed', store: 'scenarios', key: 'S3' });
    expect(hub.scenarios.getState().stale).toEqual({ S3: 1 });
    const asked = count(daemon, '/v1/scenarios/S3');
    await tick();
    expect(count(daemon, '/v1/scenarios/S3')).toBe(asked);
    expect(hub.status.getState().phase).toBe('live');

    failing = false;
    daemon.push(scenarioArchived(12, 'S3'));
    await waitFor(() => hub.scenarios.getState().stale.S3 === undefined, 'the read');
    expect(hub.scenarios.getState().byId.S3).toBeDefined();
  });
});

describe('DaemonStores: resync', () => {
  it('reads every snapshot again, keeps the recent events and needs a live hub', async () => {
    const daemon = populated();
    const hub = hubOf(daemon);
    await expect(hub.resync()).rejects.toThrow('not live');
    await hub.start();
    daemon.push(playTransitioned(11, 'S1', 'P1', 'EXECUTING'));
    await waitFor(() => hub.status.getState().cursor === 11, 'the event');
    daemon.scenarios.push(scenario('S4'));
    await hub.resync();
    expect(hub.scenarios.getState().byId.S4).toBeDefined();
    expect(hub.events.getState().events.map((e) => e.id)).toEqual([11]);
    expect(hub.status.getState().cursor).toBe(11);
    expect(hub.scenarios.getState().lastEventId).toBe(11);
  });
});

describe('acceptance: a play built only from events equals the REST state', () => {
  it('matches `GET /v1/plays/:id` at the end of the play', async () => {
    const daemon = new FakeDaemon();
    daemon.head = 0;
    daemon.scenarios = [scenario('S1')];
    const hub = hubOf(daemon, { demands: 'none' });
    await hub.start();
    const log = [
      playCreated(1, 'S1', 'P1'),
      playTransitioned(2, 'S1', 'P1', 'PLANNING', { plan_reviews: 0 }),
      playTransitioned(3, 'S1', 'P1', 'EXECUTING', { plan_reviews: 1 }),
      playTransitioned(4, 'S1', 'P1', 'DONE', { plan_reviews: 1 }),
    ];
    daemon.push(...log);
    await waitFor(() => hub.status.getState().cursor === 4, 'the play to end');
    // What the daemon's tables hold at the end of the play: the timestamps are the events'.
    setPlay(
      daemon,
      play('P1', 'S1', {
        state: 'DONE',
        counters: { plan_reviews: 1 },
        createdAt: log[0]?.timestamp ?? 0,
        updatedAt: log[3]?.timestamp ?? 0,
        finishedAt: log[3]?.timestamp ?? 0,
      }),
    );
    const client = new ApiClient({
      url: 'http://127.0.0.1:1',
      token: 'test-token',
      fetch: daemon.fetch,
      timeoutMs: 0,
    });
    const rest = await client.call(API_ROUTES.getPlay, { params: { playId: 'P1' } });
    expect(hub.plays.getState().byId.P1).toEqual(rest.play);
    // A client that starts after the play ended reads the same record from its snapshot.
    const late = hubOf(daemon, { plays: 'all', demands: 'none' });
    await late.start();
    expect(late.plays.getState().byId.P1).toEqual(rest.play);
  });
});
