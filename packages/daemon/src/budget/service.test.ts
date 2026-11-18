// SPDX-License-Identifier: MPL-2.0
import { builtInPricing, type EventEnvelope } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { BudgetWarningPayload, InterruptionCause } from '@otheater/protocol';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import {
  decideInterruption,
  type InterruptionFacts,
  type InterruptionRules,
} from '../execution/interruption-policy.js';
import { createSilentLogger, type Logger } from '../logger.js';
import { QuotaService } from '../quota/service.js';
import { RecordingSituations } from '../test-helpers.js';
import {
  WakeupManager,
  wakeupSettingsOf,
  type RestoreHookKind,
  type RestoredProfile,
} from '../quota/wakeups.js';
import { UsageService } from '../usage/service.js';
import {
  BudgetService,
  whenExhaustedOf,
  type BudgetAsker,
  type BudgetExceeded,
  type BudgetQuestion,
} from './service.js';
import { budgetSettingsOf } from './settings.js';

/**
 * Acceptance of P11 (architecture 5.6, "Teto de gasto em API"), with the real `QuotaService`,
 * `UsageService`, `BudgetService` and `WakeupManager` over the in-memory store and a fake clock.
 * The consumption is what the fake agent's `usage` signals become (the same call as
 * `usage/fake-agent-signals.test.ts`; the real process is in `fake-agent.test.ts`).
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-11-18 09:00 in São Paulo (UTC-3, no daylight saving). */
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
/** Midnight of the 19th in São Paulo. */
const DAY_END = Date.UTC(2026, 10, 19, 3);
/** Day 1 of December in São Paulo. */
const MONTH_END = Date.UTC(2026, 11, 1, 3);

const API = 'claude-code/api';
const API2 = 'claude-code/api2';
const WORK = 'claude-code/work';
const opus = (profile: string): string => `claude-opus-high@${profile}`;
const sonnet = (profile: string): string => `claude-sonnet-medium@${profile}`;

// ---- config text ----

interface Limits {
  daily?: number;
  monthly?: number;
  warnAt?: number[];
}
interface ProfileSpec extends Limits {
  onExceeded?: string;
  inFlight?: string;
}
interface Spec {
  profiles?: Record<string, ProfileSpec>;
  executors?: Record<string, Limits>;
  budget?: Record<string, string>;
}

