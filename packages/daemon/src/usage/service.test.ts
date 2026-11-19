// SPDX-License-Identifier: MPL-2.0
import { builtInPricing, mergePricing, type EventEnvelope } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { RecordingSituations } from '../test-helpers.js';
import { UNKNOWN_MODEL, UsageService } from './service.js';
import type { UsageSettings } from './settings.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const API = 'claude-code/api';
const WORK = 'claude-code/work';
const CODEX = 'codex/home';

/** A report of a session: the same shape the fake agent sends as a `usage` quota signal. */
const signal = (
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd?: number,
) => ({
  sessionId,
  signal: {
    kind: 'usage' as const,
    model,
    inputTokens,
    outputTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  },
});

function settingsOf(over: Partial<UsageSettings> = {}): UsageSettings {
  return {
    subscriptionDisplay: 'quota_and_equivalent',
    costSource: 'client_then_pricing',
    monthlyPriceUsd: new Map(),
    pricing: builtInPricing(),
    ...over,
  };
}

interface Warning {
  readonly message: string;
}

function setup(over: Partial<UsageSettings> = {}) {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const warnings: Warning[] = [];
  const logger = pino(
    { level: 'warn' },
    {
      write: (line: string) => {
        warnings.push({ message: (JSON.parse(line) as { msg: string }).msg });
      },
    },
  );
  const situations = new RecordingSituations();
  const service = new UsageService({
    store,
    clock,
    settings: settingsOf(over),
    logger,
    situations,
  });
  return { clock, store, service, warnings, situations };
}

async function openProfiles(store: InMemoryStore): Promise<void> {
  await store.profiles.create({
    client: 'claude-code',
    name: 'api',
    kind: 'api',
    provider: 'anthropic',
    dir: '/p/api',
  });
  await store.profiles.create({
    client: 'claude-code',
    name: 'work',
    kind: 'token_plan',
    provider: 'anthropic',
    dir: '/p/work',
  });
  await store.profiles.create({
    client: 'codex',
    name: 'home',
    kind: 'token_plan',
    provider: 'openai',
    dir: '/p/home',
  });
}

async function usageEvents(store: InMemoryStore): Promise<EventEnvelope[]> {
  return (await store.events.readFrom(0, 1000)).filter((e) => e.type === 'usage.recorded');
}

const opus = (profile: string) => `claude-opus-high@${profile}`;

