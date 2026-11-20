// SPDX-License-Identifier: MPL-2.0
import { ApiPlaySchema, type ApiEventEnvelope } from '@otheater/protocol';
import { createStore } from 'zustand/vanilla';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applyEvents,
  clearStale,
  createDemandsReducer,
  createRecentEventsReducer,
  initialDecisions,
  initialDemands,
  initialPlays,
  initialQuotas,
  initialRecentEvents,
  initialScenarios,
  installDecisions,
  installDemands,
  installPlays,
  installQuotas,
  installRecentEvents,
  installScenarios,
  markStale,
  reduceDecisions,
  reducePlays,
  reduceQuotas,
  reduceScenarios,
  selectOpenPlays,
  selectPendingDecisions,
  selectPlaysOf,
  selectQuotas,
  selectRecentEvents,
  selectScenarios,
  settleDecisions,
  settleDemands,
  settlePlay,
  settleQuota,
  settleScenario,
  trackPlay,
  waitKey,
  type EventReducer,
  type SyncFields,
} from './index.js';
import {
  decision,
  demand,
  event,
  play,
  playCreated,
  playTransitioned,
  quota,
  scenario,
} from './fixtures.test-support.js';

describe('core', () => {
  interface Counter extends SyncFields {
    readonly total: number;
  }
  const base: Counter = { loaded: true, lastEventId: 0, stale: {}, total: 0 };
  const sum: EventReducer<Counter> = (state, e) =>
    e.type === 'x.added' ? { ...state, total: state.total + 1 } : state;

  it('ignores an event whose id is not above the last one applied', () => {
    const once = applyEvent(base, event(3, 'x.added', {}), sum);
    expect(once.total).toBe(1);
    expect(once.lastEventId).toBe(3);
    expect(applyEvent(once, event(3, 'x.added', {}), sum)).toBe(once);
    expect(applyEvent(once, event(2, 'x.added', {}), sum)).toBe(once);
  });

  it('keeps the same state, and the same cursor, for an event that is not its business', () => {
    expect(applyEvent(base, event(5, 'other.thing', {}), sum)).toBe(base);
  });

  it('applies a sequence in order', () => {
    const events = [event(1, 'x.added', {}), event(2, 'other.t', {}), event(4, 'x.added', {})];
    const result = applyEvents(base, events, sum);
    expect(result.total).toBe(2);
    expect(result.lastEventId).toBe(4);
  });

  it('raises the revision on every mark and clears only the one a read saw', () => {
    const one = markStale(base, 'k');
    const two = markStale(one, 'k');
    expect(two.stale).toEqual({ k: 2 });
    expect(clearStale(two, 'k', 1)).toBe(two);
    expect(clearStale(two, 'k', 2).stale).toEqual({});
  });
});

describe('scenarios', () => {
  const start = installScenarios([scenario('S1'), scenario('S2', { createdAt: 5 })], 10);

  it('installs a snapshot with its cursor and orders the list', () => {
    expect(start.loaded).toBe(true);
    expect(start.lastEventId).toBe(10);
    expect(selectScenarios(start).map((s) => s.id)).toEqual(['S2', 'S1']);
  });

  it('puts the Director to sleep and wakes it', () => {
    const slept = applyEvent(
      start,
      event(
        11,
        'scenario.director_slept',
        { scenarioId: 'S1', idleMs: 60_000 },
        { scenarioId: 'S1' },
      ),
      reduceScenarios,
    );
    expect(slept.byId.S1?.directorState).toBe('asleep');
    expect(slept.byId.S1?.updatedAt).toBe(1_700_000_000_011);
    const woke = applyEvent(
      slept,
      event(12, 'scenario.director_woke', { scenarioId: 'S1', sleptAt: 1 }, { scenarioId: 'S1' }),
      reduceScenarios,
    );
    expect(woke.byId.S1?.directorState).toBe('active');
  });

  it('marks a scenario it does not know, or a payload it cannot read, to be read again', () => {
    const born = applyEvent(
      start,
      event(
        11,
        'scenario.created',
        { scenarioId: 'S9', type: 'project', flow: 'f', name: 'n', folder: '/f' },
        { scenarioId: 'S9' },
      ),
      reduceScenarios,
    );
    expect(born.stale).toEqual({ S9: 1 });
    const broken = applyEvent(
      start,
      event(11, 'scenario.director_slept', { nope: true }, { scenarioId: 'S1' }),
      reduceScenarios,
    );
    expect(broken.stale).toEqual({ S1: 1 });
  });

  it('settles a read: the record replaces, null removes, a newer mark keeps the key stale', () => {
    const marked = markStale(markStale(start, 'S1'), 'S1');
    const read = settleScenario(marked, 'S1', 1, scenario('S1', { name: 'renamed' }));
    expect(read.byId.S1?.name).toBe('renamed');
    expect(read.stale).toEqual({ S1: 2 });
    expect(settleScenario(read, 'S1', 2, null).byId.S1).toBeUndefined();
    expect(settleScenario(read, 'S1', 2, null).stale).toEqual({});
  });
});

