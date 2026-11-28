// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from 'vitest';
import { questionsKey, type EventEnvelope, type NewEvent } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { buildDaemonRegistries } from '../registries.js';
import { ToolFailure, ToolHandlers, type ToolCall } from '../mcp/handlers.js';
import { DEFAULT_SUPERVISION, type SupervisionSettings } from '../supervision/config.js';
import { SupervisionChannel } from '../supervision/channel.js';
import {
  ACTOR_ANSWER_NOTICE,
  AskDirectorService,
  DEFAULT_COLLAB_ASK_DIRECTOR,
  DIRECTOR_ANSWER_NOTICE,
  hiddenAskDirectorTools,
  questionPrompt,
  type CollabAskDirectorSettings,
} from './ask-director.js';

const registries = buildDaemonRegistries();

interface Rig {
  readonly service: AskDirectorService;
  readonly store: InMemoryStore;
  readonly clock: FakeClock;
  readonly channel: SupervisionChannel;
  readonly events: NewEvent[];
  readonly prompts: string[];
  /** Calls a tool as the Actor of the demand `a` of the play `p1` (the attempt `p1/a/1`). */
  ask(question: string, signal?: AbortSignal, attemptId?: string): Promise<unknown>;
  /** Calls a tool of the Director of the scenario `s1`. */
  director(name: string, input: unknown, directorId?: string): Promise<unknown>;
  event(type: string, payload: unknown, attemptId?: string, playId?: string): EventEnvelope;
  settings: { ask: CollabAskDirectorSettings; supervision: SupervisionSettings };
}

async function attempt(
  store: InMemoryStore,
  attemptId: string,
  playId: string,
  demandId: string,
  state = 'executing',
): Promise<void> {
  await store.attempts.put({
    attemptId,
    playId,
    demandId,
    attempt: 1,
    client: 'fake',
    profile: 'one',
    state: state as 'executing',
    cause: null,
    sessionId: 'sess',
    worktree: '/work/s1/wt',
    branch: `attempt/${demandId}`,
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    freeResumes: 0,
  });
}

async function rig(
  ask: Partial<CollabAskDirectorSettings> = {},
  supervision: Partial<SupervisionSettings> = {},
): Promise<Rig> {
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
  await attempt(store, 'p1/a/1', 'p1', 'a');
  await attempt(store, 'p1/b/1', 'p1', 'b');
  await attempt(store, 'p1/old/1', 'p1', 'old', 'completed');
  await attempt(store, 'p9/z/1', 'p9', 'z');
  const settings = {
    ask: { ...DEFAULT_COLLAB_ASK_DIRECTOR, ...ask },
    supervision: { ...DEFAULT_SUPERVISION, ...supervision },
  };
  const channel = new SupervisionChannel({
    store,
    situations: undefined,
    settings: () => settings.supervision,
    newId: (() => {
      let n = 0;
      return () => `n${String((n += 1))}`;
    })(),
  });
  const events: NewEvent[] = [];
  const prompts: string[] = [];
  let ids = 0;
  const service = new AskDirectorService({
    store,
    settings: () => settings.ask,
    supervision: () => settings.supervision,
    channel,
    clock,
    logger: { warn: () => undefined },
    newId: () => `q${String((ids += 1))}`,
  });
  await service.bind({
    directors: {
      ensure: () => Promise.resolve(),
      scenarioOf: (id: string) => (id === 'director-1' ? 's1' : undefined),
    },
    dispatcher: {
      submit: (input: { text: string }) => {
        prompts.push(input.text);
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
  });
  const handlers = service.register(new ToolHandlers());
  const run = async (
    name: string,
    role: string,
    input: unknown,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const tool = registries.tools.get(name);
    const handler = handlers.get(name);
    if (tool === undefined || handler === undefined) throw new Error(`no tool ${name}`);
    const [playId = '', demandId = ''] = attemptId.split('/');
    const call: ToolCall = {
      tool,
      input,
      caller: {
        role,
        attemptId,
        sessionId: undefined,
        correlation: role === 'director' ? {} : { playId, demandId, attemptId },
        record: (event) => {
          events.push(event);
          return Promise.resolve();
        },
        signal,
      },
    };
    return await handler(call);
  };
  let counter = 0;
  return {
    service,
    store,
    clock,
    channel,
    events,
    prompts,
    settings,
    ask: (question, signal, attemptId = 'p1/a/1') =>
      run('ask_director', 'actor', { question }, attemptId, signal),
    director: (name, input, directorId = 'director-1') => run(name, 'director', input, directorId),
    event: (type, payload, attemptId = 'p1/a/1', playId = 'p1') => {
      counter += 1;
      return {
        id: counter,
        timestamp: counter,
        type,
        schemaVersion: 1,
        payload,
        playId,
        attemptId,
      } as EventEnvelope;
    },
  };
}

function failure(value: unknown, code: string): ToolFailure {
  expect(value).toBeInstanceOf(ToolFailure);
  expect((value as ToolFailure).code).toBe(code);
  return value as ToolFailure;
}

/** Waits until the question was handed to the Director (the wait has begun). */
async function handedOver(r: Rig, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(r.prompts).toHaveLength(count);
    expect(r.clock.pendingSleeps).toBeGreaterThanOrEqual(1);
  });
}