function yamlOf(spec: Spec): string {
  const lines: string[] = [];
  const budget = (l: ProfileSpec, pad: string): string[] => {
    const out = [`${pad}budget:`];
    if (l.daily !== undefined) out.push(`${pad}  daily_usd: ${String(l.daily)}`);
    if (l.monthly !== undefined) out.push(`${pad}  monthly_usd: ${String(l.monthly)}`);
    if (l.warnAt !== undefined) out.push(`${pad}  warn_at: [${l.warnAt.join(', ')}]`);
    if (l.onExceeded !== undefined) out.push(`${pad}  on_exceeded: ${l.onExceeded}`);
    if (l.inFlight !== undefined) out.push(`${pad}  in_flight: ${l.inFlight}`);
    return out;
  };
  if (spec.profiles !== undefined) {
    lines.push('profiles:');
    for (const [id, p] of Object.entries(spec.profiles))
      lines.push(`  ${id}:`, ...budget(p, '    '));
  }
  if (spec.executors !== undefined) {
    lines.push('executors:');
    for (const [id, l] of Object.entries(spec.executors)) {
      const [head = '', target = ''] = id.split('@');
      const [client, profile] = target.split('/');
      const cut = head.lastIndexOf('-');
      lines.push(
        `  "${id}":`,
        `    client: ${String(client)}`,
        `    profile: ${String(profile)}`,
        `    model: ${head.slice(0, cut)}`,
        `    effort: ${head.slice(cut + 1)}`,
        ...budget(l, '    '),
      );
    }
  }
  if (spec.budget !== undefined && Object.keys(spec.budget).length > 0) {
    lines.push('budget:');
    for (const [key, value] of Object.entries(spec.budget)) lines.push(`  ${key}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---- harness ----

type Hooks = Record<RestoreHookKind, RestoredProfile[]>;

interface Harness {
  readonly clock: FakeClock;
  readonly store: InMemoryStore;
  readonly quota: QuotaService;
  readonly usage: UsageService;
  readonly budget: BudgetService;
  readonly manager: WakeupManager;
  readonly hooks: Hooks;
  readonly exceeded: BudgetExceeded[];
  readonly warnings: BudgetWarningPayload[];
  stop(): Promise<void>;
}

const running: Harness[] = [];

afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});

/** Lets the work that is already queued (reads, pushes, the loops) run to its next wait. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settle(h: Pick<Harness, 'manager' | 'budget'>): Promise<void> {
  await flush();
  await h.budget.flush();
  await h.manager.idle();
  await flush();
}

class World {
  readonly clock = new FakeClock(T0);
  readonly store = new InMemoryStore({ clock: this.clock });
  readonly situations = new RecordingSituations();
  #profiles = false;

  /** One life of the daemon, over the store the earlier lives left. */
  async boot(config: Spec | string, asker?: BudgetAsker, logger?: Logger): Promise<Harness> {
    const { clock, store } = this;
    if (!this.#profiles) {
      this.#profiles = true;
      for (const [name, kind] of [
        ['api', 'api'],
        ['api2', 'api'],
        ['work', 'token_plan'],
      ] as const) {
        await store.profiles.create({
          client: 'claude-code',
          name,
          kind,
          provider: 'anthropic',
          dir: `/p/${name}`,
        });
      }
    }
    const log = logger ?? createSilentLogger();
    const text = typeof config === 'string' ? config : yamlOf(config);
    const quota = new QuotaService({
      store,
      clock,
      settings: { nearLimitAt: 0.8, staleAfterMs: 10 * MIN, delivery: 'poll', pollEveryMs: HOUR },
      logger: log,
    });
    const usage = new UsageService({
      store,
      clock,
      settings: {
        subscriptionDisplay: 'quota_and_equivalent',
        costSource: 'client_then_pricing',
        monthlyPriceUsd: new Map(),
        pricing: builtInPricing(),
      },
      logger: log,
    });
    const budget = new BudgetService({
      store,
      clock,
      settings: budgetSettingsOf(parseConfig(text)),
      logger: log,
      quota,
      usage,
      asker,
      situations: this.situations,
    });
    const manager = new WakeupManager({
      store,
      clock,
      quota,
      settings: wakeupSettingsOf({ quota: { recheck_every: null } } as never),
      logger: log,
      probes: () => undefined,
    });
    const hooks: Hooks = { awaiting_resume: [], queued_demands: [], scheduled_tasks: [] };
    for (const kind of Object.keys(hooks) as RestoreHookKind[]) {
      manager.setHook(kind, (restored) => {
        hooks[kind].push(restored);
      });
    }
    const exceeded: BudgetExceeded[] = [];
    const warnings: BudgetWarningPayload[] = [];
    budget.onExceeded((event) => exceeded.push(event));
    budget.onWarning((warning) => warnings.push(warning));
    await quota.start();
    await budget.start();
    await manager.start();
    let stopped = false;
    const harness: Harness = {
      clock,
      store,
      quota,
      usage,
      budget,
      manager,
      hooks,
      exceeded,
      warnings,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await budget.stop();
        await manager.stop();
        await quota.stop();
      },
    };
    running.push(harness);
    await settle(harness);
    return harness;
  }
}

/** One turn of an Executor, as the fake agent's `usage` signal reports it. */
async function spend(
  h: Harness,
  executorId: string,
  usd: number | undefined,
  model = 'claude-opus-5-5',
): Promise<void> {
  const profile = executorId.slice(executorId.indexOf('@') + 1);
  const sessionId = `S-${executorId}`;
  h.usage.bindSession(sessionId, { profile, executorId });
  await h.usage.ingestNotification({
    sessionId,
    signal: {
      kind: 'usage',
      model,
      inputTokens: 10,
      outputTokens: 10,
      ...(usd === undefined ? {} : { costUsd: usd }),
    },
  });
  await settle(h);
}

async function eventsOf(store: InMemoryStore, type: string): Promise<EventEnvelope[]> {
  return (await store.events.readFrom(0, 5000)).filter((e) => e.type === type);
}

/** The first candidate the quota does not hold back: what `exhausted(budget)` buys the selection. */
async function firstUsable(h: Harness, candidates: readonly string[]): Promise<string | undefined> {
  for (const profile of candidates) {
    if ((await h.quota.statusOf(profile)).state !== 'exhausted') return profile;
  }
  return undefined;
}

/**
 * The selection of a role, as far as the cap is concerned (the pool of P15 is who will do it): a
 * profile whose cap is spent is skipped, or waited for, as `on_exceeded` says.
 */
async function select(
  h: Harness,
  candidates: readonly string[],
): Promise<{ profile: string; waiting: boolean } | undefined> {
  for (const profile of candidates) {
    if (h.budget.exceededOf(profile) !== undefined) {
      const answer = await h.budget.resolveExceeded(profile);
      if (answer?.choice === 'wait') return { profile, waiting: true };
      continue;
    }
    if ((await h.quota.statusOf(profile)).state === 'exhausted') continue;
    return { profile, waiting: false };
  }
  return undefined;
}

const RULES: InterruptionRules = {
  maxResumes: 5,
  quotaWaitMaxMs: 30 * MIN,
  transientBackoffMs: [30_000, 120_000, 600_000],
  transientExhausted: 'last',
  clientCrashCounts: 'repeat',
  stuckSameErrorTimes: 3,
};

function factsOf(cause: InterruptionCause, extra: Partial<InterruptionFacts>): InterruptionFacts {
  return {
    cause,
    now: T0,
    resetsAt: DAY_END,
    whenExhausted: 'next',
    inFlight: 'handoff',
    reloadable: true,
    free: false,
    resumes: 0,
    repeated: 1,
    priorCrashes: 0,
    ...extra,
  };
}

// ---- tests ----

describe('BudgetService, the warning (architecture 5.6, warn_at)', () => {
  it('warns once at 80% of the day, with the event and the system message, and not again', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    await spend(h, opus(API), 7);
    expect(h.warnings).toEqual([]);
    await spend(h, opus(API), 1.5);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatchObject({
      profile: API,
      executor: null,
      period: 'day',
      thresholdFraction: 0.8,
      limitUsd: 10,
      periodEndsAt: DAY_END,
    });
    expect(h.warnings[0]?.spentUsd).toBeCloseTo(8.5, 9);
    await spend(h, opus(API), 0.5);
    expect(h.warnings).toHaveLength(1);
    const written = await eventsOf(world.store, 'budget.warning');
    expect(written).toHaveLength(1);
    expect(written[0]?.payload).toMatchObject({
      profile: API,
      period: 'day',
      thresholdFraction: 0.8,
    });
    // The warning is not the limit: the profile still takes work.
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    expect(h.exceeded).toEqual([]);
  });

  it('does not repeat the warning after a restart of the daemon', async () => {
    const world = new World();
    const spec = { profiles: { [API]: { daily: 10 } } };
    const first = await world.boot(spec);
    await spend(first, opus(API), 8.5);
    await first.stop();
    const second = await world.boot(spec);
    await spend(second, opus(API), 0.1);
    expect(second.warnings).toEqual([]);
    expect(await eventsOf(world.store, 'budget.warning')).toHaveLength(1);
  });

  it('warns at every warn_at fraction, each once', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10, warnAt: [0.5, 0.9] } } });
    await spend(h, opus(API), 5);
    await spend(h, opus(API), 1);
    await spend(h, opus(API), 4);
    expect(h.warnings.map((w) => w.thresholdFraction)).toEqual([0.5, 0.9]);
  });

  it('warns again in the next day, and the warning of the month is apart from the day', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10, monthly: 100 } } });
    await spend(h, opus(API), 8);
    await h.clock.advance(DAY_END - T0 + 2000);
    await settle(h);
    await spend(h, opus(API), 8);
    expect(h.warnings.map((w) => [w.period, w.periodEndsAt])).toEqual([
      ['day', DAY_END],
      ['day', DAY_END + 24 * HOUR],
    ]);
  });

  it('lets warn_at be empty: no warning, the cap still holds', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10, warnAt: [] } } });
    await spend(h, opus(API), 9.5);
    expect(h.warnings).toEqual([]);
    await spend(h, opus(API), 1);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
  });

  it('warns for an Executor with its own warn_at, and says which Executor it is', async () => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 10 } },
      executors: { [opus(API)]: { daily: 2, warnAt: [0.5] } },
    });
    await spend(h, opus(API), 1.2);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatchObject({
      profile: API,
      executor: opus(API),
      period: 'day',
      thresholdFraction: 0.5,
      limitUsd: 2,
    });
    expect((await eventsOf(world.store, 'budget.warning'))[0]?.payload).toMatchObject({
      executor: opus(API),
    });
  });
});

describe('BudgetService, the overrun (exhausted(budget))', () => {
  it('puts the profile in exhausted(budget) until midnight, and the selection moves to the next', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    expect(await firstUsable(h, [API, API2])).toBe(API);
    await spend(h, opus(API), 10.5);
    const status = await h.quota.statusOf(API);
    expect(status).toMatchObject({ state: 'exhausted', cause: 'budget', untilReset: DAY_END });
    expect(await firstUsable(h, [API, API2])).toBe(API2);
    const exhausted = await eventsOf(world.store, 'quota.exhausted');
    expect(exhausted.map((e) => (e.payload as { profile: string }).profile)).toEqual([API]);
    expect(h.exceeded).toHaveLength(1);
    expect(h.exceeded[0]).toMatchObject({
      profile: API,
      resetsAt: DAY_END,
      onExceeded: 'skip',
      inFlight: 'handoff',
    });
    expect(h.exceeded[0]?.caps.map((c) => c.period)).toEqual(['day']);
    // Another turn while it is spent changes nothing and is not announced again.
    await spend(h, opus(API), 1);
    expect(h.exceeded).toHaveLength(1);
    // The other profile has no cap and is not touched.
    expect((await h.quota.statusOf(API2)).state).not.toBe('exhausted');
  });

  it('sets the wakeup of P9 to the end of the day, with cause budget', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    await spend(h, opus(API), 10);
    const rows = await world.store.wakeups.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profileId: API,
      cause: 'budget',
      at: DAY_END,
      state: 'scheduled',
    });
  });

  it('counts exactly the cap: below it the profile is usable, at it the profile is spent', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    await spend(h, opus(API), 9.99);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    await spend(h, opus(API), 0.01);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
  });

  it('holds until the month when the monthly cap is the one spent', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 50, monthly: 20 } } });
    await spend(h, opus(API), 20);
    expect(await h.quota.statusOf(API)).toMatchObject({
      state: 'exhausted',
      cause: 'budget',
      untilReset: MONTH_END,
    });
    expect(h.exceeded[0]?.caps.map((c) => c.period)).toEqual(['month']);
  });

  it('holds until the later end when the day and the month are both spent', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 5, monthly: 5 } } });
    await spend(h, opus(API), 6);
    expect((await h.quota.statusOf(API)).untilReset).toBe(MONTH_END);
    expect(h.exceeded[0]?.caps.map((c) => c.period)).toEqual(['day', 'month']);
    // The day turns and the month has not: still spent.
    await h.clock.advance(DAY_END - T0 + 2000);
    await settle(h);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toEqual([]);
  });

  it('never reaches a subscription profile: its cost is an equivalent, not spending', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [WORK]: { daily: 1 } } });
    await spend(h, opus(WORK), 5);
    expect(h.warnings).toEqual([]);
    expect(h.exceeded).toEqual([]);
    expect((await h.quota.statusOf(WORK)).state).not.toBe('exhausted');
    const headroom = await h.budget.headroom(opus(WORK));
    expect(headroom.binding?.spentUsd).toBe(0);
    expect(headroom.allowed).toBe(true);
  });

  it('catches the spending that was there when the daemon started, and a cap that was lowered', async () => {
    const world = new World();
    const before = await world.boot('');
    await spend(before, opus(API), 12);
    expect((await before.quota.statusOf(API)).state).not.toBe('exhausted');
    await before.stop();
    const after = await world.boot({ profiles: { [API]: { daily: 10 } } });
    expect(await after.quota.statusOf(API)).toMatchObject({ state: 'exhausted', cause: 'budget' });
    expect(after.exceeded).toHaveLength(1);
    expect(after.warnings).toHaveLength(1);
  });

  it('does not count unknown cost against the cap by default, and counts it when unknown_cost is block', async () => {
    const lenient = new World();
    const a = await lenient.boot({ profiles: { [API]: { daily: 10 } } });
    await spend(a, opus(API), undefined, 'no-such-model');
    expect((await a.quota.statusOf(API)).state).not.toBe('exhausted');
    const reading = await a.budget.headroom(opus(API));
    expect(reading.caps[0]).toMatchObject({
      unknownCostTurns: 1,
      spentUsd: 0,
      blockedByUnknownCost: false,
    });

    const strict = new World();
    const b = await strict.boot({
      profiles: { [API]: { daily: 10 } },
      budget: { unknown_cost: 'block' },
    });
    await spend(b, opus(API), undefined, 'no-such-model');
    expect((await b.quota.statusOf(API)).state).toBe('exhausted');
    expect(b.exceeded[0]?.caps[0]).toMatchObject({ blockedByUnknownCost: true });
  });
});

describe('BudgetService, on_exceeded', () => {
  const over = async (
    onExceeded: string,
    asker?: BudgetAsker,
    extra: Record<string, string> = {},
  ): Promise<{ world: World; h: Harness }> => {
    const world = new World();
    const h = await world.boot(
      { profiles: { [API]: { daily: 10, onExceeded } }, budget: extra },
      asker,
    );
    await spend(h, opus(API), 11);
    return { world, h };
  };

  it('is false while the cap is not spent: nothing to resolve', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10, onExceeded: 'wait' } } });
    expect(h.budget.resolveExceeded(API)).toBeUndefined();
    expect(h.budget.settingsOf(API)).toEqual({ onExceeded: 'wait', inFlight: 'handoff' });
    expect(h.budget.settingsOf(API2)).toEqual({ onExceeded: 'skip', inFlight: 'handoff' });
  });

  it('skip: the role takes the next Executor', async () => {
    const { h } = await over('skip');
    const answer = await h.budget.resolveExceeded(API);
    expect(answer).toEqual({ choice: 'skip', via: 'config' });
    expect(whenExhaustedOf(answer?.choice ?? 'wait')).toBe('next');
    expect(await select(h, [API, API2])).toEqual({ profile: API2, waiting: false });
  });

  it('wait: the role waits for the reset and does not move to the next', async () => {
    const { h } = await over('wait');
    const answer = await h.budget.resolveExceeded(API);
    expect(answer).toEqual({ choice: 'wait', via: 'config' });
    expect(whenExhaustedOf(answer?.choice ?? 'skip')).toBe('wait');
    expect(await select(h, [API, API2])).toEqual({ profile: API, waiting: true });
  });

  it('ask: asks the Producer, who answers wait, and the answer holds until the reset', async () => {
    const questions: BudgetQuestion[] = [];
    const asker: BudgetAsker = {
      ask: (question) => {
        questions.push(question);
        return Promise.resolve('wait');
      },
    };
    const { h } = await over('ask', asker);
    expect(await h.budget.resolveExceeded(API)).toEqual({ choice: 'wait', via: 'asked' });
    expect(await h.budget.resolveExceeded(API)).toEqual({ choice: 'wait', via: 'asked' });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ profile: API, resetsAt: DAY_END });
    expect(questions[0]?.caps[0]?.period).toBe('day');
  });

  it('ask: the Producer answers skip', async () => {
    const { h } = await over('ask', { ask: () => Promise.resolve('skip') });
    expect(await h.budget.resolveExceeded(API)).toEqual({ choice: 'skip', via: 'asked' });
    expect(await select(h, [API, API2])).toEqual({ profile: API2, waiting: false });
  });

  it('ask with nobody watching (no asker) becomes skip', async () => {
    const { h } = await over('ask');
    expect(await h.budget.resolveExceeded(API)).toEqual({ choice: 'skip', via: 'unattended' });
    expect(await select(h, [API, API2])).toEqual({ profile: API2, waiting: false });
  });

  it('ask with an asker that has nobody to ask (no answer) becomes skip', async () => {
    const { h } = await over('ask', { ask: () => Promise.resolve(undefined) });
    expect(await h.budget.resolveExceeded(API)).toEqual({ choice: 'skip', via: 'unattended' });
  });

  it('ask with an asker that fails becomes skip', async () => {
    const { h } = await over('ask', { ask: () => Promise.reject(new Error('the chat is gone')) });
    expect(await h.budget.resolveExceeded(API)).toEqual({ choice: 'skip', via: 'unattended' });
  });

  it('usage.notice cap_question_failed: an asker that fails is also an event (P24, N146)', async () => {
    const { world, h } = await over('ask', {
      ask: () => Promise.reject(new Error('the chat is gone')),
    });
    await h.budget.resolveExceeded(API);
    expect(world.situations.of('usage.notice')).toEqual([
      { kind: 'cap_question_failed', sessionId: null, profile: API, detail: 'the chat is gone' },
    ]);
  });

  it('ask that is answered does not write a usage.notice (P24, N146)', async () => {
    const { world, h } = await over('ask', { ask: () => Promise.resolve('skip') });
    await h.budget.resolveExceeded(API);
    expect(world.situations.recorded).toEqual([]);
  });

  it('ask that is not answered within budget.ask_timeout becomes skip', async () => {
    const asker: BudgetAsker = { ask: () => new Promise(() => undefined) };
    const { h } = await over('ask', asker, { ask_timeout: '5m' });
    const pending = h.budget.resolveExceeded(API);
    let settled = false;
    void pending?.then(() => {
      settled = true;
    });
    await h.clock.advance(4 * MIN);
    await flush();
    expect(settled).toBe(false);
    await h.clock.advance(MIN + 1);
    expect(await pending).toEqual({ choice: 'skip', via: 'timeout' });
  });

  it('forgets the answer at the reset: the next breach is asked again', async () => {
    let calls = 0;
    const world = new World();
    const h = await world.boot(
      { profiles: { [API]: { daily: 10, onExceeded: 'ask' } } },
      {
        ask: () => {
          calls += 1;
          return Promise.resolve('wait');
        },
      },
    );
    await spend(h, opus(API), 11);
    await h.budget.resolveExceeded(API);
    await h.clock.advance(DAY_END - T0 + 2000);
    await settle(h);
    expect(h.budget.resolveExceeded(API)).toBeUndefined();
    await spend(h, opus(API), 11);
    await h.budget.resolveExceeded(API);
    expect(calls).toBe(2);
  });
});

describe('BudgetService, in_flight (the policy of 5.16 for the cause spend_cap)', () => {
  it.each([
    ['handoff', 'handoff'],
    ['finish', 'finish_session'],
    ['stop', 'ask_producer'],
  ] as const)(
    'in_flight %s: the session that meets the cap takes the action %s',
    async (inFlight, action) => {
      const world = new World();
      const h = await world.boot({ profiles: { [API]: { daily: 10, inFlight } } });
      await spend(h, opus(API), 11);
      // What the pool is told, and what the attempt runner reads for the profile.
      expect(h.exceeded[0]?.inFlight).toBe(inFlight);
      const settings = h.budget.settingsOf(API);
      expect(settings.inFlight).toBe(inFlight);
      const decision = decideInterruption(
        factsOf('spend_cap', { inFlight: settings.inFlight, whenExhausted: 'next' }),
        RULES,
      );
      expect(decision.action).toBe(action);
      expect(decision.countsAsAttempt).toBe(false);
    },
  );

  it('defaults to handoff', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    expect(h.budget.settingsOf(API).inFlight).toBe('handoff');
  });
});

describe('BudgetService, the turn of the day and of the month', () => {
  it('returns the profile to usable at midnight, with budget.restored and the hooks of P9', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    await spend(h, opus(API), 11);
    expect(await firstUsable(h, [API, API2])).toBe(API2);
    await h.clock.advance(DAY_END - T0 - MIN);
    await settle(h);
    // One minute before midnight it is still spent.
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toEqual([]);

    await h.clock.advance(MIN + 2000);
    await settle(h);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    const restored = await eventsOf(world.store, 'budget.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ profile: API, reason: 'reset' });
    expect(await eventsOf(world.store, 'quota.restored')).toEqual([]);
    expect(h.hooks.queued_demands).toHaveLength(1);
    expect(h.hooks.queued_demands[0]).toMatchObject({ profile: API, causes: ['budget'] });
    expect(h.hooks.awaiting_resume).toHaveLength(1);
    expect((await world.store.wakeups.list({}))[0]?.state).toBe('fired');
    expect(h.budget.exceededOf(API)).toBeUndefined();
    expect(await firstUsable(h, [API, API2])).toBe(API);

    // The count starts over: yesterday's spending is not today's.
    await spend(h, opus(API), 1);
    const headroom = await h.budget.headroom(opus(API));
    expect(headroom.binding).toMatchObject({ spentUsd: 1, remainingUsd: 9 });
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
  });

  it('returns the profile to usable on day 1, with budget.restored, after a monthly cap', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 50, monthly: 20 } } });
    await spend(h, opus(API), 20);
    // The day turns, and the monthly cap holds.
    await h.clock.advance(DAY_END - T0 + 2000);
    await settle(h);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    await h.clock.advance(MONTH_END - h.clock.now() - MIN);
    await settle(h);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toEqual([]);
    await h.clock.advance(MIN + 2000);
    await settle(h);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    const restored = await eventsOf(world.store, 'budget.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ profile: API, reason: 'reset' });
    expect(h.hooks.queued_demands[0]?.causes).toEqual(['budget']);
    const headroom = await h.budget.headroom(opus(API));
    expect(headroom.caps.map((c) => [c.period, c.spentUsd])).toEqual([
      ['day', 0],
      ['month', 0],
    ]);
  });

  it('says budget.restored once when the day turned while the daemon was stopped', async () => {
    const world = new World();
    const spec = { profiles: { [API]: { daily: 10 } } };
    const first = await world.boot(spec);
    await spend(first, opus(API), 11);
    await first.stop();
    await first.clock.advance(DAY_END - T0 + 3 * HOUR);
    const second = await world.boot(spec);
    await settle(second);
    expect((await second.quota.statusOf(API)).state).not.toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toHaveLength(1);
    await second.stop();
    const third = await world.boot(spec);
    await settle(third);
    expect(await eventsOf(world.store, 'budget.restored')).toHaveLength(1);
    expect((await third.quota.statusOf(API)).state).not.toBe('exhausted');
  });

  it('keeps the profile spent across a restart before the reset, without a second announcement', async () => {
    const world = new World();
    const spec = { profiles: { [API]: { daily: 10 } } };
    const first = await world.boot(spec);
    await spend(first, opus(API), 11);
    await first.stop();
    const second = await world.boot(spec);
    expect((await second.quota.statusOf(API)).state).toBe('exhausted');
    expect(await eventsOf(world.store, 'quota.exhausted')).toHaveLength(1);
    expect(await world.store.wakeups.list({})).toHaveLength(1);
  });
});

describe('BudgetService, the Executor cap inside the profile cap (headroom)', () => {
  it('the Executor cap smaller than the profile cap wins, and it skips only that Executor', async () => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 10 } },
      executors: { [opus(API)]: { daily: 2 } },
    });
    await spend(h, opus(API), 2.5);
    const headroom = await h.budget.headroom(opus(API));
    expect(headroom.caps.map((c) => [c.scope, c.period, c.limitUsd])).toEqual([
      ['profile', 'day', 10],
      ['executor', 'day', 2],
    ]);
    expect(headroom.binding).toMatchObject({ scope: 'executor', id: opus(API), remainingUsd: 0 });
    expect(headroom.allowed).toBe(false);
    expect(headroom.remainingUsd).toBe(0);
    // The profile has money: another Executor of it is allowed, with the profile's rest.
    const other = await h.budget.headroom(sonnet(API));
    expect(other.allowed).toBe(true);
    expect(other.binding).toMatchObject({ scope: 'profile' });
    expect(other.remainingUsd).toBeCloseTo(7.5, 9);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    expect(h.exceeded).toEqual([]);
  });

  it('the profile cap wins when the Executor cap is larger than it', async () => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 10 } },
      executors: { [opus(API)]: { daily: 50 } },
    });
    await spend(h, sonnet(API), 4);
    await spend(h, opus(API), 7);
    const headroom = await h.budget.headroom(opus(API));
    expect(headroom.binding).toMatchObject({ scope: 'profile', remainingUsd: 0 });
    expect(headroom.allowed).toBe(false);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
  });

  it('counts the spending of the Executor in the profile, and of the profile only in its own cap', async () => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 10 } },
      executors: { [opus(API)]: { daily: 6 } },
    });
    await spend(h, sonnet(API), 3);
    await spend(h, opus(API), 1);
    const headroom = await h.budget.headroom(opus(API));
    const spent = Object.fromEntries(headroom.caps.map((c) => [c.scope, c.spentUsd]));
    expect(spent.profile).toBeCloseTo(4, 9);
    expect(spent.executor).toBeCloseTo(1, 9);
    expect(headroom.binding).toMatchObject({ scope: 'executor' });
    expect(headroom.remainingUsd).toBeCloseTo(5, 9);
  });

  it('the per-run budget of 5.15 wins when it is the smallest, and loses when it is not', async () => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 10 } },
      executors: { [opus(API)]: { daily: 5 } },
    });
    await spend(h, opus(API), 1);
    const tight = await h.budget.headroom(opus(API), { limitUsd: 1, spentUsd: 0.25 });
    expect(tight.binding).toMatchObject({ scope: 'run', remainingUsd: 0.75 });
    expect(tight.allowed).toBe(true);
    const spentRun = await h.budget.headroom(opus(API), { limitUsd: 1, spentUsd: 1 });
    expect(spentRun.binding).toMatchObject({ scope: 'run', remainingUsd: 0 });
    expect(spentRun.allowed).toBe(false);
    const loose = await h.budget.headroom(opus(API), { limitUsd: 100, spentUsd: 0 });
    expect(loose.binding).toMatchObject({ scope: 'executor' });
    expect(loose.remainingUsd).toBeCloseTo(4, 9);
  });

  it('is allowed with no number when nothing is capped', async () => {
    const world = new World();
    const h = await world.boot('');
    const headroom = await h.budget.headroom(opus(API2));
    expect(headroom).toMatchObject({ allowed: true, binding: null, remainingUsd: null, caps: [] });
  });

  it('the Executor cap turns with the day: the Executor is back at midnight', async () => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 10 } },
      executors: { [opus(API)]: { daily: 2 } },
    });
    await spend(h, opus(API), 2);
    expect((await h.budget.headroom(opus(API))).allowed).toBe(false);
    await h.clock.advance(DAY_END - T0 + 1000);
    expect((await h.budget.headroom(opus(API))).allowed).toBe(true);
  });
});

// ---- P11b: the owner's answers of 2026-11-18 ----

const settingsOf = (spec: Spec | string) =>
  budgetSettingsOf(parseConfig(typeof spec === 'string' ? spec : yamlOf(spec)));

describe('BudgetService, budget.on_cap_change (a changed cap releases the exhaustion)', () => {
  const spentWorld = async (budget?: Record<string, string>) => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 10 } },
      ...(budget === undefined ? {} : { budget }),
    });
    await spend(h, opus(API), 11);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    return { world, h };
  };

  it('release (the default): a cap raised in the configuration brings the profile back at once, with reason config', async () => {
    const { world, h } = await spentWorld();
    await h.budget.applySettings(settingsOf({ profiles: { [API]: { daily: 20 } } }));
    await settle(h);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    expect(h.budget.exceededOf(API)).toBeUndefined();
    const restored = await eventsOf(world.store, 'budget.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ profile: API, reason: 'config' });
    expect(await eventsOf(world.store, 'quota.restored')).toEqual([]);
    // The hooks of P9 run as at the turn of the day: the demands that waited may go.
    expect(h.hooks.queued_demands).toHaveLength(1);
    expect(h.hooks.queued_demands[0]).toMatchObject({ profile: API, causes: ['budget'] });
    expect((await world.store.wakeups.list({}))[0]?.state).toBe('fired');
    expect(await firstUsable(h, [API, API2])).toBe(API);
    // The new cap holds: the spending is counted against 20 now.
    await spend(h, opus(API), 8);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    await spend(h, opus(API), 2);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
  });

  it('release: a cap that is raised but still at or below the spending does not release', async () => {
    const { world, h } = await spentWorld();
    await h.budget.applySettings(settingsOf({ profiles: { [API]: { daily: 11 } } }));
    await settle(h);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toEqual([]);
    await h.budget.applySettings(settingsOf({ profiles: { [API]: { daily: 11.5 } } }));
    await settle(h);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toHaveLength(1);
  });

  it('release: a cap that is removed brings the profile back', async () => {
    const { world, h } = await spentWorld();
    await h.budget.applySettings(settingsOf(''));
    await settle(h);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    expect((await eventsOf(world.store, 'budget.restored'))[0]?.payload).toMatchObject({
      reason: 'config',
    });
    expect((await h.budget.headroom(opus(API))).allowed).toBe(true);
  });

  it('release: the reading at start-up releases a cap raised or removed while the daemon was stopped', async () => {
    const raised = await spentWorld();
    await raised.h.stop();
    const second = await raised.world.boot({ profiles: { [API]: { daily: 20 } } });
    expect((await second.quota.statusOf(API)).state).not.toBe('exhausted');
    const restored = await eventsOf(raised.world.store, 'budget.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload).toMatchObject({ reason: 'config' });
    await second.stop();
    // Booting again says nothing more.
    const third = await raised.world.boot({ profiles: { [API]: { daily: 20 } } });
    expect(await eventsOf(raised.world.store, 'budget.restored')).toHaveLength(1);
    await third.stop();

    const removed = await spentWorld();
    await removed.h.stop();
    const after = await removed.world.boot('');
    expect((await after.quota.statusOf(API)).state).not.toBe('exhausted');
    expect((await eventsOf(removed.world.store, 'budget.restored'))[0]?.payload).toMatchObject({
      profile: API,
      reason: 'config',
    });
  });

  it('release: an exhaustion by the quota (not by the cap) is left alone', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    await h.quota.ingestLimitHit(API, { source: 'test', resetsAt: DAY_END });
    expect((await h.quota.statusOf(API)).cause).toBe('quota');
    await h.budget.applySettings(settingsOf({ profiles: { [API]: { daily: 20 } } }));
    await settle(h);
    expect(await h.quota.statusOf(API)).toMatchObject({ state: 'exhausted', cause: 'quota' });
    expect(await eventsOf(world.store, 'budget.restored')).toEqual([]);
    expect(await eventsOf(world.store, 'quota.restored')).toEqual([]);
  });

  it('keep: a raised or removed cap holds the profile until the period turns, which says reset', async () => {
    const { world, h } = await spentWorld({ on_cap_change: 'keep' });
    const keep = { on_cap_change: 'keep' };
    await h.budget.applySettings(settingsOf({ profiles: { [API]: { daily: 20 } }, budget: keep }));
    await settle(h);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    await h.budget.applySettings(settingsOf({ budget: keep }));
    await settle(h);
    expect((await h.quota.statusOf(API)).state).toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toEqual([]);
    await h.clock.advance(DAY_END - T0 + 2000);
    await settle(h);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    expect((await eventsOf(world.store, 'budget.restored'))[0]?.payload).toMatchObject({
      reason: 'reset',
    });
  });

  it('keep: the reading at start-up does not release either', async () => {
    const { world, h } = await spentWorld({ on_cap_change: 'keep' });
    await h.stop();
    const second = await world.boot({
      profiles: { [API]: { daily: 20 } },
      budget: { on_cap_change: 'keep' },
    });
    expect((await second.quota.statusOf(API)).state).toBe('exhausted');
    expect(await eventsOf(world.store, 'budget.restored')).toEqual([]);
  });
});

describe('BudgetService, budget.exceeded', () => {
  it('says it once when a profile cap is spent, with the profile, period, spending, limit and end', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    await spend(h, opus(API), 9);
    expect(await eventsOf(world.store, 'budget.exceeded')).toEqual([]);
    await spend(h, opus(API), 1.5);
    const events = await eventsOf(world.store, 'budget.exceeded');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      profile: API,
      executor: null,
      period: 'day',
      spentUsd: 10.5,
      limitUsd: 10,
      endsAt: DAY_END,
    });
    await spend(h, opus(API), 1);
    expect(await eventsOf(world.store, 'budget.exceeded')).toHaveLength(1);
  });

  it('says it for an Executor cap, without touching the profile, once per Executor and period', async () => {
    const world = new World();
    const h = await world.boot({
      profiles: { [API]: { daily: 50 } },
      executors: { [opus(API)]: { daily: 3 }, [sonnet(API)]: { daily: 4 } },
    });
    await spend(h, opus(API), 3.5);
    await spend(h, opus(API), 1);
    const events = await eventsOf(world.store, 'budget.exceeded');
    expect(events.map((e) => e.payload)).toEqual([
      {
        profile: API,
        executor: opus(API),
        period: 'day',
        spentUsd: 3.5,
        limitUsd: 3,
        endsAt: DAY_END,
      },
    ]);
    expect((await h.quota.statusOf(API)).state).not.toBe('exhausted');
    // The other Executor has its own cap and its own event.
    await spend(h, sonnet(API), 4);
    expect(await eventsOf(world.store, 'budget.exceeded')).toHaveLength(2);
    // A new day, a new event.
    await h.clock.advance(DAY_END - T0 + 2000);
    await settle(h);
    await spend(h, opus(API), 3);
    const next = await eventsOf(world.store, 'budget.exceeded');
    expect(next).toHaveLength(3);
    expect(next[2]?.payload).toMatchObject({ executor: opus(API), endsAt: DAY_END + 24 * HOUR });
  });

  it('says it for the day and the month apart, and does not repeat after a restart', async () => {
    const world = new World();
    const spec = { profiles: { [API]: { daily: 10, monthly: 10 } } };
    const first = await world.boot(spec);
    await spend(first, opus(API), 12);
    const events = await eventsOf(world.store, 'budget.exceeded');
    expect(events.map((e) => (e.payload as { period: string }).period)).toEqual(['day', 'month']);
    await first.stop();
    const second = await world.boot(spec);
    await spend(second, opus(API), 1);
    expect(await eventsOf(world.store, 'budget.exceeded')).toHaveLength(2);
  });

  it('says it for a cap lowered below what was spent, once, when the daemon starts', async () => {
    const world = new World();
    const before = await world.boot('');
    await spend(before, opus(API), 12);
    await before.stop();
    await world.boot({ profiles: { [API]: { daily: 10 } } });
    expect(await eventsOf(world.store, 'budget.exceeded')).toHaveLength(1);
  });

  it('says it again when a raised cap is spent again (a new limit)', async () => {
    const world = new World();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } });
    await spend(h, opus(API), 11);
    await h.budget.applySettings(settingsOf({ profiles: { [API]: { daily: 15 } } }));
    await settle(h);
    expect(await eventsOf(world.store, 'budget.exceeded')).toHaveLength(1);
    await spend(h, opus(API), 5);
    const events = await eventsOf(world.store, 'budget.exceeded');
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ limitUsd: 15, spentUsd: 16 });
  });
});

describe('BudgetService, a turn of unknown cost under budget.unknown_cost: ignore', () => {
  const capture = (): { logger: Logger; lines: string[] } => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    );
    return { logger, lines };
  };

  it('warns in the log once per model, saying pricing.<model> resolves it', async () => {
    const world = new World();
    const { logger, lines } = capture();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } }, undefined, logger);
    await spend(h, opus(API), undefined, 'no-such-model');
    await spend(h, opus(API), undefined, 'no-such-model');
    await spend(h, opus(API), undefined, 'other-model');
    await spend(h, opus(API), 1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('pricing.no-such-model');
    expect(lines[0]).toContain('no known cost');
    expect(lines[1]).toContain('pricing.other-model');
    // The same situation is an event too, once per model (N139, revised on 2026-11-18).
    const events = await eventsOf(world.store, 'budget.unknown_cost');
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ model: 'no-such-model', profile: API, mode: 'ignore' }),
      expect.objectContaining({ model: 'other-model', profile: API, mode: 'ignore' }),
    ]);
    // The turns are still left out of the sum, as before.
    expect((await h.budget.headroom(opus(API))).binding).toMatchObject({
      spentUsd: 1,
      unknownCostTurns: 3,
    });
    // One life of the daemon: the next one says it again.
    await h.stop();
    const again = capture();
    const second = await world.boot(
      { profiles: { [API]: { daily: 10 } } },
      undefined,
      again.logger,
    );
    await spend(second, opus(API), undefined, 'no-such-model');
    expect(again.lines).toHaveLength(1);
    expect(await eventsOf(world.store, 'budget.unknown_cost')).toHaveLength(3);
  });

  it('does not warn for a profile without a cap, for a known cost, or in the block mode', async () => {
    const world = new World();
    const { logger, lines } = capture();
    const h = await world.boot({ profiles: { [API]: { daily: 10 } } }, undefined, logger);
    await spend(h, opus(API2), undefined, 'no-such-model');
    await spend(h, opus(API), 1, 'no-such-model');
    expect(lines).toEqual([]);
    expect(await eventsOf(world.store, 'budget.unknown_cost')).toEqual([]);
    const strict = new World();
    const other = capture();
    const s = await strict.boot(
      { profiles: { [API]: { daily: 10 } }, budget: { unknown_cost: 'block' } },
      undefined,
      other.logger,
    );
    await spend(s, opus(API), undefined, 'no-such-model');
    expect(other.lines).toEqual([]);
    expect(await eventsOf(strict.store, 'budget.unknown_cost')).toEqual([]);
  });
});
