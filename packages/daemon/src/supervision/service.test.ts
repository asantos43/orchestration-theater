// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { SCRIPT_KEY, type EventEnvelope } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { buildDaemonRegistries } from '../registries.js';
import { ToolFailure, ToolHandlers, type ToolCall } from '../mcp/handlers.js';
import type { SituationSink } from '../situations.js';
import { DEFAULT_SUPERVISION, type SupervisionSettings } from './config.js';
import { formatNotice, SupervisionService } from './service.js';

const registries = buildDaemonRegistries();
const WORKTREE = '/work/p1';

function demand(id: string, inputs: string[] = [], expectedFiles: string[] = [`${id}.txt`]) {
  return {
    id,
    title: id,
    description: id,
    dependsOn: [],
    contract: { inputs, outputs: [] },
    expectedFiles,
    complexity: 'low' as const,
    acceptanceCriteria: [],
    verify: [],
    verifyWaiver: 'a test',
  };
}

function scriptValue(description = 'v1') {
  return {
    contracts: [{ id: 'c1', title: 'c1', description }],
    demands: [demand('a'), demand('b', ['c1'])],
  };
}

interface Recorded {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface Rig {
  readonly service: SupervisionService;
  readonly store: InMemoryStore;
  readonly recorded: Recorded[];
  readonly submitted: string[];
  readonly cancelled: string[];
  readonly clock: FakeClock;
  settings: SupervisionSettings;
  bind(): Promise<void>;
  of(type: string): Record<string, unknown>[];
  tool(name: string, input: unknown, directorId?: string): Promise<unknown>;
  event(type: string, payload: Record<string, unknown>, attemptId?: string): EventEnvelope;
}

async function attempt(store: InMemoryStore, id: string, demandId: string, state = 'executing') {
  const playId = id.split('/')[0] ?? 'p1';
  await store.attempts.put({
    attemptId: id,
    playId,
    demandId,
    attempt: 1,
    client: 'fake',
    profile: 'one',
    state: state as 'executing',
    cause: null,
    sessionId: 'sess',
    worktree: WORKTREE,
    branch: `attempt/${demandId}`,
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    freeResumes: 0,
  });
}

async function rig(patch: Partial<SupervisionSettings> = {}): Promise<Rig> {
  const clock = new FakeClock(1_000);
  const store = new InMemoryStore({ clock });
  for (const id of ['s1', 's2']) {
    await store.scenarios.create({
      id,
      kind: 'project',
      flowId: 'play.default',
      name: id,
      folder: `/work/${id}`,
      baseBranch: 'main',
    });
  }
  for (const [id, scenarioId] of [
    ['p1', 's1'],
    ['p9', 's2'],
  ] as const) {
    await store.plays.create({
      id,
      scenarioId,
      need: 'need',
      flowId: 'play.default',
      flowVersion: 1,
      state: 'EXECUTING',
      counters: {},
    });
  }
  await store.blackboard.put({ playId: 'p1', key: SCRIPT_KEY, value: scriptValue() });
  await attempt(store, 'p1/a/1', 'a');
  await attempt(store, 'p1/b/1', 'b');
  await attempt(store, 'p9/z/1', 'z');
  await attempt(store, 'p1/old/1', 'old', 'completed');
  const recorded: Recorded[] = [];
  const situations: SituationSink = {
    record: (type, payload) => {
      recorded.push({ type, payload: payload });
    },
  };
  const submitted: string[] = [];
  const cancelled: string[] = [];
  const state = { settings: { ...DEFAULT_SUPERVISION, ...patch } };
  let n = 0;
  const service = new SupervisionService({
    store,
    settings: () => state.settings,
    demandTimeoutMs: () => 100_000,
    situations,
    clock,
    logger: { warn: () => undefined },
    newId: () => {
      n += 1;
      return `n${String(n)}`;
    },
  });
  let counter = 0;
  const handle: Rig = {
    service,
    store,
    recorded,
    submitted,
    cancelled,
    clock,
    get settings() {
      return state.settings;
    },
    set settings(value: SupervisionSettings) {
      state.settings = value;
    },
    bind: () =>
      service.bind({
        directors: {
          ensure: () => Promise.resolve(),
          scenarioOf: (id: string) => (id === 'director-1' ? 's1' : undefined),
        },
        dispatcher: {
          submit: (input: { text: string }) => {
            submitted.push(input.text);
            return Promise.resolve();
          },
        } as never,
        hub: {
          follow: () =>
            ({
              [Symbol.asyncIterator]: () => ({
                next: () => Promise.resolve({ done: true as const, value: undefined }),
              }),
            }) as never,
        },
        cancelAttempt: (id: string) => {
          cancelled.push(id);
          return Promise.resolve();
        },
      }),
    of: (type) => recorded.filter((r) => r.type === type).map((r) => r.payload),
    tool: async (name, input, directorId = 'director-1') => {
      const handlers = service.register(new ToolHandlers());
      const tool = registries.tools.get(name);
      const run = handlers.get(name);
      if (tool === undefined || run === undefined) throw new Error(`no tool ${name}`);
      const call = {
        tool,
        input,
        caller: { role: 'director', attemptId: directorId, record: () => Promise.resolve() },
      } as unknown as ToolCall;
      return await run(call);
    },
    event: (type, payload, attemptId = 'p1/a/1') => {
      counter += 1;
      return {
        id: counter,
        timestamp: counter,
        type,
        schemaVersion: 1,
        payload,
        playId: attemptId.split('/')[0],
        attemptId,
      } as EventEnvelope;
    },
  };
  return handle;
}

function failure(value: unknown, code: string): ToolFailure {
  expect(value).toBeInstanceOf(ToolFailure);
  expect((value as ToolFailure).code).toBe(code);
  return value as ToolFailure;
}

const A = { role: 'actor' as const, playId: 'p1', demandId: 'a', attemptId: 'p1/a/1' };

async function edit(r: Rig, path: string, attemptId = 'p1/a/1'): Promise<void> {
  await r.service.handle(r.event('permission.asked', { kind: 'edit', paths: [path] }, attemptId));
}

describe('the tools of the Director', () => {
  it('registers the four tools and skips a name that already has a handler', () => {
    const handlers = new ToolHandlers();
    handlers.register('broadcast', () => 'mine');
    const service = new SupervisionService({
      store: new InMemoryStore({ clock: new FakeClock(0) }),
      settings: () => DEFAULT_SUPERVISION,
      demandTimeoutMs: () => 1,
      situations: undefined,
      clock: new FakeClock(0),
      logger: { warn: () => undefined },
    });
    service.register(handlers);
    for (const name of ['warn_actor', 'redirect_actor', 'request_status']) {
      expect(handlers.has(name)).toBe(true);
    }
    expect(handlers.get('broadcast')?.({} as ToolCall)).toBe('mine');
  });

  it('refuses before the daemon is bound, outside a scenario Director and with the supervision off', async () => {
    const r = await rig();
    failure(await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'x' }), 'not_ready');
    await r.bind();
    failure(
      await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'x' }, 'someone'),
      'no_scenario',
    );
    r.settings = { ...r.settings, mode: 'log' };
    failure(await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'x' }), 'supervision_off');
    await r.service.unbind();
  });

  it('warn_actor queues a notice that reaches the next tool reply, marked as the Director', async () => {
    const r = await rig();
    await r.bind();
    expect(await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'stay inside' })).toMatchObject({
      ok: true,
      via: 'tool_reply',
    });
    const [notice, ...rest] = await r.service.noticesFor(A);
    expect(rest).toEqual([]);
    expect(notice).toBe(formatNotice({ kind: 'warn', text: 'stay inside' }));
    expect(notice).toContain('[Director supervision, warning');
    expect(notice).toContain('stay inside');
    expect(await r.service.noticesFor(A)).toEqual([]);
    expect(r.of('supervision.warning').map((p) => p.reason)).toEqual(['queued', 'delivered']);
    await r.service.unbind();
  });

  it('warn_actor refuses an attempt of another scenario, one that is not running, and one past the limit', async () => {
    const r = await rig({ max_warnings_per_demand: 1 });
    await r.bind();
    failure(await r.tool('warn_actor', { attemptId: 'p9/z/1', text: 'x' }), 'not_found');
    failure(await r.tool('warn_actor', { attemptId: 'nope', text: 'x' }), 'not_found');
    failure(await r.tool('warn_actor', { attemptId: 'p1/old/1', text: 'x' }), 'not_running');
    expect(await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'one' })).toMatchObject({
      ok: true,
    });
    failure(await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'two' }), 'limit_reached');
    expect(r.of('supervision.limit_reached')).toMatchObject([
      { limit: 'max_warnings_per_demand', demandId: 'a', max: 1 },
    ]);
    await r.service.unbind();
  });

  it('noticesFor adds nothing with the supervision off', async () => {
    const r = await rig();
    await r.bind();
    await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'x' });
    r.settings = { ...r.settings, mode: 'off' };
    expect(await r.service.noticesFor(A)).toEqual([]);
    await r.service.unbind();
  });

  it('redirect_actor needs the mode redirect; then it cancels and the relaunch carries the text once', async () => {
    const warn = await rig();
    await warn.bind();
    failure(await warn.tool('redirect_actor', { attemptId: 'p1/a/1', text: 'x' }), 'mode_too_low');
    await warn.service.unbind();

    const r = await rig({ mode: 'redirect' });
    await r.bind();
    expect(
      await r.tool('redirect_actor', { attemptId: 'p1/a/1', text: 'start over' }),
    ).toMatchObject({
      ok: true,
      via: 'relaunch',
    });
    expect(r.cancelled).toEqual(['p1/a/1']);
    expect(r.of('supervision.redirect')).toMatchObject([{ demandId: 'a', text: 'start over' }]);
    // a redirect is not put in a tool reply
    expect(await r.service.noticesFor(A)).toEqual([]);
    expect(r.service.redirectReason('p1/a/1')).toBe('Redirected by the Director: start over');
    expect(r.service.redirectReason('p1/a/1')).toBeUndefined();
    expect(r.service.redirectFeedback('p1', 'a')).toBe('Redirected by the Director: start over');
    expect(r.service.redirectFeedback('p1', 'a')).toBeUndefined();
    await r.service.unbind();
  });

  it('with delivery relaunch and mode redirect a warning becomes a redirect', async () => {
    const r = await rig({ mode: 'redirect', delivery: 'relaunch' });
    await r.bind();
    expect(await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'again' })).toMatchObject({
      via: 'relaunch',
    });
    expect(r.cancelled).toEqual(['p1/a/1']);
    await r.service.unbind();
  });

  it('request_status queues the request, records the event and respects its switch and limit', async () => {
    const r = await rig({ max_warnings_per_demand: 1 });
    await r.bind();
    expect(await r.tool('request_status', { attemptId: 'p1/a/1' })).toMatchObject({ ok: true });
    expect(r.of('supervision.status_requested')).toMatchObject([{ demandId: 'a' }]);
    const [text] = await r.service.noticesFor(A);
    expect(text).toContain('status request');
    expect(text).toContain('"state": "status"');
    failure(await r.tool('request_status', { attemptId: 'p1/a/1' }), 'limit_reached');
    expect(r.of('supervision.limit_reached')).toMatchObject([{ limit: 'status_request' }]);
    r.settings = { ...r.settings, status_request: 'off' };
    failure(await r.tool('request_status', { attemptId: 'p1/a/1' }), 'status_request_off');
    await r.service.unbind();
  });

  it('the answer of an Actor to a status request reaches the Director as data', async () => {
    const r = await rig();
    await r.bind();
    await edit(r, `${WORKTREE}/a.txt`); // the attempt is discovered, nothing outside the demand
    await r.service.handle(
      r.event('attempt.submitted', {
        output: { result: { state: 'status', summary: 'half done' } },
      }),
    );
    expect(r.submitted).toHaveLength(1);
    expect(r.submitted[0]?.startsWith('#ot-status')).toBe(true);
    expect(r.submitted[0]).toContain('half done');
    await r.service.handle(r.event('attempt.submitted', { output: { result: { state: 'done' } } }));
    expect(r.submitted).toHaveLength(1);
    await r.service.unbind();
  });

  it('broadcast warns every watched Actor of the play, once per limit, and can be switched off', async () => {
    const r = await rig({ max_warnings_per_demand: 1 });
    await r.bind();
    await edit(r, `${WORKTREE}/a.txt`, 'p1/a/1');
    await edit(r, `${WORKTREE}/b.txt`, 'p1/b/1');
    expect(await r.tool('broadcast', { text: 'all hands' })).toMatchObject({
      ok: true,
      recipients: 2,
    });
    expect(r.of('supervision.broadcast')).toMatchObject([
      { recipients: 2, attemptIds: ['p1/a/1', 'p1/b/1'] },
    ]);
    const [fromA] = await r.service.noticesFor(A);
    expect(fromA).toContain('broadcast to every Actor of the play');
    failure(await r.tool('broadcast', { text: 'again' }), 'limit_reached');
    expect(r.of('supervision.limit_reached')).toMatchObject([
      { limit: 'broadcast', demandId: null },
    ]);
    failure(await r.tool('broadcast', { text: 'x', play: 'p7' }), 'not_found');
    r.settings = { ...r.settings, broadcast: 'off' };
    failure(await r.tool('broadcast', { text: 'x' }), 'broadcast_off');
    await r.service.unbind();
  });
});