function types(r: Rig): string[] {
  return r.events.map((event) => event.type);
}

describe('ask_director', () => {
  it('hands the question to the Director and returns its answer, marked as the Director`s', async () => {
    const r = await rig();
    const asked = r.ask('which encoding does the contract want?');
    await handedOver(r);
    const prompt = r.prompts[0] ?? '';
    expect(prompt.split('\n')[0]).toBe('#ot-question');
    expect(prompt).toContain('#ot-play: p1');
    expect(prompt).toContain('#ot-attempt: p1/a/1');
    expect(prompt).toContain('#ot-demand: a');
    expect(prompt).toContain('#ot-question-id: q1');
    expect(prompt).toContain('which encoding does the contract want?');
    expect(prompt).not.toContain('relay_question');
    expect(await r.director('answer_actor', { questionId: 'q1', text: 'utf-8' })).toEqual({
      ok: true,
    });
    expect(await asked).toEqual({
      answered: true,
      questionId: 'q1',
      source: 'director',
      answer: 'utf-8',
      notice: DIRECTOR_ANSWER_NOTICE,
      remaining: 2,
    });
    expect(types(r)).toEqual(['actor.question', 'actor.answer']);
    expect(r.events[0]?.payload).toMatchObject({
      questionId: 'q1',
      demandId: 'a',
      mode: 'answer',
      number: 1,
      max: 3,
      timeoutMs: 600_000,
    });
    expect(r.events[1]?.payload).toMatchObject({ source: 'director', chars: 5, waitedMs: 0 });
    const kept = await r.store.blackboard.history('p1', questionsKey('a'));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.value).toMatchObject({ questionId: 'q1', demandId: 'a', attemptId: 'p1/a/1' });
    expect(r.service.waiting).toBe(0);
    expect(r.clock.pendingSleeps).toBe(0);
  });

  it('is refused when the mode is off, and answer_actor too', async () => {
    const r = await rig({ mode: 'off' });
    failure(await r.ask('anything?'), 'collab_off');
    failure(await r.director('answer_actor', { questionId: 'q1', text: 'x' }), 'collab_off');
    expect(r.prompts).toEqual([]);
    expect(hiddenAskDirectorTools({ ...DEFAULT_COLLAB_ASK_DIRECTOR, mode: 'off' })).toEqual([
      'ask_director',
      'answer_actor',
      'relay_question',
    ]);
    expect(hiddenAskDirectorTools(DEFAULT_COLLAB_ASK_DIRECTOR)).toEqual(['relay_question']);
    expect(hiddenAskDirectorTools({ ...DEFAULT_COLLAB_ASK_DIRECTOR, mode: 'relay' })).toEqual([]);
  });

  it('refuses answers that name no question of the scenario, or come from a non-Director', async () => {
    const r = await rig();
    const asked = r.ask('a question');
    await handedOver(r);
    failure(await r.director('answer_actor', { questionId: 'nope', text: 'x' }), 'not_found');
    // the Director of another scenario cannot answer it
    failure(
      await r.director('answer_actor', { questionId: 'q1', text: 'x' }, 'director-9'),
      'no_scenario',
    );
    expect(r.service.waiting).toBe(1);
    await r.director('answer_actor', { questionId: 'q1', text: 'ok' });
    await asked;
  });

  describe('the deadline (collab.ask_director.timeout, by the Clock)', () => {
    it('on_timeout continue: returns "no answer" and the Actor goes on', async () => {
      const r = await rig({ on_timeout: 'continue' });
      const asked = r.ask('anyone there?');
      await handedOver(r);
      await r.clock.advance(599_999);
      expect(r.service.waiting).toBe(1);
      await r.clock.advance(1);
      expect(await asked).toMatchObject({ answered: false, questionId: 'q1', reason: 'timeout' });
      expect(types(r)).toEqual(['actor.question', 'actor.question_timeout']);
      expect(r.events[1]?.payload).toMatchObject({
        onTimeout: 'continue',
        waitedMs: 600_000,
      });
      expect(r.service.waiting).toBe(0);
    });

    it('on_timeout blocked: records the blocked submit of the attempt and tells it to end', async () => {
      const r = await rig({ on_timeout: 'blocked', timeout: 1_000 });
      const asked = r.ask('anyone there?');
      await handedOver(r);
      await r.clock.advance(1_000);
      expect(await asked).toMatchObject({ answered: false, reason: 'timeout', blocked: true });
      expect(types(r)).toEqual(['actor.question', 'actor.question_timeout', 'attempt.submitted']);
      expect(r.events[1]?.payload).toMatchObject({ onTimeout: 'blocked' });
      const submitted = r.events[2];
      expect(submitted?.payload).toMatchObject({
        tool: 'submit',
        role: 'actor',
        calls: 1,
        output: {
          result: {
            state: 'blocked',
            reason: expect.stringContaining('anyone there?') as unknown,
          },
        },
      });
      expect(submitted?.payload).toMatchObject({
        playId: 'p1',
        demandId: 'a',
        attemptId: 'p1/a/1',
      });
    });

    it('a late answer after the deadline is refused (the question is gone)', async () => {
      const r = await rig({ on_timeout: 'continue', timeout: 1_000 });
      const asked = r.ask('late?');
      await handedOver(r);
      await r.clock.advance(1_000);
      await asked;
      failure(await r.director('answer_actor', { questionId: 'q1', text: 'x' }), 'not_found');
    });
  });

  describe('collab.ask_director.max_per_demand', () => {
    it('refuses the question past the limit with collab.limit_reached, and does not call the Director', async () => {
      const r = await rig({ max_per_demand: 2 });
      for (const n of [1, 2]) {
        const asked = r.ask(`question ${String(n)}`);
        await handedOver(r, n);
        await r.director('answer_actor', { questionId: `q${String(n)}`, text: 'a' });
        expect(await asked).toMatchObject({ answered: true, remaining: 2 - n });
      }
      const refused = failure(await r.ask('question 3'), 'limit_reached');
      expect(refused.details).toEqual({ limit: 'max_per_demand', max: 2 });
      expect(r.prompts).toHaveLength(2);
      expect(await r.store.blackboard.history('p1', questionsKey('a'))).toHaveLength(2);
      const limit = r.events.find((event) => event.type === 'collab.limit_reached');
      expect(limit?.payload).toEqual({
        feature: 'ask_director',
        limit: 'max_per_demand',
        demandId: 'a',
        value: 3,
        max: 2,
      });
    });

    it('counts per demand: another demand still may ask', async () => {
      const r = await rig({ max_per_demand: 1 });
      const first = r.ask('one');
      await handedOver(r);
      await r.director('answer_actor', { questionId: 'q1', text: 'a' });
      await first;
      failure(await r.ask('two'), 'limit_reached');
      const other = r.ask('three', undefined, 'p1/b/1');
      await handedOver(r, 2);
      await r.director('answer_actor', { questionId: 'q2', text: 'b' });
      expect(await other).toMatchObject({ answered: true });
    });
  });

  describe('mode relay', () => {
    it('offers the running attempts, queues a notice for the owner and returns its answer as data', async () => {
      const r = await rig({ mode: 'relay' });
      const asked = r.ask('what does beta write?');
      await handedOver(r);
      const prompt = r.prompts[0] ?? '';
      expect(prompt).toContain('`relay_question`');
      expect(prompt).toContain('attempt p1/b/1 (demand b)');
      expect(prompt).not.toContain('p1/a/1 (demand a)');
      expect(prompt).not.toContain('p1/old/1');
      expect(prompt).not.toContain('p9/z/1');
      const relayed = (await r.director('relay_question', {
        questionId: 'q1',
        attemptId: 'p1/b/1',
      })) as { ok: boolean; noticeId: string };
      expect(relayed.ok).toBe(true);
      const notices = await r.channel.pending('p1', 'b', 'p1/b/1');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: 'question', noticeId: relayed.noticeId });
      expect(notices[0]?.text).toContain('what does beta write?');
      expect(notices[0]?.text).toContain('"questionId": "q1"');
      // an Actor the question was not relayed to cannot answer it
      r.service.handle(
        r.event(
          'attempt.submitted',
          { output: { result: { state: 'answer', questionId: 'q1', text: 'forged' } } },
          'p1/old/1',
        ),
      );
      expect(r.service.waiting).toBe(1);
      // a status answer of the owner is not an answer to the question
      r.service.handle(
        r.event(
          'attempt.submitted',
          { output: { result: { state: 'status', summary: 'busy' } } },
          'p1/b/1',
        ),
      );
      expect(r.service.waiting).toBe(1);
      r.service.handle(
        r.event(
          'attempt.submitted',
          { output: { result: { state: 'answer', questionId: 'q1', text: 'a file' } } },
          'p1/b/1',
        ),
      );
      expect(await asked).toEqual({
        answered: true,
        questionId: 'q1',
        source: 'actor',
        answer: 'a file',
        notice: ACTOR_ANSWER_NOTICE,
        remaining: 2,
      });
      expect(r.events[1]?.type).toBe('actor.answer');
      expect(r.events[1]?.payload).toMatchObject({ source: 'actor' });
    });

    it('lets the Director answer by itself in the mode relay too', async () => {
      const r = await rig({ mode: 'relay' });
      const asked = r.ask('q');
      await handedOver(r);
      await r.director('answer_actor', { questionId: 'q1', text: 'mine' });
      expect(await asked).toMatchObject({ source: 'director', answer: 'mine' });
    });

    it('refuses a relay to the asker, to another play, to an attempt that ended or unknown', async () => {
      const r = await rig({ mode: 'relay' });
      const asked = r.ask('q');
      await handedOver(r);
      failure(
        await r.director('relay_question', { questionId: 'q1', attemptId: 'p1/a/1' }),
        'self',
      );
      failure(
        await r.director('relay_question', { questionId: 'q1', attemptId: 'p9/z/1' }),
        'not_found',
      );
      failure(
        await r.director('relay_question', { questionId: 'q1', attemptId: 'p1/nope/1' }),
        'not_found',
      );
      failure(
        await r.director('relay_question', { questionId: 'q1', attemptId: 'p1/old/1' }),
        'not_running',
      );
      failure(
        await r.director('relay_question', { questionId: 'nope', attemptId: 'p1/b/1' }),
        'not_found',
      );
      expect(await r.channel.pending('p1', 'b', 'p1/b/1')).toHaveLength(0);
      await r.director('answer_actor', { questionId: 'q1', text: 'x' });
      await asked;
    });

    it('is refused when the mode is not relay, or the channel of the supervision is off', async () => {
      const answerMode = await rig({ mode: 'answer' });
      failure(
        await answerMode.director('relay_question', { questionId: 'q1', attemptId: 'p1/b/1' }),
        'relay_off',
      );
      const noChannel = await rig({ mode: 'relay' }, { mode: 'off' });
      failure(
        await noChannel.director('relay_question', { questionId: 'q1', attemptId: 'p1/b/1' }),
        'supervision_off',
      );
      const logOnly = await rig({ mode: 'relay' }, { mode: 'log' });
      failure(
        await logOnly.director('relay_question', { questionId: 'q1', attemptId: 'p1/b/1' }),
        'supervision_off',
      );
    });

    it('a relay that gets no answer ends at the deadline like any question', async () => {
      const r = await rig({ mode: 'relay', on_timeout: 'continue', timeout: 5_000 });
      const asked = r.ask('q');
      await handedOver(r);
      await r.director('relay_question', { questionId: 'q1', attemptId: 'p1/b/1' });
      await r.clock.advance(5_000);
      expect(await asked).toMatchObject({ answered: false, reason: 'timeout' });
    });
  });

  describe('cancellation', () => {
    it('stops waiting when the MCP request is cancelled, and releases the timer', async () => {
      const r = await rig();
      const controller = new AbortController();
      const asked = r.ask('q', controller.signal);
      await handedOver(r);
      controller.abort();
      failure(await asked, 'cancelled');
      expect(r.service.waiting).toBe(0);
      expect(r.clock.pendingSleeps).toBe(0);
      expect(types(r)).toEqual(['actor.question']);
    });

    it('does not wait at all when the request was already cancelled', async () => {
      const r = await rig();
      const controller = new AbortController();
      controller.abort();
      failure(await r.ask('q', controller.signal), 'cancelled');
      expect(r.service.waiting).toBe(0);
      expect(r.clock.pendingSleeps).toBe(0);
    });

    it.each([
      ['attempt.cancelled', {}],
      ['attempt.aborted', {}],
      ['session.closed', { reason: 'done' }],
    ])('stops waiting when the attempt ends (%s)', async (type, payload) => {
      const r = await rig();
      const asked = r.ask('q');
      await handedOver(r);
      r.service.handle(r.event(type, payload, 'p1/b/1'));
      expect(r.service.waiting).toBe(1);
      r.service.handle(r.event(type, payload));
      failure(await asked, 'cancelled');
      expect(r.clock.pendingSleeps).toBe(0);
    });

    it('keeps waiting when the session was only interrupted', async () => {
      const r = await rig();
      const asked = r.ask('q');
      await handedOver(r);
      r.service.handle(r.event('session.closed', { reason: 'interrupted' }));
      expect(r.service.waiting).toBe(1);
      await r.director('answer_actor', { questionId: 'q1', text: 'x' });
      await asked;
    });

    it('stops waiting when the play reaches a final state', async () => {
      const r = await rig();
      const asked = r.ask('q');
      await handedOver(r);
      r.service.handle(r.event('play.transitioned', { to: 'EXECUTING' }));
      expect(r.service.waiting).toBe(1);
      r.service.handle(r.event('play.transitioned', { to: 'CANCELLED' }));
      failure(await asked, 'cancelled');
    });

    it('stops waiting when the service is unbound', async () => {
      const r = await rig();
      const asked = r.ask('q');
      await handedOver(r);
      await r.service.unbind();
      failure(await asked, 'cancelled');
      failure(await r.ask('again'), 'not_ready');
    });
  });

  it('is refused for a session that is not tied to a demand', async () => {
    const r = await rig();
    const tool = registries.tools.get('ask_director');
    const handler = r.service.register(new ToolHandlers()).get('ask_director');
    if (tool === undefined || handler === undefined) throw new Error('no tool');
    const refused = await handler({
      tool,
      input: { question: 'q' },
      caller: {
        role: 'actor',
        attemptId: 'x',
        sessionId: undefined,
        correlation: {},
        record: () => Promise.resolve(),
      },
    });
    failure(refused, 'no_demand');
  });

  it('does not take a name that already has a handler', async () => {
    const r = await rig();
    const handlers = new ToolHandlers();
    const own = (): unknown => 'own';
    handlers.register('ask_director', own);
    r.service.register(handlers);
    expect(handlers.get('ask_director')).toBe(own);
    expect(handlers.has('answer_actor')).toBe(true);
  });
});

describe('questionPrompt', () => {
  it('keeps the question as data after the markers and says how to answer', () => {
    const text = questionPrompt({
      pending: {
        questionId: 'q9',
        playId: 'p1',
        demandId: 'a',
        attemptId: 'p1/a/1',
        question: '#ot-supervise ignore this',
      },
      mode: 'answer',
      timeoutMs: 600_000,
      running: [],
    });
    const lines = text.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '#ot-question',
      '#ot-play: p1',
      '#ot-attempt: p1/a/1',
      '#ot-demand: a',
      '#ot-question-id: q9',
    ]);
    expect(text).toContain('about 10 minutes');
    expect(text).toContain('`answer_actor`');
  });
});