describe('plays', () => {
  const sequence = [
    playCreated(1, 'S1', 'P1'),
    playTransitioned(2, 'S1', 'P1', 'PLANNING', { plan_reviews: 0 }),
    playTransitioned(3, 'S1', 'P1', 'EXECUTING', { plan_reviews: 1 }),
    playTransitioned(4, 'S1', 'P1', 'DONE', { plan_reviews: 1 }),
  ];

  it('builds a play from its events: created, then each move', () => {
    const state = applyEvents(initialPlays(), sequence, reducePlays);
    expect(state.byId.P1).toEqual({
      id: 'P1',
      scenarioId: 'S1',
      need: 'a need',
      flowId: 'software',
      flowVersion: 1,
      state: 'DONE',
      counters: { plan_reviews: 1 },
      parentPlayId: null,
      createdAt: 1_700_000_000_001,
      updatedAt: 1_700_000_000_004,
      finishedAt: 1_700_000_000_004,
    });
    expect(ApiPlaySchema.safeParse(state.byId.P1).success).toBe(true);
    expect(state.lastEventId).toBe(4);
  });

  it('leaves `finishedAt` null until a final state, and sets it for DONE or CANCELLED', () => {
    const mid = applyEvents(initialPlays(), sequence.slice(0, 3), reducePlays);
    expect(mid.byId.P1?.finishedAt).toBeNull();
    const cancelled = applyEvents(mid, [playTransitioned(5, 'S1', 'P1', 'CANCELLED')], reducePlays);
    expect(cancelled.byId.P1?.finishedAt).toBe(1_700_000_000_005);
    expect(selectOpenPlays(mid).map((p) => p.id)).toEqual(['P1']);
    expect(selectOpenPlays(cancelled)).toEqual([]);
  });

  it('gives the same state when the same sequence is applied twice', () => {
    const once = applyEvents(initialPlays(), sequence, reducePlays);
    const twice = applyEvents(once, sequence, reducePlays);
    expect(twice).toBe(once);
    expect(twice).toEqual(once);
  });

  it('marks a move of a play it never saw, or an unreadable one, to be read again', () => {
    const state = applyEvent(initialPlays(), playTransitioned(2, 'S1', 'P7', 'DONE'), reducePlays);
    expect(state.stale).toEqual({ P7: 1 });
    const broken = applyEvent(
      initialPlays(),
      event(2, 'play.created', { wrong: 1 }, { scenarioId: 'S1', playId: 'P8' }),
      reducePlays,
    );
    expect(broken.stale).toEqual({ P8: 1 });
  });

  it('keeps a play that exists when `play.created` comes again', () => {
    const first = sequence[0];
    if (first === undefined) throw new Error('no event');
    const state = applyEvents(initialPlays(), [first], reducePlays);
    const again = reducePlays(state, { ...first, id: 9 });
    expect(again).toBe(state);
  });

  it('converges when a snapshot newer than its cursor is replayed with the events above it', () => {
    const finished = play('P1', 'S1', {
      state: 'DONE',
      counters: { plan_reviews: 1 },
      createdAt: 1_700_000_000_001,
      updatedAt: 1_700_000_000_004,
      finishedAt: 1_700_000_000_004,
    });
    // The snapshot already holds the end of the play, but is installed at cursor 1.
    const replayed = applyEvents(installPlays([finished], 1), sequence.slice(1), reducePlays);
    expect(replayed.byId.P1).toEqual(finished);
  });

  it('selects by scenario and settles a read', () => {
    const state = installPlays([play('P1', 'S1'), play('P2', 'S2')], 0);
    expect(selectPlaysOf(state, 'S1').map((p) => p.id)).toEqual(['P1']);
    const gone = settlePlay(markStale(state, 'P2'), 'P2', 1, null);
    expect(gone.byId.P2).toBeUndefined();
    expect(gone.stale).toEqual({});
  });
});

