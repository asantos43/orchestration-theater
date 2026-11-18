// SPDX-License-Identifier: MPL-2.0
import type {
  NewExecutor,
  NewInterruption,
  NewProfile,
  NewQuotaSnapshot,
  NewUsage,
  NewWakeup,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { expectCode, type AggregateHarness } from './aggregate-support.js';

export function sampleProfile(extra: Partial<NewProfile> = {}): NewProfile {
  return {
    client: 'claude-code',
    name: 'work',
    kind: 'token_plan',
    provider: 'anthropic',
    dir: 'profiles/claude-code/work',
    ...extra,
  };
}

export function sampleExecutor(extra: Partial<NewExecutor> = {}): NewExecutor {
  return {
    profileId: 'claude-code/work',
    model: 'opus',
    effort: 'high',
    provider: 'anthropic',
    ...extra,
  };
}

export function sampleInterruption(extra: Partial<NewInterruption> = {}): NewInterruption {
  return { sessionId: 'ses-1', cause: 'quota_exhausted', ...extra };
}

export function sampleQuotaSnapshot(extra: Partial<NewQuotaSnapshot> = {}): NewQuotaSnapshot {
  return {
    profileId: 'claude-code/work',
    window: '5h',
    usedPercent: 40,
    source: 'probe',
    ...extra,
  };
}

export function sampleUsage(extra: Partial<NewUsage> = {}): NewUsage {
  return {
    sessionId: 'ses-1',
    profileId: 'claude-code/work',
    executorId: 'opus-high@claude-code/work',
    model: 'opus',
    ...extra,
  };
}

export function sampleWakeup(extra: Partial<NewWakeup> = {}): NewWakeup {
  return { profileId: 'claude-code/work', cause: 'quota', at: 5_000, ...extra };
}

/**
 * Registers the conformance tests of the tables of Phase 5 (section 7): `store.profiles`,
 * `store.executors`, `store.interruptions`, `store.quotaSnapshots`, `store.usage` and
 * `store.wakeups`.
 */
export function describeProfileAggregatesConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Profiles conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create assigns <client>/<name>, stores the profile active and get reads it back', async () => {
      const { store, clock } = harness();
      const created = await store.profiles.create(sampleProfile());
      expect(created).toEqual({
        id: 'claude-code/work',
        client: 'claude-code',
        name: 'work',
        kind: 'token_plan',
        provider: 'anthropic',
        state: 'active',
        dir: 'profiles/claude-code/work',
        secretRef: null,
        noticeAcceptedAt: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        removedAt: null,
      });
      expect(await store.profiles.get('claude-code/work')).toEqual(created);
      expect(await store.profiles.get('codex/none')).toBeUndefined();
      const api = await store.profiles.create(
        sampleProfile({ client: 'codex', name: 'api', kind: 'api', secretRef: 'vault:codex-api' }),
      );
      expect(api).toMatchObject({ id: 'codex/api', kind: 'api', secretRef: 'vault:codex-api' });
    });

    it('rejects a bad input with InvalidInput and a repeated id with Conflict', async () => {
      const { store } = harness();
      await expectCode(store.profiles.create(sampleProfile({ name: 'Bad Name' })), 'INVALID_INPUT');
      await expectCode(store.profiles.create(sampleProfile({ client: '' })), 'INVALID_INPUT');
      await expectCode(
        store.profiles.create(sampleProfile({ kind: 'free' as unknown as 'api' })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.profiles.create({ ...sampleProfile(), state: 'removed' } as unknown as NewProfile),
        'INVALID_INPUT',
      );
      await store.profiles.create(sampleProfile());
      await expectCode(store.profiles.create(sampleProfile()), 'CONFLICT');
      expect(await store.profiles.list()).toHaveLength(1);
    });

    it('list filters by client, kind, provider and state, ordered by creation then id', async () => {
      const { store } = harness();
      await store.profiles.create(sampleProfile({ name: 'b' }));
      await store.profiles.create(sampleProfile({ name: 'a' }));
      await store.profiles.create(
        sampleProfile({ client: 'codex', name: 'c', provider: 'openai', kind: 'api' }),
      );
      await store.profiles.update('claude-code/a', { state: 'draining' });
      const ids = async (filter: Parameters<typeof store.profiles.list>[0]): Promise<string[]> =>
        (await store.profiles.list(filter)).map((profile) => profile.id);
      expect(await ids(undefined)).toEqual(['claude-code/a', 'claude-code/b', 'codex/c']);
      expect(await ids({ client: 'claude-code' })).toEqual(['claude-code/a', 'claude-code/b']);
      expect(await ids({ kind: 'api' })).toEqual(['codex/c']);
      expect(await ids({ provider: 'openai' })).toEqual(['codex/c']);
      expect(await ids({ states: ['draining'] })).toEqual(['claude-code/a']);
      expect(await ids({ states: ['active', 'removed'], client: 'claude-code' })).toEqual([
        'claude-code/b',
      ]);
      expect(await ids({ states: [] })).toEqual([]);
    });

    it('update changes the fields and walks active -> draining -> removed', async () => {
      const { store, clock } = harness();
      await store.profiles.create(sampleProfile());
      const accepted = await store.profiles.update('claude-code/work', {
        noticeAcceptedAt: 1_234,
        secretRef: 'vault:k',
        dir: 'elsewhere',
      });
      expect(accepted).toMatchObject({
        noticeAcceptedAt: 1_234,
        secretRef: 'vault:k',
        dir: 'elsewhere',
        state: 'active',
        provider: 'anthropic',
      });
      const cleared = await store.profiles.update('claude-code/work', { secretRef: null });
      expect(cleared).toMatchObject({ secretRef: null, noticeAcceptedAt: 1_234 });
      const draining = await store.profiles.update('claude-code/work', { state: 'draining' });
      expect(draining).toMatchObject({ state: 'draining', removedAt: null });
      const again = await store.profiles.update('claude-code/work', { state: 'active' });
      expect(again.state).toBe('active');
      await store.profiles.update('claude-code/work', { state: 'draining' });
      const removed = await store.profiles.update('claude-code/work', { state: 'removed' });
      expect(removed).toMatchObject({ state: 'removed', removedAt: clock.now() });
      expect(await store.profiles.get('claude-code/work')).toEqual(removed);
    });

    it('a state change outside the lifecycle is Conflict; bad patch is InvalidInput; unknown is NotFound', async () => {
      const { store } = harness();
      await store.profiles.create(sampleProfile());
      await expectCode(store.profiles.update('claude-code/work', { state: 'removed' }), 'CONFLICT');
      await store.profiles.update('claude-code/work', { state: 'draining' });
      await store.profiles.update('claude-code/work', { state: 'removed' });
      await expectCode(store.profiles.update('claude-code/work', { state: 'active' }), 'CONFLICT');
      await expectCode(store.profiles.update('claude-code/work', { dir: '' }), 'INVALID_INPUT');
      await expectCode(
        store.profiles.update('claude-code/work', { id: 'x' } as never),
        'INVALID_INPUT',
      );
      await expectCode(store.profiles.update('claude-code/nope', { dir: 'x' }), 'NOT_FOUND');
      // A removed profile keeps its name: it cannot be created again.
      await expectCode(store.profiles.create(sampleProfile()), 'CONFLICT');
    });
  });

  describe(`Executors conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create builds <model>-<effort>@<client>/<profile> and stores the Executor valid', async () => {
      const { store, clock } = harness();
      const created = await store.executors.create(sampleExecutor());
      expect(created).toEqual({
        id: 'opus-high@claude-code/work',
        profileId: 'claude-code/work',
        model: 'opus',
        effort: 'high',
        provider: 'anthropic',
        validity: 'valid',
        invalidReason: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
      expect(await store.executors.get('opus-high@claude-code/work')).toEqual(created);
      expect(await store.executors.get('opus-low@claude-code/work')).toBeUndefined();
      const noEffort = await store.executors.create(sampleExecutor({ model: 'm2', effort: null }));
      expect(noEffort).toMatchObject({ id: 'm2@claude-code/work', effort: null });
    });

    it('does not need the profile to exist, rejects a bad input and a repeated id', async () => {
      const { store } = harness();
      const orphan = await store.executors.create(sampleExecutor({ profileId: 'codex/gone' }));
      expect(orphan.id).toBe('opus-high@codex/gone');
      await expectCode(store.executors.create(sampleExecutor({ model: '' })), 'INVALID_INPUT');
      await expectCode(store.executors.create(sampleExecutor({ model: 'a@b' })), 'INVALID_INPUT');
      await expectCode(store.executors.create(sampleExecutor({ provider: '' })), 'INVALID_INPUT');
      await expectCode(
        store.executors.create({
          ...sampleExecutor(),
          validity: 'invalid',
        } as unknown as NewExecutor),
        'INVALID_INPUT',
      );
      await expectCode(
        store.executors.create(sampleExecutor({ profileId: 'codex/gone' })),
        'CONFLICT',
      );
    });

    it('list filters by profile, provider and validity, ordered by id', async () => {
      const { store } = harness();
      await store.executors.create(sampleExecutor({ model: 'sonnet', effort: 'low' }));
      await store.executors.create(sampleExecutor());
      await store.executors.create(
        sampleExecutor({ profileId: 'codex/api', model: 'gpt', provider: 'openai' }),
      );
      await store.executors.update('opus-high@claude-code/work', {
        validity: 'invalid',
        invalidReason: 'profile_removed',
      });
      const ids = async (filter: Parameters<typeof store.executors.list>[0]): Promise<string[]> =>
        (await store.executors.list(filter)).map((executor) => executor.id);
      expect(await ids(undefined)).toEqual([
        'gpt-high@codex/api',
        'opus-high@claude-code/work',
        'sonnet-low@claude-code/work',
      ]);
      expect(await ids({ profileId: 'codex/api' })).toEqual(['gpt-high@codex/api']);
      expect(await ids({ provider: 'anthropic', validity: 'valid' })).toEqual([
        'sonnet-low@claude-code/work',
      ]);
      expect(await ids({ validity: 'invalid' })).toEqual(['opus-high@claude-code/work']);
    });

    it('update changes the provider and the validity; valid clears the reason', async () => {
      const { store, clock } = harness();
      await store.executors.create(sampleExecutor());
      const id = 'opus-high@claude-code/work';
      const invalid = await store.executors.update(id, {
        validity: 'invalid',
        invalidReason: 'profile_removed',
      });
      expect(invalid).toMatchObject({
        validity: 'invalid',
        invalidReason: 'profile_removed',
        updatedAt: clock.now(),
      });
      const moved = await store.executors.update(id, { provider: 'other' });
      expect(moved).toMatchObject({
        provider: 'other',
        validity: 'invalid',
        invalidReason: 'profile_removed',
      });
      const valid = await store.executors.update(id, { validity: 'valid' });
      expect(valid).toMatchObject({ validity: 'valid', invalidReason: null });
      await expectCode(store.executors.update(id, { provider: '' }), 'INVALID_INPUT');
      await expectCode(store.executors.update('x@y/z', { provider: 'p' }), 'NOT_FOUND');
    });
  });

  describe(`Interruptions conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create assigns X1, X2 and applies the defaults', async () => {
      const { store, clock } = harness();
      const first = await store.interruptions.create(sampleInterruption());
      expect(first).toEqual({
        id: 'X1',
        seq: 1,
        sessionId: 'ses-1',
        playId: null,
        cause: 'quota_exhausted',
        signals: [],
        resumeForm: null,
        fromExecutor: null,
        toExecutor: null,
        countedAsAttempt: false,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
      const second = await store.interruptions.create(
        sampleInterruption({
          playId: 'play-1',
          cause: 'client_crash',
          signals: ['exit_code:1', 'stderr:segfault'],
          resumeForm: 'handoff',
          fromExecutor: 'opus-high@claude-code/work',
          toExecutor: 'gpt-high@codex/api',
          countedAsAttempt: true,
        }),
      );
      expect(second).toMatchObject({
        id: 'X2',
        playId: 'play-1',
        signals: ['exit_code:1', 'stderr:segfault'],
        resumeForm: 'handoff',
        toExecutor: 'gpt-high@codex/api',
        countedAsAttempt: true,
      });
      expect(await store.interruptions.get('X2')).toEqual(second);
      expect(await store.interruptions.get('X1')).toEqual(first);
      expect(await store.interruptions.get('X9')).toBeUndefined();
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store } = harness();
      await expectCode(
        store.interruptions.create(sampleInterruption({ cause: 'meteor' as never })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.interruptions.create(sampleInterruption({ sessionId: '' })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.interruptions.create(sampleInterruption({ resumeForm: 'magic' as never })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.interruptions.create(sampleInterruption({ signals: [''] })),
        'INVALID_INPUT',
      );
      expect(await store.interruptions.list()).toEqual([]);
    });

    it('list filters by session, play and cause and orders by arrival', async () => {
      const { store } = harness();
      await store.interruptions.create(sampleInterruption());
      await store.interruptions.create(
        sampleInterruption({ sessionId: 'ses-2', playId: 'play-1', cause: 'timeout' }),
      );
      await store.interruptions.create(sampleInterruption({ playId: 'play-1', cause: 'stuck' }));
      const ids = async (
        filter: Parameters<typeof store.interruptions.list>[0],
      ): Promise<string[]> => (await store.interruptions.list(filter)).map((it) => it.id);
      expect(await ids(undefined)).toEqual(['X1', 'X2', 'X3']);
      expect(await ids({ sessionId: 'ses-1' })).toEqual(['X1', 'X3']);
      expect(await ids({ playId: 'play-1' })).toEqual(['X2', 'X3']);
      expect(await ids({ causes: ['timeout', 'stuck'] })).toEqual(['X2', 'X3']);
      expect(await ids({ causes: ['timeout'], playId: 'play-1' })).toEqual(['X2']);
    });

    it('update records how it was resumed and keeps what it leaves out', async () => {
      const { store } = harness();
      await store.interruptions.create(sampleInterruption({ signals: ['a'] }));
      const resumed = await store.interruptions.update('X1', {
        resumeForm: 'native',
        toExecutor: 'opus-high@claude-code/other',
        countedAsAttempt: true,
      });
      expect(resumed).toMatchObject({
        resumeForm: 'native',
        toExecutor: 'opus-high@claude-code/other',
        countedAsAttempt: true,
        signals: ['a'],
      });
      const cleared = await store.interruptions.update('X1', {
        resumeForm: null,
        toExecutor: null,
        countedAsAttempt: false,
        signals: ['a', 'b'],
      });
      expect(cleared).toMatchObject({
        resumeForm: null,
        toExecutor: null,
        countedAsAttempt: false,
        signals: ['a', 'b'],
      });
      expect(await store.interruptions.get('X1')).toEqual(cleared);
      await expectCode(
        store.interruptions.update('X1', { cause: 'stuck' } as never),
        'INVALID_INPUT',
      );
      await expectCode(store.interruptions.update('X9', { countedAsAttempt: true }), 'NOT_FOUND');
    });
  });

  describe(`Quota snapshots conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('put creates the row of a window and get reads it back', async () => {
      const { store, clock } = harness();
      const created = await store.quotaSnapshots.put(sampleQuotaSnapshot());
      expect(created).toEqual({
        profileId: 'claude-code/work',
        window: '5h',
        usedPercent: 40,
        resetsAt: null,
        source: 'probe',
        observedAt: clock.now(),
        updatedAt: clock.now(),
      });
      expect(await store.quotaSnapshots.get('claude-code/work', '5h')).toEqual(created);
      expect(await store.quotaSnapshots.get('claude-code/work', '7d')).toBeUndefined();
      expect(await store.quotaSnapshots.get('codex/x', '5h')).toBeUndefined();
    });

    it('put on the same profile and window replaces the reading', async () => {
      const { store } = harness();
      await store.quotaSnapshots.put(sampleQuotaSnapshot());
      const next = await store.quotaSnapshots.put(
        sampleQuotaSnapshot({
          usedPercent: 97.5,
          resetsAt: 9_000,
          source: 'client_signal',
          observedAt: 4_000,
        }),
      );
      expect(next).toMatchObject({
        usedPercent: 97.5,
        resetsAt: 9_000,
        source: 'client_signal',
        observedAt: 4_000,
      });
      expect(await store.quotaSnapshots.list()).toEqual([next]);
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store } = harness();
      await expectCode(
        store.quotaSnapshots.put(sampleQuotaSnapshot({ usedPercent: -1 })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.quotaSnapshots.put(sampleQuotaSnapshot({ window: '' })),
        'INVALID_INPUT',
      );
      await expectCode(
        store.quotaSnapshots.put(sampleQuotaSnapshot({ source: '' })),
        'INVALID_INPUT',
      );
      expect(await store.quotaSnapshots.list()).toEqual([]);
    });

    it('list filters by profile and windows, ordered by profile then window', async () => {
      const { store } = harness();
      await store.quotaSnapshots.put(sampleQuotaSnapshot({ window: '7d' }));
      await store.quotaSnapshots.put(sampleQuotaSnapshot({ profileId: 'codex/a' }));
      await store.quotaSnapshots.put(sampleQuotaSnapshot());
      const keys = async (
        filter: Parameters<typeof store.quotaSnapshots.list>[0],
      ): Promise<string[]> =>
        (await store.quotaSnapshots.list(filter)).map((q) => `${q.profileId}:${q.window}`);
      expect(await keys(undefined)).toEqual([
        'claude-code/work:5h',
        'claude-code/work:7d',
        'codex/a:5h',
      ]);
      expect(await keys({ profileId: 'claude-code/work' })).toEqual([
        'claude-code/work:5h',
        'claude-code/work:7d',
      ]);
      expect(await keys({ windows: ['5h'] })).toEqual(['claude-code/work:5h', 'codex/a:5h']);
      expect(await keys({ windows: [] })).toEqual([]);
    });
  });

  describe(`Usage conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('record assigns U1, U2 and keeps unknown tokens and cost as null, never zero', async () => {
      const { store, clock } = harness();
      const first = await store.usage.record(sampleUsage());
      expect(first).toEqual({
        id: 'U1',
        seq: 1,
        sessionId: 'ses-1',
        playId: null,
        profileId: 'claude-code/work',
        executorId: 'opus-high@claude-code/work',
        model: 'opus',
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        costUsd: null,
        costKind: null,
        costSource: null,
        pricingVersion: null,
        occurredAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
      const second = await store.usage.record(
        sampleUsage({
          playId: 'play-1',
          inputTokens: 1200,
          outputTokens: 0,
          cachedTokens: 800,
          cost: {
            usd: 0.0123,
            kind: 'api_equivalent',
            source: 'pricing_table',
            pricingVersion: 'p1',
          },
          occurredAt: 777,
        }),
      );
      expect(second).toMatchObject({
        id: 'U2',
        playId: 'play-1',
        inputTokens: 1200,
        outputTokens: 0,
        cachedTokens: 800,
        costUsd: 0.0123,
        costKind: 'api_equivalent',
        costSource: 'pricing_table',
        pricingVersion: 'p1',
        occurredAt: 777,
      });
      expect(await store.usage.get('U2')).toEqual(second);
      expect(await store.usage.get('U9')).toBeUndefined();
    });

    it('a cost by pricing_table needs its pricingVersion; a client cost does not', async () => {
      const { store } = harness();
      await expectCode(
        store.usage.record(
          sampleUsage({ cost: { usd: 1, kind: 'real', source: 'pricing_table' } }),
        ),
        'INVALID_INPUT',
      );
      const fromClient = await store.usage.record(
        sampleUsage({ cost: { usd: 0, kind: 'real', source: 'client' } }),
      );
      expect(fromClient).toMatchObject({
        costUsd: 0,
        costKind: 'real',
        costSource: 'client',
        pricingVersion: null,
      });
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store } = harness();
      await expectCode(store.usage.record(sampleUsage({ sessionId: '' })), 'INVALID_INPUT');
      await expectCode(store.usage.record(sampleUsage({ inputTokens: -1 })), 'INVALID_INPUT');
      await expectCode(store.usage.record(sampleUsage({ inputTokens: 1.5 })), 'INVALID_INPUT');
      await expectCode(
        store.usage.record(sampleUsage({ cost: { usd: -1, kind: 'real', source: 'client' } })),
        'INVALID_INPUT',
      );
      expect(await store.usage.list()).toEqual([]);
    });

    it('list filters by session, play, profile, Executor and time, ordered by moment then seq', async () => {
      const { store } = harness();
      await store.usage.record(sampleUsage({ occurredAt: 300 }));
      await store.usage.record(
        sampleUsage({
          sessionId: 'ses-2',
          profileId: 'codex/api',
          executorId: 'g@codex/api',
          occurredAt: 100,
        }),
      );
      await store.usage.record(sampleUsage({ playId: 'play-1', occurredAt: 200 }));
      await store.usage.record(sampleUsage({ occurredAt: 200 }));
      const ids = async (filter: Parameters<typeof store.usage.list>[0]): Promise<string[]> =>
        (await store.usage.list(filter)).map((u) => u.id);
      expect(await ids(undefined)).toEqual(['U2', 'U3', 'U4', 'U1']);
      expect(await ids({ sessionId: 'ses-1' })).toEqual(['U3', 'U4', 'U1']);
      expect(await ids({ profileId: 'codex/api' })).toEqual(['U2']);
      expect(await ids({ executorId: 'g@codex/api' })).toEqual(['U2']);
      expect(await ids({ playId: 'play-1' })).toEqual(['U3']);
      expect(await ids({ since: 200 })).toEqual(['U3', 'U4', 'U1']);
      expect(await ids({ until: 200 })).toEqual(['U2', 'U3', 'U4']);
      expect(await ids({ since: 150, until: 250, profileId: 'claude-code/work' })).toEqual([
        'U3',
        'U4',
      ]);
      expect(await ids({ since: 301 })).toEqual([]);
    });

    it('update fills in the tokens and the priced cost and keeps what it leaves out', async () => {
      const { store, clock } = harness();
      await store.usage.record(sampleUsage({ inputTokens: 10 }));
      const priced = await store.usage.update('U1', {
        outputTokens: 5,
        cost: { usd: 0.5, kind: 'real', source: 'client' },
      });
      expect(priced).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: null,
        costUsd: 0.5,
        costKind: 'real',
        costSource: 'client',
        updatedAt: clock.now(),
      });
      const repriced = await store.usage.update('U1', {
        cost: { usd: 0.7, kind: 'api_equivalent', source: 'pricing_table', pricingVersion: 'p2' },
      });
      expect(repriced).toMatchObject({ costUsd: 0.7, pricingVersion: 'p2', inputTokens: 10 });
      expect(await store.usage.get('U1')).toEqual(repriced);
      await expectCode(store.usage.update('U1', { inputTokens: -1 }), 'INVALID_INPUT');
      await expectCode(
        store.usage.update('U1', { cost: { usd: 1, kind: 'real', source: 'pricing_table' } }),
        'INVALID_INPUT',
      );
      await expectCode(store.usage.update('U9', { inputTokens: 1 }), 'NOT_FOUND');
    });
  });

  describe(`Wakeups conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('create assigns W1, W2 and stores the wakeup scheduled', async () => {
      const { store, clock } = harness();
      const first = await store.wakeups.create(sampleWakeup());
      expect(first).toEqual({
        id: 'W1',
        seq: 1,
        profileId: 'claude-code/work',
        cause: 'quota',
        at: 5_000,
        state: 'scheduled',
        osTriggerId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
      const second = await store.wakeups.create(
        sampleWakeup({ cause: 'budget', at: 6_000, osTriggerId: 'timer-1' }),
      );
      expect(second).toMatchObject({ id: 'W2', cause: 'budget', osTriggerId: 'timer-1' });
      expect(await store.wakeups.get('W2')).toEqual(second);
      expect(await store.wakeups.get('W9')).toBeUndefined();
    });

    it('rejects a bad input with InvalidInput', async () => {
      const { store } = harness();
      await expectCode(
        store.wakeups.create(sampleWakeup({ cause: 'moon' as never })),
        'INVALID_INPUT',
      );
      await expectCode(store.wakeups.create(sampleWakeup({ at: -1 })), 'INVALID_INPUT');
      await expectCode(store.wakeups.create(sampleWakeup({ profileId: '' })), 'INVALID_INPUT');
      expect(await store.wakeups.list()).toEqual([]);
    });

    it('allows one scheduled wakeup per profile and cause; a settled one does not count', async () => {
      const { store } = harness();
      await store.wakeups.create(sampleWakeup());
      await expectCode(store.wakeups.create(sampleWakeup({ at: 9_000 })), 'CONFLICT');
      await store.wakeups.create(sampleWakeup({ cause: 'budget' }));
      await store.wakeups.create(sampleWakeup({ profileId: 'codex/a' }));
      await store.wakeups.update('W1', { state: 'fired' });
      const again = await store.wakeups.create(sampleWakeup({ at: 9_000 }));
      expect(again).toMatchObject({ id: 'W4', state: 'scheduled', at: 9_000 });
      await expectCode(store.wakeups.create(sampleWakeup()), 'CONFLICT');
      expect(
        await store.wakeups.list({ profileId: 'claude-code/work', cause: 'quota' }),
      ).toHaveLength(2);
    });

    it('list filters by profile, cause, state and due moment, ordered by moment then seq', async () => {
      const { store } = harness();
      await store.wakeups.create(sampleWakeup({ at: 300 }));
      await store.wakeups.create(sampleWakeup({ cause: 'budget', at: 100 }));
      await store.wakeups.create(sampleWakeup({ profileId: 'codex/a', at: 200 }));
      await store.wakeups.update('W2', { state: 'cancelled' });
      const ids = async (filter: Parameters<typeof store.wakeups.list>[0]): Promise<string[]> =>
        (await store.wakeups.list(filter)).map((w) => w.id);
      expect(await ids(undefined)).toEqual(['W2', 'W3', 'W1']);
      expect(await ids({ profileId: 'codex/a' })).toEqual(['W3']);
      expect(await ids({ cause: 'budget' })).toEqual(['W2']);
      expect(await ids({ states: ['scheduled'] })).toEqual(['W3', 'W1']);
      expect(await ids({ states: ['scheduled'], dueBy: 250 })).toEqual(['W3']);
      expect(await ids({ dueBy: 99 })).toEqual([]);
    });

    it('update moves a scheduled wakeup, sets the OS trigger and settles it once', async () => {
      const { store, clock } = harness();
      await store.wakeups.create(sampleWakeup());
      const moved = await store.wakeups.update('W1', { at: 7_000, osTriggerId: 'timer-9' });
      expect(moved).toMatchObject({ at: 7_000, osTriggerId: 'timer-9', state: 'scheduled' });
      const cleared = await store.wakeups.update('W1', { osTriggerId: null });
      expect(cleared.osTriggerId).toBeNull();
      const fired = await store.wakeups.update('W1', { state: 'fired' });
      expect(fired).toMatchObject({ state: 'fired', at: 7_000, updatedAt: clock.now() });
      expect(await store.wakeups.get('W1')).toEqual(fired);
      await expectCode(store.wakeups.update('W1', { state: 'cancelled' }), 'CONFLICT');
      await expectCode(store.wakeups.update('W1', { at: 1 }), 'CONFLICT');
      await expectCode(store.wakeups.update('W9', { at: 1 }), 'NOT_FOUND');
      await store.wakeups.create(sampleWakeup());
      await expectCode(
        store.wakeups.update('W2', { state: 'scheduled' as never }),
        'INVALID_INPUT',
      );
    });
  });

  describe(`Phase 5 tables in a transaction: ${name}`, () => {
    const harness = useHarness(factory);

    it('reads see the writes and a rollback drops them all', async () => {
      const { store } = harness();
      const failure = new Error('boom');
      const error = await store
        .transaction(async (tx) => {
          await tx.profiles.create(sampleProfile());
          await tx.executors.create(sampleExecutor());
          await tx.interruptions.create(sampleInterruption());
          await tx.quotaSnapshots.put(sampleQuotaSnapshot());
          await tx.usage.record(sampleUsage());
          await tx.wakeups.create(sampleWakeup());
          expect((await tx.profiles.list()).map((p) => p.id)).toEqual(['claude-code/work']);
          expect(await tx.quotaSnapshots.list()).toHaveLength(1);
          throw failure;
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBe(failure);
      expect(await store.profiles.list()).toEqual([]);
      expect(await store.executors.list()).toEqual([]);
      expect(await store.interruptions.list()).toEqual([]);
      expect(await store.quotaSnapshots.list()).toEqual([]);
      expect(await store.usage.list()).toEqual([]);
      expect(await store.wakeups.list()).toEqual([]);
      expect((await store.usage.record(sampleUsage())).id).toBe('U1');
    });

    it('a committed transaction shows all of its rows at once', async () => {
      const { store } = harness();
      await store.transaction(async (tx) => {
        await tx.profiles.create(sampleProfile());
        await tx.wakeups.create(sampleWakeup());
      });
      expect(await store.profiles.get('claude-code/work')).toBeDefined();
      expect(await store.wakeups.get('W1')).toBeDefined();
    });
  });
}