describe('UsageService, the cost of a turn (architecture 5.6)', () => {
  it('prices the tokens of an API profile by the table: the real cost is tokens x price', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API), playId: 'play-1' });
    const row = await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    // 1000 x 4 + 200 x 20 US$ per million tokens
    expect(row).toMatchObject({
      sessionId: 'S1',
      playId: 'play-1',
      profileId: API,
      executorId: opus(API),
      model: 'claude-opus-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      costKind: 'real',
      costSource: 'pricing_table',
      pricingVersion: builtInPricing().version,
    });
    expect(row?.costUsd).toBeCloseTo(0.008, 12);
    const totals = await service.totals({ sessionId: 'S1' });
    expect(totals).toMatchObject({
      turns: 1,
      inputTokens: 1000,
      outputTokens: 200,
      apiEquivalentUsd: 0,
      unknownCostTurns: 0,
      complete: true,
    });
    expect(totals.realUsd).toBeCloseTo(0.008, 12);
  });

  it('writes the usage.recorded event of each turn, with what the row holds', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    const row = await service.ingestNotification(signal('S1', 'claude-sonnet-5-5', 2000, 500));
    const events = await usageEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      usageId: row?.id,
      sessionId: 'S1',
      playId: null,
      profile: API,
      executor: opus(API),
      model: 'claude-sonnet-5-5',
      inputTokens: 2000,
      outputTokens: 500,
      cachedTokens: null,
      costUsd: row?.costUsd,
      costKind: 'real',
      costSource: 'pricing_table',
      pricingVersion: builtInPricing().version,
      occurredAt: T0,
    });
  });

  it('client_then_pricing: the cost the client reports wins over the table', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    const row = await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200, 0.5));
    expect(row).toMatchObject({ costUsd: 0.5, costKind: 'real', costSource: 'client' });
    expect(row?.pricingVersion).toBeNull();
    expect((await service.totals()).realUsd).toBe(0.5);
  });

  it('client_then_pricing: with no cost from the client, the table prices the tokens', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    const row = await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    expect(row?.costSource).toBe('pricing_table');
  });

  it('pricing_table: ignores the cost of the client and prices the tokens', async () => {
    const { service, store } = setup({ costSource: 'pricing_table' });
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    const row = await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200, 9.99));
    expect(row).toMatchObject({ costKind: 'real', costSource: 'pricing_table' });
    expect(row?.costUsd).toBeCloseTo(0.008, 12);
  });

  it('records a model with no price as unknown (null), never US$ 0, and flags the sum', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: 'minimax-m2@claude-code/api' });
    const unknown = await service.ingestNotification(signal('S1', 'minimax-m2', 5000, 100));
    expect(unknown).toMatchObject({
      model: 'minimax-m2',
      inputTokens: 5000,
      costUsd: null,
      costKind: null,
      costSource: null,
      pricingVersion: null,
    });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    const totals = await service.totals({ sessionId: 'S1' });
    expect(totals.turns).toBe(2);
    expect(totals.unknownCostTurns).toBe(1);
    expect(totals.complete).toBe(false);
    // The sum is the lower bound of the priced turn: the unknown one adds nothing, and says so.
    expect(totals.realUsd).toBeCloseTo(0.008, 12);
    const events = await usageEvents(store);
    expect(events[0]?.payload).toMatchObject({ costUsd: null, costKind: null, costSource: null });
  });

  it('a model with no price still has an unknown cost when the client sends tokens without one, under pricing_table', async () => {
    const { service, store } = setup({ costSource: 'pricing_table' });
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: 'x@claude-code/api' });
    const row = await service.ingestNotification(signal('S1', 'some-new-model', 10, 10, 1));
    expect(row?.costUsd).toBeNull();
  });

  it('keeps the API equivalent of a subscription apart: it is never summed into the real spend', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    service.bindSession('S2', { profile: WORK, executorId: opus(WORK) });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    const equivalent = await service.ingestNotification(signal('S2', 'claude-opus-5-5', 1000, 200));
    expect(equivalent).toMatchObject({ profileId: WORK, costKind: 'api_equivalent' });
    const whole = await service.totals();
    expect(whole.realUsd).toBeCloseTo(0.008, 12);
    expect(whole.apiEquivalentUsd).toBeCloseTo(0.008, 12);
    const work = await service.totals({ profileId: WORK });
    expect(work.realUsd).toBe(0);
    expect(work.apiEquivalentUsd).toBeCloseTo(0.008, 12);
  });

  it('takes the profile of a session the store does not know as a subscription (an estimate, not spending)', async () => {
    const { service, warnings } = setup();
    service.bindSession('S1', { profile: 'claude-code/ghost', executorId: 'x@claude-code/ghost' });
    const row = await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    expect(row?.costKind).toBe('api_equivalent');
    expect(warnings.some((w) => w.message.includes('does not know'))).toBe(true);
  });

  it('prices an OpenAI model whose cached tokens are inside the input', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: CODEX, executorId: 'codex-sol-high@codex/home' });
    const row = await service.ingestUpdate('S1', {
      kind: 'usage',
      model: 'gpt-6-sol',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 400_000,
    } as never);
    // 600k fresh x 2 + 400k cached x 0.2
    expect(row?.costUsd).toBeCloseTo(1.28, 9);
    expect(row?.cachedTokens).toBe(400_000);
  });

  it('skips the tokens of the PromptResponse: the quota ledger counts them, the cost stays once (N156)', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: CODEX, executorId: 'codex-sol-high@codex/home' });
    const row = await service.ingestUpdate('S1', {
      kind: 'usage',
      origin: 'prompt_response',
      model: 'gpt-6-sol',
      inputTokens: 1_000_000,
      outputTokens: 10,
    } as never);
    expect(row).toBeUndefined();
    expect((await service.totals()).turns).toBe(0);
  });
});

