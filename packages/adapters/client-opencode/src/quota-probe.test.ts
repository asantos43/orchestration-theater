// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, QuotaReadingSchema, type ProfileRef } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import {
  LEDGER_WINDOW_TOKENS,
  LEDGER_WINDOW_USD,
  OpenCodeQuotaProbe,
  type OpenCodeLedgerOptions,
} from './quota-probe.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK: ProfileRef = { client: 'opencode', profile: 'work' };
const OTHER: ProfileRef = { client: 'opencode', profile: 'other' };

function make(
  limits: Partial<Pick<OpenCodeLedgerOptions, 'limitTokens' | 'limitUsd' | 'windowMs'>> = {},
): { clock: FakeClock; probe: OpenCodeQuotaProbe } {
  const clock = new FakeClock(T0);
  const probe = new OpenCodeQuotaProbe({
    clock,
    windowMs: limits.windowMs ?? 5 * HOUR,
    limitTokens: limits.limitTokens ?? null,
    limitUsd: limits.limitUsd ?? null,
  });
  return { clock, probe };
}

describe('OpenCodeQuotaProbe without a ledger', () => {
  it('has no windows and no reading, as before', async () => {
    const probe = new OpenCodeQuotaProbe();
    expect(probe.capabilities()).toEqual({
      windows: [],
      delivery: 'poll',
      precision: 'approximate',
    });
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 10 });
    await expect(probe.read(WORK)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('is the same when the ledger has no limit to compare with', async () => {
    const { probe } = make();
    expect(probe.capabilities().windows).toEqual([]);
    await expect(probe.read(WORK)).rejects.toBeInstanceOf(AdapterUnavailable);
  });
});

describe('OpenCodeQuotaProbe ledger', () => {
  it('reports one window per configured limit, as a reading the port accepts', async () => {
    const { probe } = make({ limitTokens: 1000, limitUsd: 5 });
    expect(probe.capabilities()).toEqual({
      windows: [LEDGER_WINDOW_TOKENS, LEDGER_WINDOW_USD],
      delivery: 'both',
      precision: 'approximate',
    });
    const reading = await probe.read(WORK);
    expect(QuotaReadingSchema.safeParse(reading).success).toBe(true);
    expect(reading.windows).toEqual([
      { window: LEDGER_WINDOW_TOKENS, usedPercent: 0 },
      { window: LEDGER_WINDOW_USD, usedPercent: 0 },
    ]);
  });

  it('sums the tokens of a session across updates, per profile', async () => {
    const { probe } = make({ limitTokens: 1000 });
    probe.recordUsage(WORK, 's1', { kind: 'usage', inputTokens: 100, outputTokens: 50 });
    probe.recordUsage(WORK, 's2', { kind: 'usage', inputTokens: 200 });
    probe.recordUsage(OTHER, 's3', { kind: 'usage', inputTokens: 900 });
    const work = await probe.read(WORK);
    expect(work.windows[0]).toMatchObject({ window: LEDGER_WINDOW_TOKENS, usedPercent: 35 });
    const other = await probe.read(OTHER);
    expect(other.windows[0]?.usedPercent).toBe(90);
  });

  it('takes the cost as cumulative per session: only the difference is added', async () => {
    const { probe } = make({ limitUsd: 10 });
    probe.recordUsage(WORK, 's1', { kind: 'usage', costUsd: 1 });
    probe.recordUsage(WORK, 's1', { kind: 'usage', costUsd: 3 });
    probe.recordUsage(WORK, 's2', { kind: 'usage', costUsd: 2 });
    expect((await probe.read(WORK)).windows[0]?.usedPercent).toBe(50);
    // A cost below the last mark is a session that started over: counted whole.
    probe.recordUsage(WORK, 's1', { kind: 'usage', costUsd: 0.5 });
    expect((await probe.read(WORK)).windows[0]?.usedPercent).toBe(55);
  });

  it('ignores numbers that are not usable, and a usage with nothing to add', async () => {
    const { probe } = make({ limitTokens: 100 });
    probe.recordUsage(WORK, 's1', { kind: 'usage', inputTokens: Number.NaN, outputTokens: 0 });
    probe.recordUsage(WORK, 's1', { kind: 'usage', contextUsed: 500, contextSize: 1000 });
    expect((await probe.read(WORK)).windows[0]?.usedPercent).toBe(0);
  });

  it('rolls: what is older than the window leaves, and resetsAt is when the oldest leaves', async () => {
    const { clock, probe } = make({ limitTokens: 100 });
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 60 });
    await clock.advance(2 * HOUR);
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 30 });
    const first = await probe.read(WORK);
    expect(first.windows[0]).toMatchObject({ usedPercent: 90, resetsAt: T0 + 5 * HOUR });
    await clock.advance(3 * HOUR + 1);
    const second = await probe.read(WORK);
    expect(second.windows[0]).toMatchObject({ usedPercent: 30, resetsAt: T0 + 7 * HOUR });
    await clock.advance(2 * HOUR);
    expect((await probe.read(WORK)).windows).toEqual([
      { window: LEDGER_WINDOW_TOKENS, usedPercent: 0 },
    ]);
  });
});

describe('OpenCodeQuotaProbe watch', () => {
  it('pushes only when the whole percentage changes', () => {
    const { probe } = make({ limitTokens: 1000 });
    const seen: number[] = [];
    const watching = probe.watch(WORK, (reading) => {
      seen.push(reading.windows[0]?.usedPercent ?? -1);
    });
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 5 }); // 0.5 %: still 0
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 5 }); // 1 %
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 4 }); // 1.4 %: still 1
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 600 }); // 61.4 %
    expect(seen).toEqual([1, 61.4]);
    watching.dispose();
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 100 });
    expect(seen).toEqual([1, 61.4]);
  });

  it('does not push for another profile, and a failing listener does not break the count', async () => {
    const { probe } = make({ limitTokens: 100 });
    let calls = 0;
    probe.watch(WORK, () => {
      calls += 1;
      throw new Error('listener failed');
    });
    probe.recordUsage(OTHER, 's9', { kind: 'usage', outputTokens: 50 });
    expect(calls).toBe(0);
    probe.recordUsage(WORK, 's1', { kind: 'usage', outputTokens: 50 });
    expect(calls).toBe(1);
    expect((await probe.read(WORK)).windows[0]?.usedPercent).toBe(50);
  });
});