describe('the signals', () => {
  it('an edit outside the demand calls the Director with the supervise prompt and records the signal', async () => {
    const r = await rig();
    await r.bind();
    await edit(r, `${WORKTREE}/a.txt`);
    expect(r.submitted).toEqual([]);
    await edit(r, `${WORKTREE}/other.txt`);
    expect(r.submitted).toHaveLength(1);
    expect(r.submitted[0]).toContain('#ot-signal: outside_demand');
    expect(r.of('supervision.signal')).toMatchObject([
      {
        signal: 'outside_demand',
        demandId: 'a',
        outcome: 'director_called',
        attemptIds: ['p1/a/1'],
      },
    ]);
    await r.service.unbind();
  });

  it('with mode log the Director is not called; with mode off nothing is recorded', async () => {
    const log = await rig({ mode: 'log' });
    await log.bind();
    await edit(log, `${WORKTREE}/other.txt`);
    expect(log.submitted).toEqual([]);
    expect(log.of('supervision.signal')).toMatchObject([{ outcome: 'logged' }]);
    await log.service.unbind();

    const off = await rig({ mode: 'off' });
    await off.bind();
    await edit(off, `${WORKTREE}/other.txt`);
    expect(off.recorded).toEqual([]);
    await off.service.unbind();
  });

  it('the time of the demand: budget_fraction calls the Director once', async () => {
    const r = await rig();
    await r.bind();
    await edit(r, `${WORKTREE}/a.txt`);
    await r.clock.advance(90_000);
    await edit(r, `${WORKTREE}/a.txt`);
    expect(r.of('supervision.signal')).toMatchObject([{ signal: 'budget_fraction' }]);
    await edit(r, `${WORKTREE}/a.txt`);
    expect(r.of('supervision.signal')).toHaveLength(1);
    await r.service.unbind();
  });

  it('a changed contract warns the dependents with no call to the Director', async () => {
    const r = await rig();
    await r.bind();
    await edit(r, `${WORKTREE}/a.txt`, 'p1/a/1');
    await edit(r, `${WORKTREE}/b.txt`, 'p1/b/1');
    await r.store.blackboard.put({ playId: 'p1', key: SCRIPT_KEY, value: scriptValue('v2') });
    await r.service.handle(r.event('demand.transitioned', { to: 'executing' }, 'p1/a/1'));
    expect(r.submitted).toEqual([]);
    expect(r.of('supervision.signal')).toMatchObject([
      { signal: 'contract_changed', outcome: 'notified', demandId: 'b', attemptIds: ['p1/b/1'] },
    ]);
    const [notice] = await r.service.noticesFor({ ...A, demandId: 'b', attemptId: 'p1/b/1' });
    expect(notice).toContain('contract change');
    expect(notice).toContain('c1');
    expect(await r.service.noticesFor(A)).toEqual([]);
    await r.service.unbind();
  });

  it('an attempt that ends without the notice drops it, with delivered false', async () => {
    const r = await rig();
    await r.bind();
    await edit(r, `${WORKTREE}/a.txt`);
    await r.tool('warn_actor', { attemptId: 'p1/a/1', text: 'late' });
    await r.service.handle(r.event('attempt.cancelled', { reason: 'x' }));
    expect(r.of('supervision.warning').at(-1)).toMatchObject({
      delivered: false,
      reason: 'attempt_ended',
    });
    expect(await r.service.noticesFor(A)).toEqual([]);
    await r.service.unbind();
  });

  it('the end of the play settles every attempt it still watched', async () => {
    const r = await rig();
    await r.bind();
    await edit(r, `${WORKTREE}/b.txt`, 'p1/b/1');
    await r.tool('warn_actor', { attemptId: 'p1/b/1', text: 'late' });
    await r.service.handle({
      ...r.event('play.transitioned', { to: 'DONE' }),
      attemptId: undefined,
    });
    expect(r.of('supervision.warning').at(-1)).toMatchObject({
      delivered: false,
      reason: 'attempt_ended',
    });
    await r.service.unbind();
  });
});