describe('UsageService, the ACP usage_update (a cumulative cost)', () => {
  const cumulative = (amount: number) =>
    ({ kind: 'usage', costUsd: amount }) as Parameters<UsageService['ingestUpdate']>[1];

  it('turns the growth of the cumulative cost into one turn each, and ignores an unchanged one', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    await service.ingestUpdate('S1', {
      kind: 'usage',
      model: 'claude-opus-5-5',
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: 0.1,
    } as never);
    expect(await service.ingestUpdate('S1', cumulative(0.1))).toBeUndefined();
    const second = await service.ingestUpdate('S1', cumulative(0.35));
    expect(second).toMatchObject({
      costKind: 'real',
      costSource: 'client',
      model: 'claude-opus-5-5',
    });
    expect(second?.costUsd).toBeCloseTo(0.25, 9);
    const totals = await service.totals({ sessionId: 'S1' });
    expect(totals.turns).toBe(2);
    expect(totals.realUsd).toBeCloseTo(0.35, 9);
  });

  it('pricing_table has nothing to price in a report with no tokens', async () => {
    const { service, store } = setup({ costSource: 'pricing_table' });
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    expect(await service.ingestUpdate('S1', cumulative(1))).toBeUndefined();
    expect((await service.totals()).turns).toBe(0);
  });

  it('writes nothing for context counters alone, a bad count or a bad cost', async () => {
    const { service, store, warnings } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    expect(await service.ingestUpdate('S1', { kind: 'usage' } as never)).toBeUndefined();
    expect(
      await service.ingestNotification(signal('S1', 'claude-opus-5-5', -1, 10)),
    ).toBeUndefined();
    expect(
      await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1.5, 10)),
    ).toBeUndefined();
    expect(
      await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1, 10, -3)),
    ).toBeUndefined();
    expect(await service.ingestNotification({ nope: true })).toBeUndefined();
    expect(
      await service.ingestSignal('S1', { kind: 'window', window: '5h', usedPercent: 50 }),
    ).toBeUndefined();
    expect((await service.totals()).turns).toBe(0);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});

describe('UsageService, provider_billing', () => {
  it('is accepted, has no adapter and works as client_then_pricing, saying so once', async () => {
    const { service, store, warnings } = setup({ costSource: 'provider_billing' });
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    const first = await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200, 0.5));
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    expect(first).toMatchObject({ costUsd: 0.5, costSource: 'client' });
    expect(warnings.filter((w) => w.message.includes('provider_billing'))).toHaveLength(1);
  });
});

describe('UsageService, the session it comes from', () => {
  it('falls back to the sessions row of the store, with the Executor <model>@<profile>', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    await store.sessions.open({
      id: 'S9',
      client: 'claude-code',
      profile: 'api',
      clientSessionId: 'client-9',
    });
    // The client names its own session id: the service finds the row by it.
    const row = await service.ingestNotification(signal('client-9', 'claude-opus-5-5', 1000, 200));
    expect(row).toMatchObject({
      profileId: API,
      executorId: 'claude-opus-5-5@claude-code/api',
      costKind: 'real',
    });
  });

  it('remembers the model of the session for a report that does not name it', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 10, 10));
    const row = await service.ingestUpdate('S1', {
      kind: 'usage',
      inputTokens: 1000,
      outputTokens: 200,
    } as never);
    expect(row?.model).toBe('claude-opus-5-5');
    service.unbindSession('S1');
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    const again = await service.ingestUpdate('S1', {
      kind: 'usage',
      inputTokens: 1,
      outputTokens: 1,
    } as never);
    expect(again?.model).toBe(UNKNOWN_MODEL);
    expect(again?.costUsd).toBeNull();
  });

  it('writes nothing for a session with no profile', async () => {
    const { service, warnings } = setup();
    expect(
      await service.ingestNotification(signal('nobody', 'claude-opus-5-5', 10, 10)),
    ).toBeUndefined();
    expect(warnings.some((w) => w.message.includes('no profile'))).toBe(true);
  });

  it('writes the turns of a burst in the order they came', async () => {
    const { service, store } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    for (let n = 1; n <= 5; n += 1) {
      void service.ingestNotification(signal('S1', 'claude-opus-5-5', n * 100, 10));
    }
    await service.flush();
    const rows = await store.usage.list({ sessionId: 'S1' });
    expect(rows.map((r) => r.inputTokens)).toEqual([100, 200, 300, 400, 500]);
  });
});