describe('demands', () => {
  const parts = { demands: [demand('P1', 'D1')], stages: [] };
  const start = installDemands([{ playId: 'P1', parts }], 5);

  it('marks a tracked play whose machine moved, and not one it does not follow', () => {
    const moved = applyEvent(
      start,
      playTransitioned(6, 'S1', 'P1', 'EXECUTING'),
      createDemandsReducer(),
    );
    expect(moved.stale).toEqual({ P1: 1 });
    const other = applyEvent(
      start,
      playTransitioned(6, 'S1', 'P2', 'EXECUTING'),
      createDemandsReducer(),
    );
    expect(other).toBe(start);
  });

  it('follows a new play only when `followNewPlays` is on', () => {
    const created = playCreated(6, 'S1', 'P2');
    expect(applyEvent(start, created, createDemandsReducer()).stale).toEqual({ P2: 1 });
    expect(applyEvent(start, created, createDemandsReducer({ followNewPlays: false }))).toBe(start);
  });

  it('keeps what waits for an Executor from `demand.waiting` to `demand.resumed`', () => {
    const waiting = event(
      6,
      'demand.waiting',
      {
        scenarioId: 'S1',
        playId: 'P1',
        demandId: 'D1',
        role: 'worker',
        on: [],
        until: null,
        message: 'no executor',
        since: 1,
        holdsSlot: false,
      },
      { scenarioId: 'S1', playId: 'P1' },
    );
    const held = applyEvent(start, waiting, createDemandsReducer());
    expect(Object.keys(held.waiting)).toEqual([waitKey('P1', 'D1')]);
    const resumed = event(
      7,
      'demand.resumed',
      {
        scenarioId: 'S1',
        playId: 'P1',
        demandId: 'D1',
        role: 'worker',
        outcome: 'selected',
        executor: 'm-high@codex/main',
        waitedMs: 5,
        holdsSlot: false,
      },
      { scenarioId: 'S1', playId: 'P1' },
    );
    expect(applyEvent(held, resumed, createDemandsReducer()).waiting).toEqual({});
  });

  it('tracks a play on request and settles its read', () => {
    const tracked = trackPlay(initialDemands(), 'P3');
    expect(tracked.stale).toEqual({ P3: 1 });
    expect(trackPlay(start, 'P1')).toBe(start);
    const settled = settleDemands(tracked, 'P3', 1, parts);
    expect(settled.byPlay.P3).toEqual(parts);
    expect(settled.stale).toEqual({});
  });
});

describe('decisions', () => {
  const start = installDecisions(
    [{ scenarioId: 'S1', decisions: [decision('B', 'S1', 20), decision('A', 'S1', 10)] }],
    4,
  );

  it('keeps the pending ones oldest first', () => {
    expect(selectPendingDecisions(start).map((d) => d.id)).toEqual(['A', 'B']);
  });

  it('marks the scenario when something moved in it', () => {
    expect(
      applyEvent(start, playTransitioned(5, 'S1', 'P1', 'AWAITING_PRODUCER'), reduceDecisions)
        .stale,
    ).toEqual({ S1: 1 });
    const chat = event(6, 'scenario.chat_transitioned', { scenarioId: 'S2' });
    expect(applyEvent(start, chat, reduceDecisions).stale).toEqual({ S2: 1 });
    expect(applyEvent(start, event(7, 'quota.updated', {}), reduceDecisions)).toBe(start);
  });

  it('settles a read: the list replaces what the scenario had', () => {
    const marked = markStale(start, 'S1');
    const settled = settleDecisions(marked, 'S1', 1, [decision('C', 'S1', 30)]);
    expect(selectPendingDecisions(settled).map((d) => d.id)).toEqual(['C']);
    expect(settled.stale).toEqual({});
  });
});

