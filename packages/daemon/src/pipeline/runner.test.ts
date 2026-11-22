// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput, NotFound, type StoreTransaction } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAY_FLOW_ID, PLAY_FLOW_VERSION } from './definitions.js';
import type { PlayEffect, PlayEffects, PlayEffectScope } from './effects.js';
import { limitsOf } from './model-fixture.js';
import { PlayRunner, restorePlay } from './runner.js';

/** Keeps what was dispatched, in order. */
class FakeEffects implements PlayEffects {
  readonly dispatched: { effect: PlayEffect; scope: PlayEffectScope }[] = [];
  failWith: Error | null = null;

  dispatch(effect: PlayEffect, scope: PlayEffectScope): Promise<void> {
    this.dispatched.push({ effect, scope });
    return this.failWith === null ? Promise.resolve() : Promise.reject(this.failWith);
  }

  types(): string[] {
    return this.dispatched.map((entry) => entry.effect.type);
  }

  last<T extends PlayEffect['type']>(type: T): Extract<PlayEffect, { type: T }> {
    const found = [...this.dispatched].reverse().find((entry) => entry.effect.type === type);
    if (found === undefined) throw new Error(`no ${type} dispatched: ${this.types().join(',')}`);
    return found.effect as Extract<PlayEffect, { type: T }>;
  }

  clear(): void {
    this.dispatched.length = 0;
  }
}

/** A store whose next transaction can be made to fail after its work, to prove the rollback. */
class FlakyStore extends InMemoryStore {
  failNextCommit = false;

  override transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    return super.transaction(async (tx) => {
      const result = await fn(tx);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('disk full');
      }
      return result;
    });
  }
}

const LIMITS = limitsOf('moderate');
const NEED = 'build the thing';