describe('UsageService, the same sum by every cut', () => {
  it('gives the same real spend by session, play, Executor, profile and period', async () => {
    const { service, store, clock } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API), playId: 'play-1' });
    service.bindSession('S2', { profile: API, executorId: opus(API), playId: 'play-2' });
    service.bindSession('S3', {
      profile: API,
      executorId: 'claude-sonnet-medium@claude-code/api',
      playId: 'play-1',
    });
    service.bindSession('S4', { profile: WORK, executorId: opus(WORK), playId: 'play-1' });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    await clock.advance(DAY);
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 3000, 700, 0.07));
    await service.ingestNotification(signal('S2', 'claude-opus-5-5', 12345, 678));
    await clock.advance(DAY);
    await service.ingestNotification(signal('S3', 'claude-sonnet-5-5', 2000, 500));
    await service.ingestNotification(signal('S3', 'claude-sonnet-5-5', 4321, 123));
    await service.ingestNotification(signal('S4', 'claude-opus-5-5', 999, 99));
    await service.ingestNotification(signal('S1', 'unpriced-model', 5, 5));

    const whole = await service.totals();
    expect(whole.turns).toBe(7);
    expect(whole.unknownCostTurns).toBe(1);
    for (const by of ['session', 'play', 'profile', 'executor'] as const) {
      const groups = await service.breakdown(by);
      const sum = groups.reduce((acc, g) => acc + g.totals.realUsd, 0);
      const equivalent = groups.reduce((acc, g) => acc + g.totals.apiEquivalentUsd, 0);
      expect(sum).toBeCloseTo(whole.realUsd, 9);
      expect(equivalent).toBeCloseTo(whole.apiEquivalentUsd, 9);
      expect(groups.reduce((acc, g) => acc + g.totals.turns, 0)).toBe(whole.turns);
      expect(groups.reduce((acc, g) => acc + g.totals.unknownCostTurns, 0)).toBe(1);
    }
    // The cut by period: three days, each its own filter, add up to the whole.
    const days = [
      await service.totals({ until: T0 + DAY - 1 }),
      await service.totals({ since: T0 + DAY, until: T0 + 2 * DAY - 1 }),
      await service.totals({ since: T0 + 2 * DAY }),
    ];
    expect(days.reduce((acc, d) => acc + d.realUsd, 0)).toBeCloseTo(whole.realUsd, 9);
    expect(days.map((d) => d.turns)).toEqual([1, 2, 4]);
    // One play and one profile, by every other cut, agree with the cut itself.
    const play1 = await service.totals({ playId: 'play-1' });
    const byExecutor = await service.breakdown('executor', { playId: 'play-1' });
    expect(byExecutor.reduce((acc, g) => acc + g.totals.realUsd, 0)).toBeCloseTo(play1.realUsd, 9);
    const byKey = new Map((await service.breakdown('play')).map((g) => [g.key, g.totals]));
    expect(byKey.get('play-1')?.realUsd).toBeCloseTo(play1.realUsd, 9);
    expect(byKey.get('play-2')?.turns).toBe(1);
  });
});