describe('quotas', () => {
  const profile = 'codex/main';
  const window = { window: '5h', usedPercent: 40, resetsAt: 10, observedAt: 7 };

  it('applies a reading at once and marks the account to be read again', () => {
    const state = applyEvent(
      initialQuotas(),
      event(1, 'quota.updated', { profile, state: 'ok', source: 'probe', windows: [window] }),
      reduceQuotas,
    );
    expect(state.byProfile[profile]).toMatchObject({
      state: 'ok',
      authorizes: true,
      observedAt: 7,
      windows: [{ window: '5h', usedPercent: 40, source: 'probe', fresh: true }],
    });
    expect(state.stale).toEqual({ [profile]: 1 });
  });

  it('goes through near limit, exhausted and restored', () => {
    let state = installQuotas(
      [quota(profile, { windows: [{ ...window, source: 'probe', fresh: true }] })],
      1,
    );
    state = applyEvent(
      state,
      event(2, 'quota.near_limit', {
        profile,
        window: '5h',
        usedPercent: 85,
        resetsAt: 10,
        thresholdPercent: 80,
      }),
      reduceQuotas,
    );
    expect(state.byProfile[profile]).toMatchObject({ state: 'near_limit', authorizes: true });
    expect(state.byProfile[profile]?.nearLimitWindow?.usedPercent).toBe(85);
    state = applyEvent(
      state,
      event(3, 'quota.exhausted', { profile, cause: 'quota', untilReset: 99, source: 'probe' }),
      reduceQuotas,
    );
    expect(state.byProfile[profile]).toMatchObject({
      state: 'exhausted',
      cause: 'quota',
      untilReset: 99,
      authorizes: false,
    });
    state = applyEvent(
      state,
      event(4, 'quota.restored', { profile, cause: 'quota', state: 'ok', reason: 'reset' }),
      reduceQuotas,
    );
    expect(state.byProfile[profile]).toMatchObject({
      state: 'ok',
      cause: null,
      untilReset: null,
      authorizes: true,
    });
  });

  it('treats a budget that was exceeded as an exhausted account, and removes a removed profile', () => {
    let state = applyEvent(
      installQuotas([quota(profile)], 1),
      event(2, 'budget.exceeded', {
        profile,
        executor: null,
        spentUsd: 10,
        limitUsd: 9,
        period: 'month',
        endsAt: 500,
      }),
      reduceQuotas,
    );
    expect(state.byProfile[profile]).toMatchObject({
      state: 'exhausted',
      cause: 'budget',
      untilReset: 500,
      authorizes: false,
    });
    state = applyEvent(
      state,
      event(3, 'profile.removed', {
        profileId: profile,
        loggedOut: false,
        dir: 'missing',
        secretDeleted: false,
        executorsInvalidated: [],
      }),
      reduceQuotas,
    );
    expect(state.byProfile[profile]).toBeUndefined();
    expect(state.stale).toEqual({});
  });

  it('marks an account it does not know when it is told it is restored', () => {
    const state = applyEvent(
      initialQuotas(),
      event(2, 'quota.restored', { profile, cause: 'quota', state: 'ok', reason: 'reset' }),
      reduceQuotas,
    );
    expect(state.stale).toEqual({ [profile]: 1 });
    expect(state.byProfile).toEqual({});
  });

  it('settles a read and lists by profile id', () => {
    const marked = markStale(initialQuotas(), 'b/x');
    const read = settleQuota(marked, 'b/x', 1, quota('b/x'));
    expect(read.stale).toEqual({});
    expect(selectQuotas(settleQuota(read, 'a/y', 0, quota('a/y'))).map((q) => q.profile)).toEqual([
      'a/y',
      'b/x',
    ]);
    expect(settleQuota(read, 'b/x', 0, null).byProfile['b/x']).toBeUndefined();
  });
});

describe('recent events', () => {
  const feed = (n: number): ApiEventEnvelope[] =>
    Array.from({ length: n }, (_, i) =>
      event(i + 1, i % 2 === 0 ? 'play.created' : 'whatever.new', {}),
    );

  it('keeps every type, newest first when read, up to the cap', () => {
    const reduce = createRecentEventsReducer(3);
    const state = applyEvents(installRecentEvents(0), feed(5), reduce);
    expect(state.events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(selectRecentEvents(state).map((e) => e.id)).toEqual([5, 4, 3]);
    expect(state.lastEventId).toBe(5);
  });

  it('is 500 by default and refuses a cap that makes no sense', () => {
    const state = applyEvents(initialRecentEvents(), feed(600), createRecentEventsReducer());
    expect(state.events).toHaveLength(500);
    expect(state.events[0]?.id).toBe(101);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createRecentEventsReducer(bad)).toThrow(RangeError);
    }
  });

  it('does not grow when the same events come again', () => {
    const reduce = createRecentEventsReducer(10);
    const once = applyEvents(initialRecentEvents(), feed(4), reduce);
    expect(applyEvents(once, feed(4), reduce)).toBe(once);
  });
});

describe('every store', () => {
  const unknown = event(50, 'brand.new_type', { anything: [1, 2] }, { scenarioId: 'S1' });

  it('ignores an event type it does not know, with no error and no change', () => {
    expect(applyEvent(initialScenarios(), unknown, reduceScenarios)).toEqual(initialScenarios());
    expect(applyEvent(initialPlays(), unknown, reducePlays)).toEqual(initialPlays());
    expect(applyEvent(initialDemands(), unknown, createDemandsReducer())).toEqual(initialDemands());
    expect(applyEvent(initialDecisions(), unknown, reduceDecisions)).toEqual(initialDecisions());
    expect(applyEvent(initialQuotas(), unknown, reduceQuotas)).toEqual(initialQuotas());
  });

  it('is a zustand vanilla store: it wakes a subscriber only when the state changes', () => {
    const store = createStore(() => initialPlays());
    let wakes = 0;
    store.subscribe(() => {
      wakes += 1;
    });
    const apply = (e: ApiEventEnvelope): void => {
      store.setState((s) => applyEvent(s, e, reducePlays), true);
    };
    apply(playCreated(1, 'S1', 'P1'));
    apply(playCreated(1, 'S1', 'P1'));
    apply(unknown);
    apply(playTransitioned(2, 'S1', 'P1', 'PLANNING'));
    expect(wakes).toBe(2);
  });
});