describe('PlayRunner', () => {
  let clock: FakeClock;
  let store: FlakyStore;
  let effects: FakeEffects;
  let runner: PlayRunner;

  const newRunner = (): PlayRunner => new PlayRunner({ store, clock, effects });
  const create = (playId = 'p1') =>
    runner.create({ playId, scenarioId: 's1', need: NEED, limits: LIMITS });
  const stateOf = async (playId = 'p1') => (await store.plays.get(playId))?.state;
  /** NEED -> EXECUTING with demands d1 and d2. */
  const toExecuting = async (playId = 'p1') => {
    await runner.send(playId, { type: 'START' });
    await runner.send(playId, { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    await runner.send(playId, { type: 'PLAN_REVIEWED', approved: true });
    await runner.send(playId, { type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1', 'd2'] });
    await runner.send(playId, { type: 'SCRIPT_REVIEWED', approved: true });
  };

  beforeEach(() => {
    clock = new FakeClock();
    store = new FlakyStore({ clock });
    effects = new FakeEffects();
    runner = newRunner();
  });

  afterEach(async () => {
    await runner.close();
  });

  describe('create', () => {
    it('writes the play in NEED with its first snapshot, and play.created', async () => {
      const record = await create();
      expect(record).toMatchObject({
        id: 'p1',
        scenarioId: 's1',
        need: NEED,
        flowId: PLAY_FLOW_ID,
        flowVersion: PLAY_FLOW_VERSION,
        state: 'NEED',
        counters: {},
      });
      expect(record.snapshot).not.toBeNull();
      const events = await store.events.readFrom(0, 10);
      expect(events.map((event) => event.type)).toEqual(['play.created']);
      expect(events[0]).toMatchObject({ playId: 'p1', scenarioId: 's1' });
      expect(restorePlay(record).value).toBe('NEED');
    });

    it('does not start any effect: the play only starts with START', async () => {
      await create();
      expect(effects.dispatched).toEqual([]);
    });

    it('refuses a second play with the same id', async () => {
      await create();
      await expect(create()).rejects.toBeInstanceOf(Conflict);
    });
  });

  describe('send', () => {
    it('in one transaction: the state, the snapshot, the counters and play.transitioned', async () => {
      await create();
      const record = await runner.send('p1', { type: 'START' });
      expect(record.state).toBe('PLANNING');
      expect((await store.plays.get('p1'))?.snapshot).toMatchObject({ value: 'PLANNING' });
      const events = await store.events.readFrom(0, 10);
      expect(events.map((event) => event.type)).toEqual(['play.created', 'play.transitioned']);
      expect(events[1]?.payload).toMatchObject({
        event: 'START',
        from: 'NEED',
        to: 'PLANNING',
        effects: ['run_stage'],
      });
    });

    it('writes the reason of the event in the transition (why a SUBMIT_FAILED moved the play)', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.send('p1', { type: 'SUBMIT_FAILED', reason: 'plan: expected string' });
      const events = await store.events.readFrom(0, 10);
      expect(events.at(-1)?.payload).toMatchObject({
        event: 'SUBMIT_FAILED',
        from: 'PLANNING',
        to: 'AWAITING_PRODUCER',
        reason: 'plan: expected string',
      });
      expect(events[1]?.payload).not.toHaveProperty('reason');
    });

    it('writes the counters of the machine in the record', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      await runner.send('p1', { type: 'PLAN_REVIEWED', approved: false, reason: 'weak' });
      expect((await store.plays.get('p1'))?.counters).toEqual({ plan_reviews: 1 });
      expect(await stateOf()).toBe('PLANNING');
    });

    it('starts the effects of the transition only after the commit, in order', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      expect(effects.dispatched).toHaveLength(1);
      expect(effects.dispatched[0]).toMatchObject({
        effect: { type: 'run_stage', stage: 'PLANNING', role: 'author' },
        scope: { playId: 'p1', scenarioId: 's1' },
      });
    });

    it('a transaction that fails keeps the old state, and dispatches nothing', async () => {
      await create();
      await runner.send('p1', { type: 'START', dispenseCritic: { reason: 'small change' } });
      effects.clear();
      const before = await store.plays.get('p1');
      const eventsBefore = await store.events.lastId();
      store.failNextCommit = true;
      await expect(
        runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false }),
      ).rejects.toThrow('disk full');
      expect(await store.plays.get('p1')).toEqual(before);
      expect(await store.events.lastId()).toBe(eventsBefore);
      expect(await store.decisions.list({ playId: 'p1' })).toHaveLength(1);
      expect(effects.dispatched).toEqual([]);
      // the same event goes through afterwards
      await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      expect(await stateOf()).toBe('REVIEWING_PLAN');
    });

    it('a failing effect does not undo the saved state', async () => {
      const warnings: string[] = [];
      runner = new PlayRunner({
        store,
        clock,
        effects,
        logger: { warn: (_fields, message) => void warnings.push(message) },
      });
      await create();
      effects.failWith = new Error('no session');
      const record = await runner.send('p1', { type: 'START' });
      expect(record.state).toBe('PLANNING');
      expect(warnings).toEqual(['play effect not started']);
    });

    it('records the waiver of the Critic as a decision, in the same transaction as START', async () => {
      await create();
      await runner.send('p1', { type: 'START', dispenseCritic: { reason: 'it is a typo fix' } });
      const decisions = await store.decisions.list({ playId: 'p1' });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        id: 'p1:d1',
        kind: 'dispense_critic',
        decidedBy: 'producer',
        answer: { reason: 'it is a typo fix' },
      });
    });

    it('records the decisions of the menu with consecutive ids', async () => {
      await create();
      await runner.send('p1', { type: 'START', dispenseCritic: { reason: 'x' } });
      for (let i = 0; i <= LIMITS.plan_reviews; i += 1) {
        await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
        await runner.send('p1', { type: 'PLAN_REVIEWED', approved: false });
      }
      expect(await stateOf()).toBe('AWAITING_PRODUCER');
      expect(effects.last('ask_menu').options).toContain('raise_limit');
      await runner.send('p1', { type: 'PRODUCER_CHOSE', option: 'raise_limit' });
      const decisions = await store.decisions.list({ playId: 'p1' });
      expect(decisions.map((d) => [d.id, d.kind])).toEqual([
        ['p1:d1', 'dispense_critic'],
        ['p1:d2', 'menu_choice'],
      ]);
    });

    it('marks the end of the play with finishedAt', async () => {
      await create();
      await runner.send('p1', { type: 'CANCEL', reason: 'changed my mind' });
      const record = await store.plays.get('p1');
      expect(record).toMatchObject({ state: 'CANCELLED', finishedAt: clock.now() });
      expect(effects.types()).toEqual(['abort_work']);
    });

    it('refuses an invalid event with InvalidInput, before touching the store', async () => {
      await create();
      const last = await store.events.lastId();
      await expect(runner.send('p1', { type: 'START', extra: true })).rejects.toBeInstanceOf(
        InvalidInput,
      );
      await expect(runner.send('p1', { type: 'NOPE' })).rejects.toBeInstanceOf(InvalidInput);
      await expect(runner.send('p1', 'START')).rejects.toBeInstanceOf(InvalidInput);
      expect(await store.events.lastId()).toBe(last);
    });

    it('NotFound for a play that does not exist', async () => {
      await expect(runner.send('ghost', { type: 'START' })).rejects.toBeInstanceOf(NotFound);
      await expect(runner.resume('ghost')).rejects.toBeInstanceOf(NotFound);
    });

    it('Conflict for an event the state does not take, and the play stays as it was', async () => {
      await create();
      const before = await store.plays.get('p1');
      await expect(
        runner.send('p1', { type: 'PLAN_REVIEWED', approved: true }),
      ).rejects.toBeInstanceOf(Conflict);
      expect(await store.plays.get('p1')).toEqual(before);
    });

    it('Conflict for any event after the play finished', async () => {
      await create();
      await runner.send('p1', { type: 'CANCEL' });
      await expect(runner.send('p1', { type: 'START' })).rejects.toBeInstanceOf(Conflict);
      await expect(runner.send('p1', { type: 'CANCEL' })).rejects.toBeInstanceOf(Conflict);
    });

    it('serializes the events of one play: two at once, the second sees the first', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      const results = await Promise.allSettled([
        runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false }),
        runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false }),
        runner.send('p1', { type: 'PLAN_REVIEWED', approved: true }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      expect(await stateOf()).toBe('SCRIPTING');
    });

    it('keeps two plays apart', async () => {
      await create('p1');
      await create('p2');
      await Promise.all([
        runner.send('p1', { type: 'START' }),
        runner.send('p2', { type: 'CANCEL' }),
      ]);
      expect(await stateOf('p1')).toBe('PLANNING');
      expect(await stateOf('p2')).toBe('CANCELLED');
    });
  });

  describe('save and restore', () => {
    it('a new runner on the same store continues from the same state, counters included', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      await runner.send('p1', { type: 'PLAN_REVIEWED', approved: false, reason: 'weak' });
      await runner.close();

      const again = new PlayRunner({ store, clock, effects });
      runner = again;
      expect(await stateOf()).toBe('PLANNING');
      // PLANNING again after one rejection: the counter survived and the plan goes on
      await again.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      await again.send('p1', { type: 'PLAN_REVIEWED', approved: true });
      expect(await stateOf()).toBe('SCRIPTING');
      expect((await store.plays.get('p1'))?.counters).toEqual({ plan_reviews: 1 });
    });

    it('resume asks for the effects of the state again', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      effects.clear();
      await runner.close();

      runner = newRunner();
      await runner.resume('p1');
      expect(effects.dispatched).toHaveLength(1);
      expect(effects.dispatched[0]?.effect).toMatchObject({
        type: 'run_stage',
        stage: 'REVIEWING_PLAN',
        role: 'reviewer',
      });
    });

    it('resume of a finished play does nothing', async () => {
      await create();
      await runner.send('p1', { type: 'CANCEL' });
      effects.clear();
      await runner.resume('p1');
      expect(effects.dispatched).toEqual([]);
    });

    it('resume asks again for the open judgments, and not for the demand that waits for one', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1' });
      await runner.send('p1', { type: 'ACTOR_TIMED_OUT', demandId: 'd1' });
      effects.clear();
      await runner.close();

      runner = newRunner();
      await runner.resume('p1');
      expect(effects.last('judge')).toMatchObject({ point: 'actor_timeout', demandId: 'd1' });
      expect(effects.last('run_demands').demandIds).toEqual(['d2']);
    });

    it('a snapshot of another version of the flow is refused, and the play is not touched', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.close();
      const saved = await store.plays.get('p1');
      expect(saved).toBeDefined();
      // simulates a play saved by another version of the flow
      const other = PLAY_FLOW_VERSION + 1;
      await store.transaction(async (tx) => {
        await tx.plays.create({
          id: 'old',
          scenarioId: 's1',
          need: NEED,
          flowId: PLAY_FLOW_ID,
          flowVersion: other,
          state: 'PLANNING',
          snapshot: saved?.snapshot ?? null,
          counters: {},
        });
      });
      const before = await store.plays.get('old');

      const warnings: Record<string, unknown>[] = [];
      runner = new PlayRunner({
        store,
        clock,
        effects,
        logger: { warn: (fields) => void warnings.push(fields) },
      });
      await expect(
        runner.send('old', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false }),
      ).rejects.toThrow(/version/);
      await expect(runner.send('old', { type: 'CANCEL' })).rejects.toBeInstanceOf(Conflict);
      await expect(runner.resume('old')).rejects.toBeInstanceOf(Conflict);
      expect(await store.plays.get('old')).toEqual(before);
      expect(await store.events.readFrom(0, 50)).not.toContainEqual(
        expect.objectContaining({ playId: 'old', type: 'play.transitioned' }),
      );

      // resumeAll skips it, and the others go on
      const result = await runner.resumeAll();
      expect(result).toEqual({ resumed: ['p1'], refused: ['old'] });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ playId: 'old' });
    });

    it('a record that says the current version but holds a snapshot of another is refused too', async () => {
      const record = await create();
      const snapshot = record.snapshot as { context: Record<string, unknown> };
      const tampered = {
        ...record,
        snapshot: {
          ...snapshot,
          context: { ...snapshot.context, flowVersion: PLAY_FLOW_VERSION + 1 },
        },
      };
      expect(() => restorePlay(tampered)).toThrow(Conflict);
      expect(() => restorePlay({ ...record, snapshot: null })).toThrow(/no snapshot/);
      expect(() => restorePlay({ ...record, flowId: 'task.run' })).toThrow(/task\.run/);
    });
  });

  describe('deadlines, with the FakeClock', () => {
    const minutes = (n: number) => n * 60_000;

    it('arms a timer for each started demand, at the deadline of the machine', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1' });
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd2', timeoutMin: 5 });
      const now = clock.now();
      expect(runner.armedDeadlines('p1')).toEqual({
        d1: now + LIMITS.demand_timeout,
        d2: now + minutes(5),
      });
      expect(clock.pendingSleeps).toBe(2);
    });

    it('when the time comes, ACTOR_TIMED_OUT reaches the machine and the judgment opens', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      effects.clear();

      await clock.advance(minutes(4));
      await runner.idle();
      expect(await stateOf()).toBe('EXECUTING');
      expect(effects.dispatched).toEqual([]);

      await clock.advance(minutes(1));
      await runner.idle();
      expect(effects.last('judge')).toMatchObject({ point: 'actor_timeout', demandId: 'd1' });
      const record = await store.plays.get('p1');
      expect(record?.snapshot).toMatchObject({
        context: { openJudgments: [{ point: 'actor_timeout', demandId: 'd1' }], deadlines: {} },
      });
      expect(runner.armedDeadlines('p1')).toEqual({});
      expect(clock.pendingSleeps).toBe(0);
    });

    it('a demand that finishes in time cancels its timer, and nothing fires', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      await runner.send('p1', { type: 'DEMAND_APPROVED', demandId: 'd1' });
      expect(runner.armedDeadlines('p1')).toEqual({});
      expect(clock.pendingSleeps).toBe(0);
      effects.clear();
      const last = await store.events.lastId();
      await clock.advance(minutes(60));
      await runner.idle();
      expect(effects.dispatched).toEqual([]);
      expect(await store.events.lastId()).toBe(last);
    });

    it('the events carry the time of the clock: a deadline counts from when the demand started', async () => {
      await create();
      await toExecuting();
      await clock.advance(minutes(10));
      const startedAt = clock.now();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      expect(runner.armedDeadlines('p1')).toEqual({ d1: startedAt + minutes(5) });
    });

    it('a restart re-arms the deadlines from the snapshot, and one already past fires at once', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd2', timeoutMin: 20 });
      const start = clock.now();
      await runner.close();
      expect(clock.pendingSleeps).toBe(0);

      await clock.advance(minutes(10)); // the daemon was down for 10 minutes
      effects.clear();
      runner = newRunner();
      await runner.resume('p1');
      expect(runner.armedDeadlines('p1')).toEqual({
        d1: start + minutes(5),
        d2: start + minutes(20),
      });
      await clock.advance(0);
      await runner.idle();
      expect(effects.last('judge')).toMatchObject({ point: 'actor_timeout', demandId: 'd1' });
      expect(runner.armedDeadlines('p1')).toEqual({ d2: start + minutes(20) });

      await clock.advance(minutes(10));
      await runner.idle();
      expect(effects.dispatched.filter((entry) => entry.effect.type === 'judge')).toHaveLength(2);
      expect(await stateOf()).toBe('EXECUTING');
    });

    it('close stops the timers: time goes by and nothing is sent', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      await runner.close();
      const last = await store.events.lastId();
      await clock.advance(minutes(60));
      await runner.idle();
      expect(await store.events.lastId()).toBe(last);
      await expect(
        runner.send('p1', { type: 'DEMAND_APPROVED', demandId: 'd1' }),
      ).rejects.toBeInstanceOf(Conflict);
    });

    it('a play that ends drops its timers', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1' });
      await runner.send('p1', { type: 'CANCEL' });
      expect(runner.armedDeadlines('p1')).toEqual({});
      expect(clock.pendingSleeps).toBe(0);
    });
  });

  describe('pause and resume (N176)', () => {
    it('drain: holds the effect of the next state, saves it, and RESUME dispatches it', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      effects.clear();
      await runner.send('p1', { type: 'PAUSE', mode: 'drain', reason: 'coffee' });
      expect(effects.types()).toEqual(['pause_work']);
      // the stage in flight finishes: the state moves, but what it asks for waits
      await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      expect(await stateOf()).toBe('REVIEWING_PLAN');
      expect(effects.types()).toEqual(['pause_work']);
      const events = await store.events.readFrom(0, 20);
      expect(events.at(-1)?.payload).toMatchObject({
        event: 'PLAN_SUBMITTED',
        held: ['run_stage'],
      });

      await runner.send('p1', { type: 'RESUME' });
      expect(effects.types()).toEqual(['pause_work', 'resume_work', 'run_stage']);
      expect(effects.last('run_stage')).toMatchObject({ stage: 'REVIEWING_PLAN' });
      expect(
        ((await store.plays.get('p1'))?.snapshot as { context: { paused: unknown } }).context
          .paused,
      ).toBeNull();
    });

    it('refuses to pause twice, to resume a play that is not paused and to pause a finished one', async () => {
      await create();
      await toExecuting();
      await expect(runner.send('p1', { type: 'RESUME' })).rejects.toBeInstanceOf(Conflict);
      await runner.send('p1', { type: 'PAUSE', mode: 'drain' });
      await expect(runner.send('p1', { type: 'PAUSE', mode: 'interrupt' })).rejects.toBeInstanceOf(
        Conflict,
      );
      await runner.send('p1', { type: 'CANCEL' });
      await expect(runner.send('p1', { type: 'PAUSE', mode: 'drain' })).rejects.toBeInstanceOf(
        Conflict,
      );
    });

    it('a pause in EXECUTING keeps the demands out until RESUME', async () => {
      await create();
      await toExecuting();
      effects.clear();
      await runner.send('p1', { type: 'PAUSE', mode: 'drain' });
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1' });
      await runner.send('p1', { type: 'DEMAND_APPROVED', demandId: 'd1' });
      await runner.send('p1', { type: 'DEMAND_APPROVED', demandId: 'd2' });
      expect(await stateOf()).toBe('INTEGRATING');
      expect(effects.types()).toEqual(['pause_work']);
      await runner.send('p1', { type: 'RESUME' });
      expect(effects.types()).toEqual(['pause_work', 'resume_work', 'integrate']);
    });

    it('stays paused after a restart: nothing starts until RESUME, which starts the state again', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.send('p1', { type: 'PAUSE', mode: 'drain' });
      await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      await runner.close();
      effects.clear();

      runner = newRunner();
      await runner.resume('p1');
      expect(effects.types()).toEqual(['pause_work']);
      expect(effects.dispatched[0]?.effect).toEqual({ type: 'pause_work', mode: 'drain' });
      await runner.send('p1', { type: 'RESUME' });
      // the held effect came from the snapshot: only one run_stage, not two
      expect(effects.types()).toEqual(['pause_work', 'resume_work', 'run_stage']);
    });

    it('a restart of a play paused with nothing held starts the state on RESUME', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.send('p1', { type: 'PAUSE', mode: 'drain' });
      await runner.close();
      effects.clear();

      runner = newRunner();
      await runner.resume('p1');
      expect(effects.types()).toEqual(['pause_work']);
      await runner.send('p1', { type: 'RESUME' });
      expect(effects.types()).toEqual(['pause_work', 'resume_work', 'run_stage']);
      expect(effects.last('run_stage')).toMatchObject({ stage: 'PLANNING' });
    });

    it('interrupt: freezes the deadlines while paused and moves them forward on RESUME', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      const deadline = clock.now() + 5 * 60_000;
      expect(runner.armedDeadlines('p1')).toEqual({ d1: deadline });
      await runner.send('p1', { type: 'PAUSE', mode: 'interrupt' });
      expect(runner.armedDeadlines('p1')).toEqual({});
      await clock.advance(10 * 60_000);
      await runner.idle();
      expect(effects.dispatched.filter((entry) => entry.effect.type === 'judge')).toHaveLength(0);
      await runner.send('p1', { type: 'RESUME' });
      expect(runner.armedDeadlines('p1')).toEqual({ d1: deadline + 10 * 60_000 });
    });

    it('drain: the deadlines keep running', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      await runner.send('p1', { type: 'PAUSE', mode: 'drain' });
      expect(Object.keys(runner.armedDeadlines('p1'))).toEqual(['d1']);
    });

    it('CANCEL of a paused play aborts the work, drops what was held and ends the play', async () => {
      await create();
      await runner.send('p1', { type: 'START' });
      await runner.send('p1', { type: 'PAUSE', mode: 'drain' });
      await runner.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      effects.clear();
      await runner.send('p1', { type: 'CANCEL' });
      expect(effects.types()).toEqual(['abort_work']);
      expect(await stateOf()).toBe('CANCELLED');
    });

    it('a cancelled attempt asks the Director to judge it (judgment point 2)', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1' });
      effects.clear();
      await runner.send('p1', { type: 'ACTOR_CANCELLED', demandId: 'd1', reason: 'by hand' });
      expect(effects.last('judge')).toMatchObject({ point: 'actor_timeout', demandId: 'd1' });
    });
  });

  describe('play.notice of the warnings of the runner (P24, N146)', () => {
    const minutes = (n: number) => n * 60_000;
    const notices = async () =>
      (await store.events.readFrom(0, 200)).filter((event) => event.type === 'play.notice');
    const quiet = { warn: () => undefined };

    it('effect_not_started: a failing effect is also an event of its play, with the effect and the cause', async () => {
      runner = new PlayRunner({ store, clock, effects, logger: quiet });
      await create();
      effects.failWith = new Error('no session');
      await runner.send('p1', { type: 'START' });
      await runner.idle();
      const found = await notices();
      expect(found).toHaveLength(effects.dispatched.length);
      expect(found[0]).toMatchObject({
        scenarioId: 's1',
        playId: 'p1',
        payload: {
          scenarioId: 's1',
          playId: 'p1',
          kind: 'effect_not_started',
          detail: `${effects.types()[0] ?? '?'}: no session`,
        },
      });
    });

    it('finish_not_handled: an onFinish that throws is an event, and the play still ends', async () => {
      runner = new PlayRunner({
        store,
        clock,
        effects,
        logger: quiet,
        onFinish: () => {
          throw new Error('the board is closed');
        },
      });
      await create();
      await runner.send('p1', { type: 'CANCEL' });
      await runner.idle();
      expect(await stateOf()).toBe('CANCELLED');
      expect((await notices()).map((event) => event.payload)).toEqual([
        {
          scenarioId: 's1',
          playId: 'p1',
          kind: 'finish_not_handled',
          detail: 'the board is closed',
        },
      ]);
    });

    it('deadline_not_delivered: a deadline that fails for a reason other than a late one is an event', async () => {
      runner = new PlayRunner({ store, clock, effects, logger: quiet });
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'DEMAND_STARTED', demandId: 'd1', timeoutMin: 5 });
      store.failNextCommit = true;
      await clock.advance(minutes(5));
      await runner.idle();
      expect((await notices()).map((event) => event.payload)).toEqual([
        { scenarioId: 's1', playId: 'p1', kind: 'deadline_not_delivered', detail: 'd1: disk full' },
      ]);
    });

    it('play_not_resumed: a play of another version of the flow is refused, and the refusal is an event', async () => {
      await create();
      const saved = await store.plays.get('p1');
      await runner.close();
      await store.transaction(async (tx) => {
        await tx.plays.create({
          id: 'old',
          scenarioId: 's1',
          need: NEED,
          flowId: PLAY_FLOW_ID,
          flowVersion: PLAY_FLOW_VERSION + 1,
          state: 'PLANNING',
          snapshot: saved?.snapshot ?? null,
          counters: {},
        });
      });
      runner = new PlayRunner({ store, clock, effects, logger: quiet });
      expect((await runner.resumeAll()).refused).toEqual(['old']);
      await runner.idle();
      const found = await notices();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        scenarioId: 's1',
        playId: 'old',
        payload: { scenarioId: 's1', playId: 'old', kind: 'play_not_resumed' },
      });
    });

    it('a play that goes well writes no play.notice', async () => {
      await create();
      await toExecuting();
      await runner.send('p1', { type: 'CANCEL' });
      await runner.idle();
      expect(await notices()).toEqual([]);
    });
  });
});