describe('UsageService, the display of a subscription (usage.subscription_display)', () => {
  async function work(over: Partial<UsageSettings>) {
    const ctx = setup(over);
    await openProfiles(ctx.store);
    ctx.service.bindSession('S2', { profile: WORK, executorId: opus(WORK) });
    await ctx.service.ingestNotification(signal('S2', 'claude-opus-5-5', 1_000_000, 0));
    await ctx.clock.advance(DAY);
    await ctx.service.ingestNotification(signal('S2', 'claude-opus-5-5', 3_000_000, 0));
    return ctx;
  }

  it('quota_and_equivalent shows the equivalent of the period, with the unknown turns counted', async () => {
    const { service } = await work({ subscriptionDisplay: 'quota_and_equivalent' });
    const view = await service.subscriptionView(WORK, { since: T0 + DAY });
    expect(view).toMatchObject({
      profileId: WORK,
      display: 'quota_and_equivalent',
      prorated: null,
      unknownCostTurns: 0,
    });
    expect(view.apiEquivalentUsd).toBeCloseTo(12, 9);
  });

  it('quota shows no money at all', async () => {
    const { service } = await work({ subscriptionDisplay: 'quota' });
    expect(await service.subscriptionView(WORK)).toMatchObject({
      display: 'quota',
      apiEquivalentUsd: null,
      prorated: null,
    });
  });

  it('prorated shares the monthly price by the use of the period in the month', async () => {
    const { service } = await work({
      subscriptionDisplay: 'prorated',
      monthlyPriceUsd: new Map([[WORK, 200]]),
    });
    const view = await service.subscriptionView(WORK, { since: T0 + DAY });
    // The second day is 12 of the 16 US$ of the month: 3/4 of the plan.
    expect(view.prorated?.monthlyPriceUsd).toBe(200);
    expect(view.prorated?.periodUsd).toBeCloseTo(150, 9);
    const whole = await service.subscriptionView(WORK);
    expect(whole.prorated?.periodUsd).toBeCloseTo(200, 9);
  });

  it('prorated without a price for the profile falls back to the equivalent alone', async () => {
    const { service } = await work({ subscriptionDisplay: 'prorated' });
    const view = await service.subscriptionView(WORK);
    expect(view.prorated).toBeNull();
    expect(view.apiEquivalentUsd).toBeCloseTo(16, 9);
  });
});

describe('UsageService, what it also tells as events (P24, N146)', () => {
  it('usage.notice bad_token_count: a report with a count that is not a whole number', async () => {
    const { service, store, situations } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1.5, 10));
    expect(situations.of('usage.notice')).toEqual([
      { kind: 'bad_token_count', sessionId: 'S1', profile: null },
    ]);
  });

  it('usage.notice bad_cost: a report with a negative cost', async () => {
    const { service, store, situations } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1, 10, -3));
    expect(situations.of('usage.notice')).toEqual([
      { kind: 'bad_cost', sessionId: 'S1', profile: null },
    ]);
  });

  it('usage.notice no_profile: usage of a session that has no profile', async () => {
    const { service, situations } = setup();
    await service.ingestNotification(signal('nobody', 'claude-opus-5-5', 10, 10));
    expect(situations.of('usage.notice')).toEqual([
      { kind: 'no_profile', sessionId: 'nobody', profile: null },
    ]);
  });

  it('usage.notice provider_billing_unavailable: once, like the log', async () => {
    const { service, store, situations } = setup({ costSource: 'provider_billing' });
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200, 0.5));
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    expect(situations.of('usage.notice')).toEqual([
      { kind: 'provider_billing_unavailable', sessionId: null, profile: null },
    ]);
  });

  it('usage.notice unknown_profile_kind: a profile the store does not know', async () => {
    const { service, situations } = setup();
    service.bindSession('S1', { profile: 'claude-code/ghost', executorId: 'x@claude-code/ghost' });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    expect(situations.of('usage.notice')).toEqual([
      { kind: 'unknown_profile_kind', sessionId: null, profile: 'claude-code/ghost' },
    ]);
  });

  it('says nothing for a good report', async () => {
    const { service, store, situations } = setup();
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: opus(API) });
    await service.ingestNotification(signal('S1', 'claude-opus-5-5', 1000, 200));
    expect(situations.recorded).toEqual([]);
  });
});

describe('UsageService, the table of the config', () => {
  it('prices a model the table that ships does not know, and marks the version +config', async () => {
    const pricing = mergePricing(builtInPricing(), {
      'my-model': { inputPerMtok: 1, outputPerMtok: 2 },
    });
    const { service, store } = setup({ pricing });
    await openProfiles(store);
    service.bindSession('S1', { profile: API, executorId: 'my-model@claude-code/api' });
    const row = await service.ingestNotification(signal('S1', 'my-model', 1_000_000, 1_000_000));
    expect(row?.costUsd).toBeCloseTo(3, 9);
    expect(row?.pricingVersion).toBe(`${builtInPricing().version}+config`);
  });
});
