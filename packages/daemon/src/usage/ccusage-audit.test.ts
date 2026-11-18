// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  builtInPricing,
  type ProfileRecord,
  type ProfileRegistry,
  type UsageSource,
  type UsageSourceEntry,
  type UsageSourceQuery,
  type UsageSourceStatus,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { captureLogger, RecordingSituations } from '../test-helpers.js';
import { UsageAudit, diverges } from './ccusage-audit.js';
import { UsageService } from './service.js';
import type { UsageAuditSettings, UsageSettings } from './settings.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK = 'claude-code/work';

class FakeSource implements UsageSource {
  readonly id = 'fake-ccusage';
  readonly implements = { port: 'UsageSource', range: '^0.1.0' } as const;
  status: UsageSourceStatus = { ok: true, version: '20.0.48' };
  entries: UsageSourceEntry[] = [];
  failWith: Error | undefined;
  readonly queries: UsageSourceQuery[] = [];
  check(): Promise<UsageSourceStatus> {
    return Promise.resolve(this.status);
  }
  read(query: UsageSourceQuery): Promise<readonly UsageSourceEntry[]> {
    this.queries.push(query);
    return this.failWith === undefined
      ? Promise.resolve(this.entries)
      : Promise.reject(this.failWith);
  }
}

const entry = (inputTokens: number, outputTokens: number, costUsd: number | null = null) =>
  ({
    day: '2026-11-18',
    model: 'm',
    inputTokens,
    outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd,
  }) satisfies UsageSourceEntry;

const AUDIT_SETTINGS: UsageAuditSettings = {
  compare: 'tokens',
  tolerance: 0.1,
  minTokens: 100,
  minUsd: 0.01,
  intervalMs: 0,
  windowDays: 7,
};

async function profileOf(store: { profiles: ProfileRegistry }): Promise<ProfileRecord> {
  const profile = await store.profiles.get(WORK);
  if (profile === undefined) throw new Error('perfil de teste ausente');
  return profile;
}

async function setup(over: Partial<UsageAuditSettings> = {}) {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const { logger, lines } = captureLogger();
  const situations = new RecordingSituations();
  const settings: UsageSettings = {
    subscriptionDisplay: 'quota_and_equivalent',
    costSource: 'client_then_pricing',
    monthlyPriceUsd: new Map(),
    pricing: builtInPricing(),
  };
  const service = new UsageService({ store, clock, settings, logger, situations });
  await store.profiles.create({
    client: 'claude-code',
    name: 'work',
    kind: 'token_plan',
    provider: 'anthropic',
    dir: '/p/work',
  });
  const source = new FakeSource();
  const audit = new UsageAudit({
    source,
    usage: service,
    store,
    clock,
    logger,
    settings: { ...AUDIT_SETTINGS, ...over },
    situations,
  });
  const turn = async (input: number, output: number, costUsd?: number): Promise<void> => {
    service.bindSession('S1', { profile: WORK, executorId: `claude-sonnet-5-5-high@${WORK}` });
    await service.ingestSignal('S1', {
      kind: 'usage',
      model: 'claude-sonnet-5-5',
      inputTokens: input,
      outputTokens: output,
      ...(costUsd === undefined ? {} : { costUsd }),
    });
  };
  const notices = () => situations.of('usage.notice') as { kind: string; profile: string | null }[];
  return { clock, store, source, audit, turn, lines, notices };
}

describe('diverges', () => {
  it('needs the gap above the floor and above the tolerance of the larger figure', () => {
    expect(diverges(1000, 1000, 0.1, 0)).toBe(false);
    expect(diverges(1000, 905, 0.1, 0)).toBe(false); // 9.5%
    expect(diverges(1000, 890, 0.1, 0)).toBe(true); // 11%
    expect(diverges(50, 0, 0.1, 100)).toBe(false); // under the floor
    expect(diverges(0, 0, 0, 0)).toBe(false);
    expect(diverges(5, 0, 0.1, 0)).toBe(true);
  });
});