describe('PlayRunner with a flow of the configuration (P12)', () => {
  const FLOW = {
    id: 'quick',
    version: 1,
    hash: 'b'.repeat(64),
    skip: ['plan_review'],
  } as const;

  function rig() {
    const clock = new FakeClock();
    const store = new InMemoryStore({ clock });
    const effects = new FakeEffects();
    const runner = new PlayRunner({ store, clock, effects });
    return { clock, store, effects, runner };
  }

  it('keeps the id, the version and the hash of the flow in the snapshot of the play', async () => {
    const { store, runner } = rig();
    try {
      const record = await runner.create({
        playId: 'p1',
        scenarioId: 's1',
        need: NEED,
        limits: LIMITS,
        flow: FLOW,
      });
      // the machine is still the official one, so the play restores as always
      expect(record).toMatchObject({ flowId: PLAY_FLOW_ID, flowVersion: PLAY_FLOW_VERSION });
      const context = (await store.plays.get('p1'))?.snapshot as {
        context: { flow: unknown };
      };
      expect(context.context.flow).toEqual(FLOW);
      expect(restorePlay(record).context.flow).toEqual(FLOW);
    } finally {
      await runner.close();
    }
  });

  it('runs to the delivery without the review of the plan, and a restart keeps the flow', async () => {
    const { store, clock, effects, runner } = rig();
    await runner.create({ playId: 'p1', scenarioId: 's1', need: NEED, limits: LIMITS, flow: FLOW });
    await runner.send('p1', { type: 'START' });
    await runner.close();

    // a new runner on the same store: nothing is read but the snapshot
    const again = new PlayRunner({ store, clock, effects });
    try {
      await again.send('p1', { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      expect((await store.plays.get('p1'))?.state).toBe('SCRIPTING');
      await again.send('p1', { type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1'] });
      await again.send('p1', { type: 'SCRIPT_REVIEWED', approved: true });
      await again.send('p1', { type: 'DEMAND_APPROVED', demandId: 'd1' });
      await again.send('p1', { type: 'INTEGRATED', ok: true });
      await again.send('p1', { type: 'CRITIQUED', approved: true });
      await again.send('p1', { type: 'DELIVERED' });
      expect((await store.plays.get('p1'))?.state).toBe('DONE');
      const states = (await store.events.readFrom(0, 100))
        .filter((event) => event.type === 'play.transitioned')
        .map((event) => (event.payload as { to: string }).to);
      expect(states).not.toContain('REVIEWING_PLAN');
    } finally {
      await again.close();
    }
  });

  it('is not touched by another play, nor by a play without a flow created later', async () => {
    const { store, runner } = rig();
    try {
      await runner.create({
        playId: 'p1',
        scenarioId: 's1',
        need: NEED,
        limits: LIMITS,
        flow: FLOW,
      });
      // the configuration "changed": the next play has no flow, with other limits
      await runner.create({
        playId: 'p2',
        scenarioId: 's1',
        need: NEED,
        limits: { ...LIMITS, plan_reviews: 0 },
      });
      for (const playId of ['p1', 'p2']) {
        await runner.send(playId, { type: 'START' });
        await runner.send(playId, { type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
      }
      expect((await store.plays.get('p1'))?.state).toBe('SCRIPTING');
      expect((await store.plays.get('p2'))?.state).toBe('REVIEWING_PLAN');
      const first = await store.plays.get('p1');
      const second = await store.plays.get('p2');
      if (first === undefined || second === undefined) throw new Error('the plays are missing');
      expect(restorePlay(first).context.limits).toEqual(LIMITS);
      expect(restorePlay(second).context.flow ?? null).toBeNull();
    } finally {
      await runner.close();
    }
  });
});
