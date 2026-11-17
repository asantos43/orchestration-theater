// SPDX-License-Identifier: MPL-2.0
import type { NewDirective, NewPromptQueueItem, NewSession, NewSideEffect } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { expectCode, type AggregateHarness } from './aggregate-support.js';

const DAY = 86_400_000;

export function samplePrompt(
  id: string,
  extra: Partial<NewPromptQueueItem> = {},
): NewPromptQueueItem {
  return {
    id,
    scenarioId: 'scn-1',
    source: 'producer',
    content: { text: `Prompt ${id}` },
    ...extra,
  };
}

export function sampleSideEffect(key: string, extra: Partial<NewSideEffect> = {}): NewSideEffect {
  return { idempotencyKey: key, type: 'git_commit', target: 'feature/x', ...extra };
}

export function sampleSession(id: string, extra: Partial<NewSession> = {}): NewSession {
  return { id, client: 'claude-code', profile: 'work', ...extra };
}

export function sampleDirective(extra: Partial<NewDirective> = {}): NewDirective {
  return {
    scope: 'global',
    kind: 'instruction',
    text: 'Prefer small commits',
    origin: 'chat',
    ...extra,
  };
}

/**
 * Registers the conformance tests of `store.blackboard`, `promptQueue`, `sideEffects`,
 * `sessions` and `directives`.
 */
export function describeCoordinationAggregatesConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Blackboard conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('put numbers the versions of a key 1, 2, 3 and never overwrites', async () => {
      const { store, clock } = harness();
      const v1 = await store.blackboard.put({ playId: 'play-1', key: 'plan', value: { step: 1 } });
      const v2 = await store.blackboard.put({
        playId: 'play-1',
        key: 'plan',
        value: { step: 2 },
        author: 'planner',
      });
      const v3 = await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 'text' });
      expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
      expect(v1).toEqual({
        playId: 'play-1',
        key: 'plan',
        version: 1,
        value: { step: 1 },
        author: null,
        createdAt: clock.now(),
      });
      expect(v2.author).toBe('planner');
      expect((await store.blackboard.history('play-1', 'plan')).map((e) => e.value)).toEqual([
        { step: 1 },
        { step: 2 },
        'text',
      ]);
    });

    it('get resolves the latest version, a given one, or undefined', async () => {
      const { store } = harness();
      await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 'a' });
      await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 'b' });
      expect((await store.blackboard.get('play-1', 'plan'))?.value).toBe('b');
      expect((await store.blackboard.get('play-1', 'plan', 1))?.value).toBe('a');
      expect(await store.blackboard.get('play-1', 'plan', 3)).toBeUndefined();
      expect(await store.blackboard.get('play-1', 'other')).toBeUndefined();
      expect(await store.blackboard.get('play-2', 'plan')).toBeUndefined();
    });

    it('keys and plays number their versions independently', async () => {
      const { store } = harness();
      await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 1 });
      await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 2 });
      expect(
        (await store.blackboard.put({ playId: 'play-1', key: 'script', value: 1 })).version,
      ).toBe(1);
      expect(
        (await store.blackboard.put({ playId: 'play-2', key: 'plan', value: 1 })).version,
      ).toBe(1);
      expect(
        (await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 3 })).version,
      ).toBe(3);
    });

    it('latest lists the newest version of every key of a play, ordered by key', async () => {
      const { store } = harness();
      await store.blackboard.put({ playId: 'play-1', key: 'script', value: 's1' });
      await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 'p1' });
      await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 'p2' });
      await store.blackboard.put({ playId: 'play-2', key: 'other', value: 'x' });
      const latest = await store.blackboard.latest('play-1');
      expect(latest.map((e) => [e.key, e.version, e.value])).toEqual([
        ['plan', 2, 'p2'],
        ['script', 1, 's1'],
      ]);
      expect(await store.blackboard.latest('play-9')).toEqual([]);
      expect(await store.blackboard.history('play-1', 'nope')).toEqual([]);
    });

    it('keeps any JSON value, including null, arrays and nested objects', async () => {
      const { store } = harness();
      const values = [null, true, 0, 'x', [1, [2, null]], { a: { b: [1, { c: null }] } }];
      for (const [index, value] of values.entries()) {
        await store.blackboard.put({ playId: 'play-1', key: `k${String(index)}`, value });
      }
      for (const [index, value] of values.entries()) {
        const entry = await store.blackboard.get('play-1', `k${String(index)}`);
        expect(entry?.value).toEqual(value);
      }
    });

    it('rejects invalid input with INVALID_INPUT', async () => {
      const { store } = harness();
      await expectCode(
        store.blackboard.put({ playId: 'play-1', key: '', value: 1 }),
        'INVALID_INPUT',
      );
      await expectCode(
        store.blackboard.put({ playId: 'play-1', key: 'k', value: 1, author: '' }),
        'INVALID_INPUT',
      );
      await expectCode(
        store.blackboard.put({ playId: 'play-1', key: 'k', value: undefined as never }),
        'INVALID_INPUT',
      );
      expect(await store.blackboard.latest('play-1')).toEqual([]);
    });
  });

  describe(`Prompt queue conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('enqueue writes a pending item with the priority of its source', async () => {
      const { store, clock } = harness();
      const stored = await store.promptQueue.enqueue(samplePrompt('p1'));
      expect(stored).toEqual({
        id: 'p1',
        seq: 1,
        scenarioId: 'scn-1',
        source: 'producer',
        priority: 100,
        content: { text: 'Prompt p1' },
        state: 'pending',
        createdAt: clock.now(),
        deliveredAt: null,
      });
      expect(await store.promptQueue.get('p1')).toEqual(stored);
      expect(await store.promptQueue.get('nope')).toBeUndefined();
      expect(
        (await store.promptQueue.enqueue(samplePrompt('p2', { source: 'director' }))).priority,
      ).toBe(50);
      expect(
        (await store.promptQueue.enqueue(samplePrompt('p3', { source: 'schedule' }))).priority,
      ).toBe(10);
      expect(
        (await store.promptQueue.enqueue(samplePrompt('p4', { source: 'daemon' }))).priority,
      ).toBe(0);
      expect((await store.promptQueue.enqueue(samplePrompt('p5', { priority: -5 }))).priority).toBe(
        -5,
      );
    });

    it('arrival numbers increase and a duplicate id rejects with CONFLICT', async () => {
      const { store } = harness();
      const a = await store.promptQueue.enqueue(samplePrompt('a'));
      const b = await store.promptQueue.enqueue(samplePrompt('b'));
      expect([a.seq, b.seq]).toEqual([1, 2]);
      await expectCode(
        store.promptQueue.enqueue(samplePrompt('a', { source: 'daemon' })),
        'CONFLICT',
      );
      expect((await store.promptQueue.get('a'))?.source).toBe('producer');
      expect((await store.promptQueue.enqueue(samplePrompt('c'))).seq).toBe(3);
    });

    it('next and list use the delivery order: priority first, then arrival', async () => {
      const { store } = harness();
      await store.promptQueue.enqueue(samplePrompt('d1', { source: 'daemon' }));
      await store.promptQueue.enqueue(samplePrompt('p1'));
      await store.promptQueue.enqueue(samplePrompt('r1', { source: 'director' }));
      await store.promptQueue.enqueue(samplePrompt('p2'));
      await store.promptQueue.enqueue(samplePrompt('urgent', { source: 'daemon', priority: 500 }));
      expect((await store.promptQueue.list()).map((i) => i.id)).toEqual([
        'urgent',
        'p1',
        'p2',
        'r1',
        'd1',
      ]);
      const order: string[] = [];
      for (;;) {
        const item = await store.promptQueue.next();
        if (item === undefined) break;
        order.push(item.id);
        await store.promptQueue.markDelivered(item.id);
      }
      expect(order).toEqual(['urgent', 'p1', 'p2', 'r1', 'd1']);
    });

    it('next can be scoped to a scenario', async () => {
      const { store } = harness();
      await store.promptQueue.enqueue(samplePrompt('a', { scenarioId: 'scn-2' }));
      await store.promptQueue.enqueue(samplePrompt('b', { scenarioId: 'scn-1', source: 'daemon' }));
      expect((await store.promptQueue.next())?.id).toBe('a');
      expect((await store.promptQueue.next('scn-1'))?.id).toBe('b');
      expect(await store.promptQueue.next('scn-3')).toBeUndefined();
    });

    it('markDelivered moves a pending item to delivered, once', async () => {
      const { store } = harness();
      await store.promptQueue.enqueue(samplePrompt('a'));
      const delivered = await store.promptQueue.markDelivered('a');
      expect(delivered.state).toBe('delivered');
      expect(delivered.deliveredAt).not.toBeNull();
      expect(await store.promptQueue.get('a')).toEqual(delivered);
      await expectCode(store.promptQueue.markDelivered('a'), 'CONFLICT');
      await expectCode(store.promptQueue.markDelivered('nope'), 'NOT_FOUND');
      expect(await store.promptQueue.next()).toBeUndefined();
    });

    it('list filters by scenario and state', async () => {
      const { store } = harness();
      await store.promptQueue.enqueue(samplePrompt('a'));
      await store.promptQueue.enqueue(samplePrompt('b', { scenarioId: 'scn-2' }));
      await store.promptQueue.enqueue(samplePrompt('c'));
      await store.promptQueue.markDelivered('a');
      const ids = async (filter: Parameters<typeof store.promptQueue.list>[0]): Promise<string[]> =>
        (await store.promptQueue.list(filter)).map((i) => i.id);
      expect(await ids({ scenarioId: 'scn-1' })).toEqual(['a', 'c']);
      expect(await ids({ states: ['pending'] })).toEqual(['b', 'c']);
      expect(await ids({ states: ['delivered'], scenarioId: 'scn-1' })).toEqual(['a']);
      expect(await ids({ states: [] })).toEqual([]);
    });

    it('rejects invalid input with INVALID_INPUT', async () => {
      const { store } = harness();
      await expectCode(
        store.promptQueue.enqueue(samplePrompt('a', { source: 'nobody' as never })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.promptQueue.enqueue(samplePrompt('a', { priority: 1.5 })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.promptQueue.enqueue(samplePrompt('a', { scenarioId: '' })),
        'INVALID_INPUT',
      );
      expect(await store.promptQueue.list()).toEqual([]);
    });
  });

  describe(`Side effects conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('intend records the effect before it runs', async () => {
      const { store, clock } = harness();
      const stored = await store.sideEffects.intend(
        sampleSideEffect('attempt-1:commit', { attemptId: 'attempt-1', params: { message: 'm' } }),
      );
      expect(stored).toEqual({
        idempotencyKey: 'attempt-1:commit',
        type: 'git_commit',
        target: 'feature/x',
        attemptId: 'attempt-1',
        params: { message: 'm' },
        result: null,
        state: 'pending',
        verifier: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        resolvedAt: null,
      });
      expect(await store.sideEffects.get('attempt-1:commit')).toEqual(stored);
      expect(await store.sideEffects.get('nope')).toBeUndefined();
    });

    it('the idempotency key is unique: a second intend rejects with CONFLICT', async () => {
      const { store } = harness();
      await store.sideEffects.intend(sampleSideEffect('k1'));
      await expectCode(
        store.sideEffects.intend(sampleSideEffect('k1', { target: 'other' })),
        'CONFLICT',
      );
      expect((await store.sideEffects.get('k1'))?.target).toBe('feature/x');
    });

    it.each(['done', 'failed', 'not_done'] as const)(
      'resolve to %s stamps resolvedAt',
      async (state) => {
        const { store } = harness();
        await store.sideEffects.intend(sampleSideEffect('k1'));
        const resolved = await store.sideEffects.resolve('k1', {
          state,
          result: { sha: 'abc123', files: ['a', 'b'] },
        });
        expect(resolved).toMatchObject({
          state,
          result: { sha: 'abc123', files: ['a', 'b'] },
          verifier: null,
        });
        expect(resolved.resolvedAt).not.toBeNull();
        expect(await store.sideEffects.get('k1')).toEqual(resolved);
      },
    );

    it('an ambiguous effect can be settled later, by a verifier or the producer', async () => {
      const { store } = harness();
      await store.sideEffects.intend(sampleSideEffect('k1'));
      const ambiguous = await store.sideEffects.resolve('k1', { state: 'ambiguous' });
      expect(ambiguous).toMatchObject({ state: 'ambiguous', resolvedAt: null });
      const settled = await store.sideEffects.resolve('k1', {
        state: 'done',
        verifier: 'verifier',
        result: { found: true },
      });
      expect(settled).toMatchObject({
        state: 'done',
        verifier: 'verifier',
        result: { found: true },
      });
      expect(settled.resolvedAt).not.toBeNull();
    });

    it('an effect already settled cannot be resolved again (CONFLICT); an unknown key is NOT_FOUND', async () => {
      const { store } = harness();
      await store.sideEffects.intend(sampleSideEffect('k1'));
      await store.sideEffects.resolve('k1', { state: 'failed' });
      await expectCode(store.sideEffects.resolve('k1', { state: 'done' }), 'CONFLICT');
      await expectCode(store.sideEffects.resolve('nope', { state: 'done' }), 'NOT_FOUND');
      expect((await store.sideEffects.get('k1'))?.state).toBe('failed');
    });

    it('rejects invalid input with INVALID_INPUT', async () => {
      const { store } = harness();
      await expectCode(store.sideEffects.intend(sampleSideEffect('')), 'INVALID_INPUT');
      await expectCode(
        store.sideEffects.intend(sampleSideEffect('k', { type: '' })),
        'INVALID_INPUT',
      );
      await store.sideEffects.intend(sampleSideEffect('k1'));
      await expectCode(
        store.sideEffects.resolve('k1', { state: 'pending' as never }),
        'INVALID_INPUT',
      );
      await expectCode(
        store.sideEffects.resolve('k1', { state: 'done', verifier: 'nobody' as never }),
        'INVALID_INPUT',
      );
      expect((await store.sideEffects.get('k1'))?.state).toBe('pending');
    });

    it('list is ordered by creation, then key, and filters by state, type and attempt', async () => {
      const { store } = harness();
      await store.sideEffects.intend(
        sampleSideEffect('b', { type: 'git_push', attemptId: 'at-1' }),
      );
      await store.sideEffects.intend(sampleSideEffect('a', { attemptId: 'at-2' }));
      await store.sideEffects.intend(sampleSideEffect('c', { type: 'open_pr' }));
      await store.sideEffects.resolve('c', { state: 'done' });
      const keys = async (
        filter: Parameters<typeof store.sideEffects.list>[0],
      ): Promise<string[]> => (await store.sideEffects.list(filter)).map((e) => e.idempotencyKey);
      expect(await keys({})).toEqual(['a', 'b', 'c']);
      expect(await keys({ states: ['pending'] })).toEqual(['a', 'b']);
      expect(await keys({ types: ['git_push', 'open_pr'] })).toEqual(['b', 'c']);
      expect(await keys({ attemptId: 'at-2' })).toEqual(['a']);
      expect(await keys({ states: ['done'], types: ['git_commit'] })).toEqual([]);
    });
  });

  describe(`Sessions conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('open records an active session with the defaults', async () => {
      const { store, clock } = harness();
      const stored = await store.sessions.open(sampleSession('s1'));
      expect(stored).toEqual({
        id: 's1',
        client: 'claude-code',
        profile: 'work',
        role: null,
        attemptId: null,
        worktree: null,
        clientSessionId: null,
        pid: null,
        processStartedAt: null,
        state: 'active',
        createdAt: clock.now(),
        updatedAt: clock.now(),
        endedAt: null,
      });
      expect(await store.sessions.get('s1')).toEqual(stored);
      expect(await store.sessions.get('nope')).toBeUndefined();
    });

    it('keeps the process identity: pid and the instant the process started', async () => {
      const { store } = harness();
      const stored = await store.sessions.open(
        sampleSession('s1', {
          pid: 4242,
          processStartedAt: 1_767_225_600_123,
          role: 'implementer',
          attemptId: 'attempt-1',
          worktree: '/tmp/wt',
          clientSessionId: 'abc',
          state: 'resuming',
        }),
      );
      expect(await store.sessions.get('s1')).toEqual(stored);
      expect(stored).toMatchObject({
        pid: 4242,
        processStartedAt: 1_767_225_600_123,
        state: 'resuming',
      });
    });

    it('a duplicate id rejects with CONFLICT; bad input with INVALID_INPUT', async () => {
      const { store } = harness();
      await store.sessions.open(sampleSession('s1'));
      await expectCode(store.sessions.open(sampleSession('s1', { client: 'codex' })), 'CONFLICT');
      await expectCode(store.sessions.open(sampleSession('s2', { pid: 0 })), 'INVALID_INPUT');
      await expectCode(
        store.sessions.open(sampleSession('s2', { state: 'gone' as never })),
        'INVALID_INPUT',
      );
      expect((await store.sessions.list()).map((s) => s.id)).toEqual(['s1']);
    });

    it('update changes the patch fields and bumps updatedAt', async () => {
      const { store } = harness();
      const first = await store.sessions.open(sampleSession('s1'));
      const updated = await store.sessions.update('s1', {
        state: 'interrupted',
        pid: 77,
        processStartedAt: 5000,
        clientSessionId: 'c-1',
      });
      expect(updated).toMatchObject({
        state: 'interrupted',
        pid: 77,
        processStartedAt: 5000,
        clientSessionId: 'c-1',
        endedAt: null,
        createdAt: first.createdAt,
      });
      expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
      const cleared = await store.sessions.update('s1', { pid: null, processStartedAt: null });
      expect(cleared).toMatchObject({ pid: null, processStartedAt: null, state: 'interrupted' });
    });

    it('becoming closed stamps endedAt', async () => {
      const { store } = harness();
      await store.sessions.open(sampleSession('s1'));
      const closed = await store.sessions.update('s1', { state: 'closed' });
      expect(closed.state).toBe('closed');
      expect(closed.endedAt).not.toBeNull();
      expect(await store.sessions.get('s1')).toEqual(closed);
    });

    it('update rejects an unknown id with NOT_FOUND and other fields with INVALID_INPUT', async () => {
      const { store } = harness();
      await store.sessions.open(sampleSession('s1'));
      await expectCode(store.sessions.update('nope', { state: 'closed' }), 'NOT_FOUND');
      await expectCode(store.sessions.update('s1', { client: 'x' } as never), 'INVALID_INPUT');
      await expectCode(store.sessions.update('s1', { state: 'gone' as never }), 'INVALID_INPUT');
    });

    it('list is ordered by creation, then id, and filters by state, attempt, client and profile', async () => {
      const { store } = harness();
      await store.sessions.open(sampleSession('s3', { client: 'codex', profile: 'personal' }));
      await store.sessions.open(sampleSession('s1', { attemptId: 'at-1' }));
      await store.sessions.open(sampleSession('s2', { attemptId: 'at-1', state: 'interrupted' }));
      const ids = async (filter: Parameters<typeof store.sessions.list>[0]): Promise<string[]> =>
        (await store.sessions.list(filter)).map((s) => s.id);
      expect(await ids({})).toEqual(['s1', 's2', 's3']);
      expect(await ids({ states: ['interrupted'] })).toEqual(['s2']);
      expect(await ids({ attemptId: 'at-1' })).toEqual(['s1', 's2']);
      expect(await ids({ client: 'codex' })).toEqual(['s3']);
      expect(await ids({ profile: 'work' })).toEqual(['s1', 's2']);
      expect(await ids({ states: ['active', 'interrupted'], profile: 'personal' })).toEqual(['s3']);
    });
  });

  describe(`Directives conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create assigns O1, O2, O3 and the defaults of a global instruction', async () => {
      const { store, clock } = harness();
      const first = await store.directives.create(sampleDirective());
      expect(first).toEqual({
        id: 'O1',
        seq: 1,
        scope: 'global',
        scenarioId: null,
        kind: 'instruction',
        text: 'Prefer small commits',
        ruleKey: null,
        ruleValue: null,
        suspendsId: null,
        roles: [],
        startsAt: clock.now(),
        endsAt: null,
        timezone: 'America/Sao_Paulo',
        state: 'active',
        origin: 'chat',
        replacesId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        revokedAt: null,
        revokeReason: null,
      });
      const second = await store.directives.create(
        sampleDirective({ scope: 'local', scenarioId: 'scn-1', text: 'Local' }),
      );
      const third = await store.directives.create(sampleDirective({ text: 'Third' }));
      expect([second.id, third.id]).toEqual(['O2', 'O3']);
      expect(await store.directives.get('O2')).toEqual(second);
      expect(await store.directives.get('O9')).toBeUndefined();
    });

    it('a rule keeps its key and a JSON value; roles and timezone are kept', async () => {
      const { store } = harness();
      const rule = await store.directives.create(
        sampleDirective({
          kind: 'rule',
          ruleKey: 'review.max_rounds',
          ruleValue: { rounds: [1, 2], strict: true },
          roles: ['reviewer', 'critic'],
          timezone: 'UTC',
          origin: 'tui',
        }),
      );
      expect(await store.directives.get('O1')).toEqual(rule);
      expect(rule).toMatchObject({
        ruleKey: 'review.max_rounds',
        ruleValue: { rounds: [1, 2], strict: true },
        roles: ['reviewer', 'critic'],
        timezone: 'UTC',
        origin: 'tui',
      });
    });

    it('create validates the combination of fields with INVALID_INPUT', async () => {
      const { store, clock } = harness();
      const now = clock.now();
      await store.directives.create(sampleDirective());
      await store.directives.create(sampleDirective({ scope: 'local', scenarioId: 'scn-1' }));
      const invalid: NewDirective[] = [
        sampleDirective({ scope: 'local' }),
        sampleDirective({ scope: 'global', scenarioId: 'scn-1' }),
        sampleDirective({ kind: 'rule' }),
        sampleDirective({ kind: 'instruction', ruleKey: 'k' }),
        sampleDirective({ kind: 'suspension', scope: 'local', scenarioId: 'scn-1' }),
        sampleDirective({ kind: 'suspension', scope: 'global', suspendsId: 'O1' }),
        sampleDirective({
          kind: 'suspension',
          scope: 'local',
          scenarioId: 'scn-1',
          suspendsId: 'O2',
        }),
        sampleDirective({
          kind: 'suspension',
          scope: 'local',
          scenarioId: 'scn-1',
          suspendsId: 'O9',
        }),
        sampleDirective({ kind: 'instruction', suspendsId: 'O1' }),
        sampleDirective({ startsAt: now + 1000, endsAt: now + 1000 }),
        sampleDirective({ startsAt: now + 1000, endsAt: now }),
        sampleDirective({ replacesId: 'O9' }),
        sampleDirective({ text: '' }),
        sampleDirective({ origin: 'smoke' as never }),
      ];
      for (const input of invalid) {
        await expectCode(store.directives.create(input), 'INVALID_INPUT');
      }
      expect(await store.directives.list()).toHaveLength(2);
      // A rejected create does not use up a number.
      expect((await store.directives.create(sampleDirective())).id).toBe('O3');
    });

    it('the initial state follows the validity: scheduled, active or expired', async () => {
      const { store, clock } = harness();
      const now = clock.now();
      const scheduled = await store.directives.create(sampleDirective({ startsAt: now + DAY }));
      const expired = await store.directives.create(
        sampleDirective({ startsAt: now - 10_000, endsAt: now - 1 }),
      );
      const active = await store.directives.create(
        sampleDirective({ startsAt: now - 10_000, endsAt: now + DAY }),
      );
      expect([scheduled.state, expired.state, active.state]).toEqual([
        'scheduled',
        'expired',
        'active',
      ]);
    });

    it('a replacement keeps the link to the directive it replaces', async () => {
      const { store } = harness();
      await store.directives.create(sampleDirective());
      const next = await store.directives.create(sampleDirective({ replacesId: 'O1' }));
      expect(next.replacesId).toBe('O1');
    });

    it('extend changes the validity and re-derives the state', async () => {
      const { store, clock } = harness();
      const now = clock.now();
      await store.directives.create(sampleDirective({ startsAt: now + DAY }));
      const started = await store.directives.extend('O1', { startsAt: now - 10_000 });
      expect(started).toMatchObject({ startsAt: now - 10_000, endsAt: null, state: 'active' });
      const bounded = await store.directives.extend('O1', { endsAt: now + DAY });
      expect(bounded).toMatchObject({ endsAt: now + DAY, state: 'active' });
      const ended = await store.directives.extend('O1', { endsAt: now - 1 });
      expect(ended.state).toBe('expired');
      const reopened = await store.directives.extend('O1', { endsAt: null });
      expect(reopened).toMatchObject({ endsAt: null, state: 'active' });
      expect(await store.directives.get('O1')).toEqual(reopened);
    });

    it('extend rejects an unknown id, a backwards validity and a revoked directive', async () => {
      const { store, clock } = harness();
      const now = clock.now();
      await store.directives.create(sampleDirective());
      await expectCode(store.directives.extend('O9', { endsAt: now + DAY }), 'NOT_FOUND');
      await expectCode(store.directives.extend('O1', { endsAt: now }), 'INVALID_INPUT');
      await expectCode(store.directives.extend('O1', { endsAt: now - 5 }), 'INVALID_INPUT');
      await expectCode(store.directives.extend('O1', { startsAt: 'x' as never }), 'INVALID_INPUT');
      await store.directives.revoke('O1', 'no longer wanted');
      await expectCode(store.directives.extend('O1', { endsAt: now + DAY }), 'CONFLICT');
    });

    it('revoke is definitive and records the reason', async () => {
      const { store } = harness();
      await store.directives.create(sampleDirective());
      const revoked = await store.directives.revoke('O1', 'replaced by the new policy');
      expect(revoked).toMatchObject({
        state: 'revoked',
        revokeReason: 'replaced by the new policy',
      });
      expect(revoked.revokedAt).not.toBeNull();
      expect(await store.directives.get('O1')).toEqual(revoked);
      await expectCode(store.directives.revoke('O1', 'again'), 'CONFLICT');
      await expectCode(store.directives.revoke('O9', 'x'), 'NOT_FOUND');
      await expectCode(store.directives.revoke('O1', ''), 'INVALID_INPUT');
      expect((await store.directives.get('O1'))?.revokeReason).toBe('replaced by the new policy');
    });

    it('refreshStates changes nothing while the validities are the same', async () => {
      const { store, clock } = harness();
      await store.directives.create(sampleDirective());
      await store.directives.create(sampleDirective({ startsAt: clock.now() + DAY }));
      expect(await store.directives.refreshStates()).toEqual([]);
      expect((await store.directives.list()).map((d) => d.state)).toEqual(['active', 'scheduled']);
    });

    it('list is ordered by number and filters by scope, scenario, kind and state', async () => {
      const { store } = harness();
      await store.directives.create(sampleDirective());
      await store.directives.create(sampleDirective({ scope: 'local', scenarioId: 'scn-1' }));
      await store.directives.create(
        sampleDirective({ kind: 'rule', ruleKey: 'k', scope: 'local', scenarioId: 'scn-2' }),
      );
      await store.directives.revoke('O1', 'done');
      const ids = async (filter: Parameters<typeof store.directives.list>[0]): Promise<string[]> =>
        (await store.directives.list(filter)).map((d) => d.id);
      expect(await ids({})).toEqual(['O1', 'O2', 'O3']);
      expect(await ids({ scope: 'local' })).toEqual(['O2', 'O3']);
      expect(await ids({ scenarioId: 'scn-2' })).toEqual(['O3']);
      expect(await ids({ kinds: ['rule'] })).toEqual(['O3']);
      expect(await ids({ states: ['revoked'] })).toEqual(['O1']);
      expect(await ids({ states: ['active'], scope: 'local' })).toEqual(['O2', 'O3']);
    });

    it('inForce lists the active directives of the scenario and the global ones', async () => {
      const { store, clock } = harness();
      const now = clock.now();
      await store.directives.create(sampleDirective({ text: 'global' }));
      await store.directives.create(
        sampleDirective({ scope: 'local', scenarioId: 'scn-1', text: 'local 1' }),
      );
      await store.directives.create(
        sampleDirective({ scope: 'local', scenarioId: 'scn-2', text: 'local 2' }),
      );
      await store.directives.create(sampleDirective({ text: 'later', startsAt: now + DAY }));
      await store.directives.create(
        sampleDirective({ text: 'old', startsAt: now - 10_000, endsAt: now - 1 }),
      );
      await store.directives.create(sampleDirective({ text: 'revoked' }));
      await store.directives.revoke('O6', 'x');
      const texts = async (scenarioId: string, role?: string): Promise<string[]> =>
        (
          await store.directives.inForce({ scenarioId, ...(role === undefined ? {} : { role }) })
        ).map((d) => d.text);
      expect(await texts('scn-1')).toEqual(['global', 'local 1']);
      expect(await texts('scn-2')).toEqual(['global', 'local 2']);
      expect(await texts('scn-3')).toEqual(['global']);
    });

    it('inForce removes the global directive a local suspension takes out', async () => {
      const { store } = harness();
      await store.directives.create(sampleDirective({ text: 'global 1' }));
      await store.directives.create(sampleDirective({ text: 'global 2' }));
      await store.directives.create({
        scope: 'local',
        scenarioId: 'scn-1',
        kind: 'suspension',
        suspendsId: 'O1',
        text: 'not here',
        origin: 'chat',
      });
      const texts = async (scenarioId: string): Promise<string[]> =>
        (await store.directives.inForce({ scenarioId })).map((d) => d.text);
      expect(await texts('scn-1')).toEqual(['global 2', 'not here']);
      expect(await texts('scn-2')).toEqual(['global 1', 'global 2']);
      await store.directives.revoke('O3', 'back on');
      expect(await texts('scn-1')).toEqual(['global 1', 'global 2']);
    });

    it('inForce filters by role: a directive without roles reaches every role', async () => {
      const { store } = harness();
      await store.directives.create(sampleDirective({ text: 'everyone' }));
      await store.directives.create(sampleDirective({ text: 'reviewers', roles: ['reviewer'] }));
      await store.directives.create(
        sampleDirective({ text: 'planners', roles: ['planner', 'critic'] }),
      );
      const texts = async (role?: string): Promise<string[]> =>
        (
          await store.directives.inForce({
            scenarioId: 'scn-1',
            ...(role === undefined ? {} : { role }),
          })
        ).map((d) => d.text);
      expect(await texts()).toEqual(['everyone', 'reviewers', 'planners']);
      expect(await texts('reviewer')).toEqual(['everyone', 'reviewers']);
      expect(await texts('critic')).toEqual(['everyone', 'planners']);
      expect(await texts('implementer')).toEqual(['everyone']);
    });
  });
}