describe('UsageAudit.compareProfile', () => {
  it('agrees within the tolerance: no warning and no event', async () => {
    const { audit, source, turn, lines, notices, store } = await setup();
    await turn(1000, 200);
    source.entries = [entry(1000, 220)];
    const profile = await profileOf(store);
    const result = await audit.compareProfile(profile);
    expect(result).toMatchObject({
      profile: WORK,
      ccusage: { tokens: 1220 },
      signals: { tokens: 1200 },
      diverged: [],
    });
    expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it('reads the profile directory and the UTC window of windowDays, today included', async () => {
    const { audit, source, store } = await setup({ windowDays: 3 });
    const profile = await profileOf(store);
    await audit.compareProfile(profile);
    expect(source.queries).toEqual([
      {
        clientId: 'claude-code',
        profileDir: '/p/work',
        sinceDay: '2026-11-16',
        untilDay: '2026-11-18',
      },
    ]);
  });

  it('tells a divergence once, in the log and as a usage.notice, and again after agreeing', async () => {
    const { audit, source, turn, lines, notices, store } = await setup();
    await turn(1000, 200);
    source.entries = [entry(5000, 1000)];
    const profile = await profileOf(store);
    const first = await audit.compareProfile(profile);
    expect(first?.diverged).toEqual(['tokens']);
    await audit.compareProfile(profile);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: 'ccusage_divergence', profile: WORK });
    // back in agreement, then apart again: told again
    source.entries = [entry(1000, 200)];
    await audit.compareProfile(profile);
    source.entries = [entry(9000, 200)];
    await audit.compareProfile(profile);
    expect(notices()).toHaveLength(2);
  });

  it('a gap under the floors is not a divergence (a day with two turns)', async () => {
    const { audit, source, turn, notices, store } = await setup({ minTokens: 100 });
    await turn(10, 5);
    source.entries = [entry(60, 5)];
    const profile = await profileOf(store);
    expect((await audit.compareProfile(profile))?.diverged).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it('compares the cost only with tokens_and_cost, and only when both sides know it', async () => {
    const tokens = await setup({ compare: 'tokens' });
    await tokens.turn(1000, 200, 1);
    tokens.source.entries = [entry(1000, 200, 5)];
    const p1 = await profileOf(tokens.store);
    expect((await tokens.audit.compareProfile(p1))?.diverged).toEqual([]);

    const both = await setup({ compare: 'tokens_and_cost' });
    await both.turn(1000, 200, 1);
    both.source.entries = [entry(1000, 200, 5)];
    const p2 = await profileOf(both.store);
    expect((await both.audit.compareProfile(p2))?.diverged).toEqual(['cost']);

    const unknown = await setup({ compare: 'tokens_and_cost' });
    await unknown.turn(1000, 200, 1);
    unknown.source.entries = [entry(1000, 200, null)];
    const p3 = await profileOf(unknown.store);
    expect((await unknown.audit.compareProfile(p3))?.diverged).toEqual([]);
  });

  it('a failing read is a warning and a ccusage_failed notice once, and the result is undefined', async () => {
    const { audit, source, lines, notices, store } = await setup();
    source.failWith = new AdapterUnavailable('ccusage failed with exit code 1');
    const profile = await profileOf(store);
    expect(await audit.compareProfile(profile)).toBeUndefined();
    expect(await audit.compareProfile(profile)).toBeUndefined();
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(notices()).toEqual([expect.objectContaining({ kind: 'ccusage_failed', profile: WORK })]);
    source.failWith = undefined;
    await audit.compareProfile(profile);
    source.failWith = new AdapterUnavailable('again');
    await audit.compareProfile(profile);
    expect(notices().filter((n) => n.kind === 'ccusage_failed')).toHaveLength(2);
  });
});

describe('UsageAudit.compareAll', () => {
  it('skips removed profiles and the clients ccusage has no source for', async () => {
    const { audit, source, store } = await setup();
    await store.profiles.create({
      client: 'codex',
      name: 'home',
      kind: 'token_plan',
      provider: 'openai',
      dir: '/p/home',
    });
    await store.profiles.create({
      client: 'opencode',
      name: 'gone',
      kind: 'api',
      provider: 'x',
      dir: '/p/gone',
    });
    await store.profiles.update('opencode/gone', { state: 'draining' });
    await store.profiles.update('opencode/gone', { state: 'removed' });
    const results = await audit.compareAll();
    expect(results.map((r) => r.profile).sort()).toEqual([WORK, 'codex/home']);
    expect(source.queries.map((q) => q.clientId).sort()).toEqual(['claude-code', 'codex']);
  });
});

describe('UsageAudit.start', () => {
  it('a wrong version keeps the check off, with a warning and a ccusage_wrong_version notice', async () => {
    const { audit, source, lines, notices } = await setup();
    source.status = {
      ok: false,
      reason: 'wrong_version',
      detail: 'ccusage is 1.0.0; 20.0.48 is required',
    };
    const status = await audit.start();
    expect(status.ok).toBe(false);
    expect(audit.active).toBe(false);
    await audit.settled();
    expect(source.queries).toEqual([]);
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes('signals alone'))).toBe(true);
    expect(notices()).toEqual([
      expect.objectContaining({ kind: 'ccusage_wrong_version', profile: null }),
    ]);
  });

  it('an absent binary keeps it off with ccusage_unavailable', async () => {
    const { audit, source, notices } = await setup();
    source.status = {
      ok: false,
      reason: 'not_found',
      detail: 'the ccusage executable was not found',
    };
    await audit.start();
    expect(notices()).toEqual([expect.objectContaining({ kind: 'ccusage_unavailable' })]);
  });

  it('a check that throws is told as unavailable, never rejects', async () => {
    const { audit, source, notices } = await setup();
    source.check = () => Promise.reject(new Error('boom'));
    expect((await audit.start()).ok).toBe(false);
    expect(notices()).toEqual([expect.objectContaining({ kind: 'ccusage_unavailable' })]);
  });

  it('with interval 0 compares once and ends; with an interval it repeats until stopped', async () => {
    const once = await setup({ intervalMs: 0 });
    await once.audit.start();
    await once.audit.settled();
    expect(once.source.queries).toHaveLength(1);

    const loop = await setup({ intervalMs: 60_000 });
    await loop.audit.start();
    await waitFor(() => loop.source.queries.length === 1 && loop.clock.pendingSleeps === 1);
    await loop.clock.advance(60_000);
    await waitFor(() => loop.source.queries.length === 2);
    await loop.audit.stop();
    expect(loop.clock.pendingSleeps).toBe(0);
    await loop.clock.advance(120_000);
    expect(loop.source.queries).toHaveLength(2);
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition did not come true');
}
