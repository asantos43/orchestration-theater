// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { QuotaSnapshotRecord, UsageRecord } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { createSilentLogger } from '../logger.js';
import { MetricsCollector, splitProfileId, usageFamilies, type MetricsSources } from './metrics.js';

const T0 = 1_800_000_000_000;

function snapshot(
  profileId: string,
  window: string,
  usedPercent: number,
  resetsAt: number | null,
): QuotaSnapshotRecord {
  return {
    profileId,
    window,
    usedPercent,
    resetsAt,
    source: 'probe',
    observedAt: T0,
  } as QuotaSnapshotRecord;
}

function usage(partial: Partial<UsageRecord>): UsageRecord {
  return {
    id: 'U1',
    seq: 1,
    sessionId: 'S1',
    playId: null,
    profileId: 'fake/one',
    executorId: 'fake-model@fake/one',
    model: 'fake-model',
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: null,
    costUsd: null,
    costKind: null,
    costSource: null,
    pricingVersion: null,
    occurredAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

interface Rig {
  readonly collector: MetricsCollector;
  readonly clock: FakeClock;
  readonly reads: { usage: number };
  readonly state: {
    snapshots: QuotaSnapshotRecord[];
    usage: UsageRecord[];
    pending: number;
    failQuota: boolean;
  };
}

function makeRig(extra: Partial<MetricsSources> = {}): Rig {
  const clock = new FakeClock(T0);
  const reads = { usage: 0 };
  const state = {
    snapshots: [] as QuotaSnapshotRecord[],
    usage: [] as UsageRecord[],
    pending: 0,
    failQuota: false,
  };
  const collector = new MetricsCollector({
    clock,
    store: {
      quotaSnapshots: {
        list: () =>
          state.failQuota ? Promise.reject(new Error('boom')) : Promise.resolve(state.snapshots),
      },
      usage: {
        list: () => {
          reads.usage += 1;
          return Promise.resolve(state.usage);
        },
      },
      promptQueue: {
        list: () => Promise.resolve(Array.from({ length: state.pending }, () => ({}))),
      },
    } as never,
    pool: () => ({ processes: 1, sessions: 2, queued: 4 }),
    events: {
      attempts: () => [
        { labels: { executor: 'e', role: 'actor', outcome: 'submitted' }, value: 2 },
      ],
      resumes: () => [{ labels: { executor: 'e', reason: 'quota' }, value: 1 }],
      failures: () => [{ labels: { executor: 'e', kind: 'crash' }, value: 3 }],
    },
    cacheTtl: 5000,
    logger: createSilentLogger(),
    ...extra,
  });
  return { collector, clock, reads, state };
}

describe('splitProfileId', () => {
  it('splits client and profile', () => {
    expect(splitProfileId('fake/one')).toEqual({ client: 'fake', profile: 'one' });
    expect(splitProfileId('lonely')).toEqual({ client: 'unknown', profile: 'lonely' });
  });
});

describe('MetricsCollector', () => {
  it('turns the quota readings into a ratio and a reset time, leaving the hit markers out', async () => {
    const rig = makeRig();
    rig.state.snapshots = [
      snapshot('fake/one', '5h', 42, T0 + 3_600_000),
      snapshot('fake/one', 'week', 100, null),
      snapshot('fake/one', 'limit_hit', 100, T0 + 1000),
      snapshot('fake/one', 'budget_hit', 100, null),
    ];
    const text = await rig.collector.render();
    expect(text).toContain('# TYPE otheater_quota_used_ratio gauge');
    expect(text).toContain(
      'otheater_quota_used_ratio{profile="one",client="fake",window="5h"} 0.42',
    );
    expect(text).toContain(
      'otheater_quota_used_ratio{profile="one",client="fake",window="week"} 1',
    );
    expect(text).toContain(
      `otheater_quota_resets_at_seconds{profile="one",client="fake",window="5h"} ${String((T0 + 3_600_000) / 1000)}`,
    );
    expect(text).not.toContain('limit_hit');
    expect(text).not.toContain('budget_hit');
    expect(text).not.toMatch(/resets_at_seconds\{[^}]*window="week"/u);
  });

  it('sums the usage by profile, Executor and model, and the costs by what they mean', async () => {
    const rig = makeRig();
    rig.state.usage = [
      usage({ id: 'U1', inputTokens: 10, outputTokens: 5, cachedTokens: 2 }),
      usage({
        id: 'U2',
        inputTokens: 1,
        outputTokens: null,
        costUsd: 0.5,
        costKind: 'real',
        costSource: 'client',
      }),
      usage({
        id: 'U3',
        profileId: 'fake/two',
        executorId: 'fake-model@fake/two',
        costUsd: 2,
        costKind: 'api_equivalent',
        costSource: 'pricing_table',
        pricingVersion: 'v1',
      }),
      usage({ id: 'U4', costUsd: 1, costKind: 'real', costSource: 'client' }),
    ];
    const text = await rig.collector.render();
    const tokens = (kind: string, executor = 'fake-model@fake/one') =>
      `otheater_usage_tokens_total{profile="one",executor="${executor}",model="fake-model",kind="${kind}"}`;
    expect(text).toContain(`${tokens('input')} 21`);
    expect(text).toContain(`${tokens('output')} 10`);
    expect(text).toContain(`${tokens('cached')} 2`);
    expect(text).toContain(
      'otheater_usage_cost_usd_total{profile="one",executor="fake-model@fake/one",source="client"} 1.5',
    );
    expect(text).toContain(
      'otheater_usage_api_equivalent_usd_total{profile="two",executor="fake-model@fake/two"} 2',
    );
    expect(text).not.toContain('source="pricing_table"');
  });

  it('does not make a zero out of an unknown count or cost', () => {
    const families = usageFamilies([
      usage({ inputTokens: null, outputTokens: null, cachedTokens: null }),
    ]);
    expect(families.map((family) => family.samples.length)).toEqual([0, 0, 0]);
  });

  it('reads the usage once per cache window', async () => {
    const rig = makeRig();
    rig.state.usage = [usage({})];
    await rig.collector.render();
    await rig.collector.render();
    expect(rig.reads.usage).toBe(1);
    rig.state.usage = [usage({}), usage({ id: 'U2' })];
    await rig.clock.advance(4999);
    await rig.collector.render();
    expect(rig.reads.usage).toBe(1);
    await rig.clock.advance(1);
    const text = await rig.collector.render();
    expect(rig.reads.usage).toBe(2);
    expect(text).toContain('kind="input"} 20');
  });

  it('shows the queues: the prompts not delivered and the sessions waiting for a slot', async () => {
    const rig = makeRig();
    rig.state.pending = 3;
    const text = await rig.collector.render();
    expect(text).toContain('otheater_scheduler_queue_depth{queue="prompts"} 3');
    expect(text).toContain('otheater_scheduler_queue_depth{queue="session_pool"} 4');
  });

  it('leaves the pool queue out while there is no execution', async () => {
    const rig = makeRig({ pool: () => undefined });
    const text = await rig.collector.render();
    expect(text).toContain('queue="prompts"');
    expect(text).not.toContain('session_pool');
  });

  it('shows the counters of the events', async () => {
    const text = await makeRig().collector.render();
    expect(text).toContain(
      'otheater_attempts_total{executor="e",role="actor",outcome="submitted"} 2',
    );
    expect(text).toContain('otheater_resumes_total{executor="e",reason="quota"} 1');
    expect(text).toContain('otheater_executor_failures_total{executor="e",kind="crash"} 3');
  });

  it('counts what the telemetry base and the exporter dropped', async () => {
    const rig = makeRig({
      telemetry: {
        health: () =>
          Promise.resolve({
            state: 'ok',
            queued: 0,
            written: 9,
            droppedOverflow: 4,
            discarded: 2,
            resets: 0,
            fileBytes: null,
          }),
      },
      exporter: () => ({ exported: 7, dropped: { unreachable: 5, timeout: 1 } }),
    });
    const text = await rig.collector.render();
    expect(text).toContain('otheater_telemetry_dropped_total{reason="discarded"} 2');
    expect(text).toContain('otheater_telemetry_dropped_total{reason="queue_overflow"} 4');
    expect(text).toContain('otheater_telemetry_dropped_total{reason="export_unreachable"} 5');
    expect(text).toContain('otheater_telemetry_dropped_total{reason="export_timeout"} 1');
  });

  it('declares every family of the proposal, even with no sample', async () => {
    const text = await makeRig().collector.render();
    for (const name of [
      'otheater_quota_used_ratio',
      'otheater_quota_resets_at_seconds',
      'otheater_usage_tokens_total',
      'otheater_usage_cost_usd_total',
      'otheater_usage_api_equivalent_usd_total',
      'otheater_scheduler_queue_depth',
      'otheater_attempts_total',
      'otheater_resumes_total',
      'otheater_executor_failures_total',
      'otheater_telemetry_dropped_total',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  it('leaves out the source that fails and keeps the rest', async () => {
    const rig = makeRig();
    rig.state.failQuota = true;
    const text = await rig.collector.render();
    expect(text).not.toContain('otheater_quota_used_ratio');
    expect(text).toContain('otheater_attempts_total');
  });

  it('never puts an e-mail or an account id in a label', async () => {
    const rig = makeRig();
    rig.state.snapshots = [snapshot('fake/one', '5h', 1, null)];
    rig.state.usage = [usage({})];
    const text = await rig.collector.render();
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/iu);
  });
});
