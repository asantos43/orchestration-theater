// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-non-null-assertion -- the tests look up what they just built */
import { describe, expect, it } from 'vitest';
import {
  InvalidInput,
  type RollupRow,
  type TelemetrySpan,
  type TelemetryStore,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { MemoryTelemetryStore } from '../telemetry/telemetry-fixture.js';
import { DAEMON_SPAN_RESOURCE, GEN_AI, OT, SPAN_NAME } from '../telemetry/span-conventions.js';
import { AnalysisConfigSchema, type AnalysisSettings } from './analysis-config.js';
import { AnalysisService } from './analysis-service.js';

const DAY = '2026-11-10';
/** 09:00 UTC of {@link DAY}. */
const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const NOON_AFTER = Date.UTC(2026, 10, 12, 12, 0, 0);
const S = 1000;
const LOGGER = { warn: () => undefined, info: () => undefined };

function settings(over: Record<string, unknown> = {}): AnalysisSettings {
  return AnalysisConfigSchema.parse({ day_boundary: 'utc', ...over });
}

let counter = 0;
function hex(width: number): string {
  counter += 1;
  return counter.toString(16).padStart(width, '0');
}

interface SpanInit {
  readonly name: string;
  /** Start, in ms from `T0`. */
  readonly at: number;
  readonly ms: number;
  readonly attrs?: Record<string, string | number>;
  readonly scenarioId?: string | undefined;
  readonly attemptId?: string;
  readonly client?: boolean;
}

/** A span of the daemon (or, with `client`, one the client itself exported). */
function span(init: SpanInit): TelemetrySpan {
  return {
    traceId: hex(32),
    spanId: hex(16),
    parentSpanId: null,
    name: init.name,
    kind: 1,
    startTimeUnixNano: BigInt(T0 + init.at) * 1_000_000n,
    endTimeUnixNano: BigInt(T0 + init.at + init.ms) * 1_000_000n,
    status: 'unset',
    statusMessage: null,
    attributes: init.attrs ?? {},
    resource:
      init.client === true ? { 'service.name': 'claude-code' } : { ...DAEMON_SPAN_RESOURCE },
    scenarioId: init.scenarioId ?? 's1',
    playId: 'p1',
    attemptId: init.attemptId ?? null,
    sessionId: null,
  };
}

const stage = (state: string, at: number, ms: number, scenarioId?: string): TelemetrySpan =>
  span({ name: SPAN_NAME.stage, at, ms, attrs: { [OT.stage]: state }, scenarioId });

const waitSpan = (kind: string, at: number, ms: number, role = 'actor'): TelemetrySpan =>
  span({
    name: SPAN_NAME.wait,
    at,
    ms,
    attrs: {
      [OT.waitKind]: kind,
      [OT.waitMs]: ms,
      [OT.client]: 'fake',
      [OT.profile]: 'one',
      [OT.role]: role,
    },
  });

function attemptSpan(
  attemptId: string,
  role: string,
  at: number,
  ms: number,
  end: string,
  executor: { client: string; profile: string } = { client: 'fake', profile: 'one' },
  sessionId?: string,
): TelemetrySpan {
  return span({
    name: SPAN_NAME.invokeAgent(role),
    at,
    ms,
    attrs: {
      [GEN_AI.agentId]: attemptId,
      [OT.attemptEnd]: end,
      [OT.role]: role,
      [OT.client]: executor.client,
      [OT.profile]: executor.profile,
      ...(sessionId === undefined ? {} : { [GEN_AI.conversationId]: sessionId }),
    },
    attemptId,
  });
}

interface Notice {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface Rig {
  readonly clock: FakeClock;
  readonly store: InMemoryStore;
  readonly telemetry: MemoryTelemetryStore;
  readonly notices: Notice[];
  readonly service: AnalysisService;
}

function makeRig(
  options: { settings?: AnalysisSettings; telemetry?: MemoryTelemetryStore; nowMs?: number } = {},
): Rig {
  const clock = new FakeClock(options.nowMs ?? T0);
  const store = new InMemoryStore({ clock });
  const telemetry = options.telemetry ?? new MemoryTelemetryStore();
  const notices: Notice[] = [];
  const service = new AnalysisService({
    clock,
    telemetry,
    events: store.events,
    usage: store.usage,
    settings: () => options.settings ?? settings(),
    situations: {
      record: (type, payload) => {
        notices.push({ type, payload });
      },
    },
    logger: LOGGER,
  });
  return { clock, store, telemetry, notices, service };
}

async function event(
  rig: Rig,
  atMs: number,
  type: string,
  payload: Record<string, string | number>,
  scenarioId = 's1',
): Promise<void> {
  const behind = T0 + atMs - rig.clock.now();
  if (behind > 0) await rig.clock.advance(behind);
  await rig.store.events.append({ type, schemaVersion: 1, payload, scenarioId, playId: 'p1' });
}

/**
 * One day of simulated plays. Scenario `s1`, three attempts:
 * - `a1`, role actor on fake/one, 100 s, submitted, with a record of the client itself;
 * - `a2`, role actor on fake/one, 200 s, cancelled, none from the client;
 * - `a3`, role critic on claude/work, 50 s, submitted, none from the client and no tokens.
 * Times in the states, a quota wait of 30 s, a queue wait of 5 s, one rejection, two approved
 * demands, one interruption by quota, and the three turns of usage.
 */
async function simulateDay(rig: Rig): Promise<void> {
  const { telemetry, store } = rig;
  telemetry.write({
    spans: [
      span({ name: SPAN_NAME.play, at: 0, ms: 600 * S, attrs: { [OT.playFinalState]: 'DONE' } }),
      stage('PLANNING', 0, 60 * S),
      stage('AWAITING_PRODUCER', 60 * S, 120 * S),
      stage('EXECUTING', 180 * S, 300 * S),
      stage('PLANNING', 480 * S, 40 * S),
      waitSpan('quota', 10 * S, 30 * S),
      waitSpan('prompt_queue', 50 * S, 5 * S),
      attemptSpan('a1', 'actor', 200 * S, 100 * S, 'submitted', undefined, 'sess-1'),
      attemptSpan('a2', 'actor', 320 * S, 200 * S, 'cancelled'),
      attemptSpan('a3', 'critic', 330 * S, 50 * S, 'submitted', {
        client: 'claude',
        profile: 'work',
      }),
      span({ name: 'chat', at: 210 * S, ms: 20 * S, attemptId: 'a1', client: true }),
    ],
  });
  await event(rig, 100 * S, 'play.transitioned', {
    event: 'PLAN_REVIEWED',
    from: 'PLAN_REVIEW',
    to: 'PLANNING',
  });
  await event(rig, 110 * S, 'play.transitioned', {
    event: 'START',
    from: 'NEED',
    to: 'PLANNING',
  });
  await event(rig, 120 * S, 'demand.transitioned', { from: 'proposed', to: 'approved' });
  await event(rig, 130 * S, 'demand.transitioned', { from: 'proposed', to: 'approved' });
  await event(rig, 140 * S, 'demand.transitioned', { from: 'proposed', to: 'rejected' });
  await event(rig, 250 * S, 'session.interrupted', { sessionId: 'sess-1', cause: 'quota' });
  const at = T0 + 300 * S;
  await store.usage.record({
    sessionId: 'sess-1',
    playId: 'p1',
    profileId: 'fake/one',
    executorId: 'e1',
    model: 'm',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 10,
    cost: { usd: 0.5, kind: 'real', source: 'client' },
    occurredAt: at,
  });
  await store.usage.record({
    sessionId: 'sess-1',
    playId: 'p1',
    profileId: 'fake/one',
    executorId: 'e1',
    model: 'm',
    inputTokens: 300,
    outputTokens: 70,
    cost: { usd: 1, kind: 'api_equivalent', source: 'pricing_table', pricingVersion: 'v1' },
    occurredAt: at + S,
  });
  // The client that reports no tokens and no cost (OpenCode without usage, Codex per process).
  await store.usage.record({
    sessionId: 'sess-3',
    playId: 'p1',
    profileId: 'claude/work',
    executorId: 'e2',
    model: 'm',
    occurredAt: at + 2 * S,
  });
  await rig.clock.advance(NOON_AFTER - rig.clock.now());
}

function find(
  rows: readonly RollupRow[],
  metric: string,
  facet = '',
  match: Partial<RollupRow> = {},
): RollupRow {
  const row = rows.find(
    (r) =>
      r.metric === metric &&
      r.facet === facet &&
      (Object.keys(match) as (keyof RollupRow)[]).every((key) => r[key] === match[key]),
  );
  if (row === undefined) throw new Error(`no row ${metric}/${facet} in ${JSON.stringify(rows)}`);
  return row;
}

describe('the aggregates of a day of simulated plays (P9)', () => {
  it('holds the expected times, waits, counts, tokens and cost', async () => {
    const rig = makeRig();
    await simulateDay(rig);
    await rig.service.aggregateDay(DAY);
    const rows = await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY });

    // The time in each state: the visits of a state are the samples of its row.
    expect(find(rows, 'stage_ms', 'PLANNING')).toMatchObject({
      count: 2,
      sum: 100 * S,
      max: 60 * S,
    });
    expect(find(rows, 'stage_ms', 'EXECUTING')).toMatchObject({ count: 1, sum: 300 * S });
    expect(find(rows, 'play_ms', 'DONE')).toMatchObject({ count: 1, sum: 600 * S });

    // The waits, with the Producer one taken from the time in AWAITING_PRODUCER.
    expect(find(rows, 'wait_ms', 'quota')).toMatchObject({
      count: 1,
      sum: 30 * S,
      executor: 'fake/one',
      role: 'actor',
    });
    expect(find(rows, 'wait_ms', 'prompt_queue')).toMatchObject({ count: 1, sum: 5 * S });
    expect(find(rows, 'wait_ms', 'producer')).toMatchObject({ count: 1, sum: 120 * S });

    // Attempts by who did them and how they ended.
    expect(find(rows, 'attempts', 'submitted', { role: 'actor' }).count).toBe(1);
    expect(find(rows, 'attempts', 'cancelled', { role: 'actor' }).count).toBe(1);
    expect(find(rows, 'attempts', 'submitted', { role: 'critic' })).toMatchObject({
      executor: 'claude/work',
      count: 1,
    });
    expect(find(rows, 'attempt_ms', '', { role: 'actor' })).toMatchObject({
      count: 2,
      sum: 300 * S,
      p50: 100 * S,
      p95: 200 * S,
    });

    // One rejection (the review that sent the play back), two approved demands, one interruption
    // whose Executor and role come from the span of the session.
    expect(find(rows, 'rejections', 'PLAN_REVIEWED').count).toBe(1);
    expect(find(rows, 'approved_demands').count).toBe(2);
    expect(find(rows, 'interruptions', 'quota')).toMatchObject({
      count: 1,
      executor: 'fake/one',
      role: 'actor',
    });

    // Tokens and cost, with where each number came from.
    expect(find(rows, 'tokens_in', '', { executor: 'fake/one' })).toMatchObject({
      count: 2,
      sum: 400,
      origin: 'client',
    });
    expect(find(rows, 'cost_usd', 'real')).toMatchObject({ sum: 0.5, origin: 'client' });
    expect(find(rows, 'cost_usd', 'api_equivalent')).toMatchObject({
      sum: 1,
      origin: 'pricing_table',
    });
  });

  it('shows a client without tokens as a gap and as partial coverage, not as zero', async () => {
    const rig = makeRig();
    await simulateDay(rig);
    await rig.service.aggregateDay(DAY);
    const rows = await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY });
    const gap = find(rows, 'tokens_in', '', { executor: 'claude/work' });
    expect(gap).toMatchObject({ count: 0, sum: null, p50: null, p95: null, max: null });
    expect(rows.some((r) => r.metric === 'cost_usd' && r.executor === 'claude/work')).toBe(false);

    await rig.service.catchUp();
    const report = await rig.service.report({ from: DAY, to: DAY, groupBy: 'executor' });
    const opencode = report.groups.find((g) => g.key === 'claude/work')!.summary;
    expect(opencode.tokens).toEqual({ input: null, output: null, cached: null });
    expect(opencode.cost.realUsd).toBeNull();
    expect(opencode.coverage).toMatchObject({
      usageTurns: 1,
      usageTurnsWithTokens: 0,
      tokenCoverage: 0,
      costCoverage: 0,
      attempts: 1,
      attemptsWithClientTelemetry: 0,
    });
    const fake = report.groups.find((g) => g.key === 'fake/one')!.summary;
    expect(fake.tokens.input).toBe(400);
    expect(fake.coverage).toMatchObject({
      attempts: 2,
      attemptsWithClientTelemetry: 1,
      attemptCoverage: 0.5,
      tokenCoverage: 1,
      costCoverage: 1,
    });
    expect(fake.coverage.origins).toEqual(
      expect.arrayContaining(['client', 'otlp', 'pricing_table']),
    );
    // The whole period is partial too: one attempt of three has client telemetry.
    expect(report.period.summary.coverage.attemptCoverage).toBeCloseTo(1 / 3);
  });

  it('gives the same aggregate when the day is reprocessed', async () => {
    const rig = makeRig();
    await simulateDay(rig);
    await rig.service.aggregateDay(DAY);
    const first = await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY });
    expect(first.length).toBeGreaterThan(10);
    await rig.service.aggregateDay(DAY);
    await rig.service.aggregateDay(DAY);
    expect(await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY })).toEqual(first);
  });

  it('keeps the rows of a day whose raw telemetry was purged', async () => {
    const rig = makeRig();
    await simulateDay(rig);
    await rig.service.aggregateDay(DAY);
    const before = await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY });
    // A different base with nothing in it for the day, over the same aggregates.
    const purged = makeRig({ telemetry: rig.telemetry, nowMs: NOON_AFTER });
    rig.telemetry.write({ spans: [] });
    const empty = new MemoryTelemetryStore();
    await empty.replaceRollupDay(DAY, before);
    const service = new AnalysisService({
      clock: purged.clock,
      telemetry: empty,
      events: purged.store.events,
      usage: purged.store.usage,
      settings: () => settings(),
      logger: LOGGER,
    });
    const result = await service.aggregateDay(DAY);
    expect(result).toMatchObject({ rows: 0, kept: true });
    expect(await empty.readRollups({ fromDay: DAY, toDay: DAY })).toEqual(before);
  });

  it('refuses a day that is not one', async () => {
    const rig = makeRig();
    await expect(rig.service.aggregateDay('2026-02-30')).rejects.toBeInstanceOf(InvalidInput);
    await expect(rig.service.aggregateDay('yesterday')).rejects.toBeInstanceOf(InvalidInput);
  });

  it('splits the spans of two scenarios and counts a span on the day it ended', async () => {
    const rig = makeRig();
    rig.telemetry.write({
      spans: [
        stage('PLANNING', 0, 10 * S, 's1'),
        stage('PLANNING', 0, 40 * S, 's2'),
        // Started the day before, ended on the day: belongs to the day.
        stage('EXECUTING', -2 * 60 * 60 * S, 2 * 60 * 60 * S + 5 * S, 's1'),
        // Ends on the next day: not on this one.
        stage('EXECUTING', 14 * 60 * 60 * S, 2 * 60 * 60 * S, 's1'),
      ],
    });
    await rig.clock.advance(NOON_AFTER - rig.clock.now());
    await rig.service.aggregateDay(DAY);
    const rows = await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY });
    expect(find(rows, 'stage_ms', 'PLANNING', { scenarioId: 's1' }).sum).toBe(10 * S);
    expect(find(rows, 'stage_ms', 'PLANNING', { scenarioId: 's2' }).sum).toBe(40 * S);
    const executing = rows.filter((r) => r.metric === 'stage_ms' && r.facet === 'EXECUTING');
    expect(executing).toHaveLength(1);
    expect(executing[0]!.sum).toBe(2 * 60 * 60 * S + 5 * S);
  });

  it('takes the states of analysis.producer_wait_states as the wait for the Producer', async () => {
    const rig = makeRig({ settings: settings({ producer_wait_states: ['CLARIFYING'] }) });
    rig.telemetry.write({
      spans: [stage('CLARIFYING', 0, 70 * S), stage('AWAITING_PRODUCER', 100 * S, 30 * S)],
    });
    await rig.clock.advance(NOON_AFTER - rig.clock.now());
    await rig.service.aggregateDay(DAY);
    const rows = await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY });
    expect(find(rows, 'wait_ms', 'producer').sum).toBe(70 * S);
  });
});

describe('the catch-up and the ready marker (P9, hook of P8)', () => {
  it('builds the closed days up to yesterday, marks each one ready and never builds today', async () => {
    const rig = makeRig();
    await simulateDay(rig);
    expect(await rig.service.readyThrough()).toBeNull();
    const results = await rig.service.catchUp();
    // Day 10 (with data) and day 11 (empty); the 12th is today.
    expect(results.map((r) => r.day)).toEqual(['2026-11-10', '2026-11-11']);
    expect(await rig.service.readyThrough()).toBe('2026-11-11');
    expect(rig.service.today()).toBe('2026-11-12');
    expect(await rig.telemetry.readRollups({ fromDay: '2026-11-12' })).toEqual([]);
  });

  it('does nothing without raw telemetry and does not build a day twice', async () => {
    const empty = makeRig({ nowMs: NOON_AFTER });
    expect(await empty.service.catchUp()).toEqual([]);
    expect(await empty.service.readyThrough()).toBeNull();

    const rig = makeRig();
    await simulateDay(rig);
    await rig.service.catchUp();
    expect(await rig.service.catchUp()).toEqual([]);
    // A day already marked ready is not built again by itself.
    const before = await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY });
    rig.telemetry.write({ spans: [stage('IDEATING', 0, 9 * S)] });
    await rig.service.catchUp();
    expect(await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY })).toEqual(before);
  });

  it('applies analysis.retention.days to the aggregates, not to anything else', async () => {
    const rig = makeRig({ settings: settings({ retention: { days: 1 } }) });
    await simulateDay(rig);
    await rig.telemetry.replaceRollupDay('2026-11-01', [
      { ...find(await aggregatedRows(), 'stage_ms', 'PLANNING'), day: '2026-11-01' },
    ]);
    await rig.service.catchUp();
    expect(await rig.telemetry.readRollups({ fromDay: '2026-11-01', toDay: '2026-11-01' })).toEqual(
      [],
    );
    // Day 10 is two days old and the retention is one day: it was built, then removed with it.
    expect(await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY })).toEqual([]);
    // The raw telemetry is not the aggregates' to delete.
    expect((await rig.telemetry.readSpans()).length).toBeGreaterThan(5);
  });

  it('keeps the aggregates forever with retention.days 0', async () => {
    const rig = makeRig({ settings: settings({ retention: { days: 0 } }) });
    await simulateDay(rig);
    await rig.service.catchUp();
    expect((await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY })).length).toBeGreaterThan(
      0,
    );
  });

  it('tells a failure as a daemon.notice analysis_failed and stops at the day that failed', async () => {
    class Failing extends MemoryTelemetryStore {
      override replaceRollupDay(day: string, rows: readonly RollupRow[]): Promise<void> {
        if (day === '2026-11-11') return Promise.reject(new Error('disk full'));
        return super.replaceRollupDay(day, rows);
      }
    }
    const rig = makeRig({ telemetry: new Failing() });
    await simulateDay(rig);
    const results = await rig.service.catchUp();
    expect(results.map((r) => r.day)).toEqual(['2026-11-10']);
    // The marker stays contiguous: the day after the failed one is not ready.
    expect(await rig.service.readyThrough()).toBe('2026-11-10');
    expect(rig.notices).toHaveLength(1);
    expect(rig.notices[0]).toMatchObject({
      type: 'daemon.notice',
      payload: { kind: 'analysis_failed', subject: '2026-11-11' },
    });
    expect(String(rig.notices[0]!.payload.detail)).toContain('disk full');
  });
});

describe('the schedule of the aggregation (P9)', () => {
  it('builds the missing days at the start and again at each rollover of the day, by the clock', async () => {
    const rig = makeRig({ nowMs: Date.UTC(2026, 10, 10, 9) });
    rig.telemetry.write({ spans: [stage('PLANNING', 0, 10 * S)] });
    // Today is the 10th: nothing is closed yet.
    rig.service.start();
    await rig.clock.advance(0);
    expect(await rig.service.readyThrough()).toBeNull();

    // At the rollover the 10th closes and is built.
    await rig.clock.advance(15 * 60 * 60 * 1000);
    expect(rig.service.today()).toBe('2026-11-11');
    await settled(rig, '2026-11-10');
    expect(
      find(await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY }), 'stage_ms', 'PLANNING')
        .sum,
    ).toBe(10 * S);

    rig.telemetry.write({
      spans: [
        span({
          name: SPAN_NAME.stage,
          at: 30 * 60 * 60 * 1000,
          ms: 20 * S,
          attrs: { [OT.stage]: 'EXECUTING' },
        }),
      ],
    });
    await rig.clock.advance(24 * 60 * 60 * 1000);
    await settled(rig, '2026-11-11');
    await rig.service.stop();
    expect(rig.clock.pendingSleeps).toBe(0);
  });

  it('catches up at the start when days are missing', async () => {
    const rig = makeRig();
    await simulateDay(rig);
    rig.service.start();
    await settled(rig, '2026-11-11');
    await rig.service.stop();
  });

  it.each(['off'])('does not build anything by itself with schedule.mode %s', async (mode) => {
    const rig = makeRig({ settings: settings({ schedule: { mode } }) });
    await simulateDay(rig);
    rig.service.start();
    await rig.clock.advance(24 * 60 * 60 * 1000);
    expect(await rig.service.readyThrough()).toBeNull();
    await rig.service.stop();
  });

  it('builds only at the start with schedule.mode startup', async () => {
    const rig = makeRig({ settings: settings({ schedule: { mode: 'startup' } }) });
    await simulateDay(rig);
    rig.service.start();
    await settled(rig, '2026-11-11');
    // No sleep is waiting for the next rollover.
    expect(rig.clock.pendingSleeps).toBe(0);
    await rig.service.stop();
  });
});

/** Waits until the marker reaches a day (the loop runs on promises, not on timers). */
async function settled(rig: Rig, through: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const ready = await rig.service.readyThrough();
    if (ready !== null && ready >= through) return;
    await rig.clock.advance(0);
  }
  throw new Error(`the aggregates did not reach ${through}`);
}

/** Rows of a day to borrow a valid row from. */
async function aggregatedRows(): Promise<RollupRow[]> {
  const rig = makeRig();
  await simulateDay(rig);
  await rig.service.aggregateDay(DAY);
  return [...(await rig.telemetry.readRollups({ fromDay: DAY, toDay: DAY }))];
}

describe('the report (P9)', () => {
  async function reported(): Promise<Rig> {
    const rig = makeRig();
    await simulateDay(rig);
    // A second scenario on the next day, with longer waits for the quota.
    rig.telemetry.write({
      spans: [
        span({
          name: SPAN_NAME.wait,
          at: 24 * 60 * 60 * 1000 + 60 * S,
          ms: 300 * S,
          attrs: {
            [OT.waitKind]: 'quota',
            [OT.waitMs]: 300 * S,
            [OT.client]: 'fake',
            [OT.profile]: 'one',
            [OT.role]: 'actor',
          },
          scenarioId: 's2',
        }),
        stage('EXECUTING', 24 * 60 * 60 * 1000 + 100 * S, 50 * S, 's2'),
      ],
    });
    await rig.service.catchUp();
    return rig;
  }

  it('lists the bottlenecks by total time, with the share of the listed time', async () => {
    const rig = await reported();
    const report = await rig.service.report({ from: DAY, to: '2026-11-11' });
    expect(report.readyThrough).toBe('2026-11-11');
    expect(report.missingDays).toBe(0);
    const names = report.period.bottlenecks.map((b) => `${b.kind}:${b.name}`);
    // EXECUTING (300 s + 50 s), the quota wait (330 s)...
    expect(names.slice(0, 2)).toEqual(['stage:EXECUTING', 'wait:quota']);
    // The wait for the Producer is the time of the state: it is not listed twice.
    expect(names).not.toContain('wait:producer');
    const total = report.period.bottlenecks.reduce((a, b) => a + b.share, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(report.period.summary.waits.producer).toMatchObject({ sumMs: 120 * S });
  });

  it.each([
    ['day', ['2026-11-10', '2026-11-11']],
    ['scenario', ['s1', 's2']],
    ['executor', ['', 'claude/work', 'fake/one']],
    ['role', ['', 'actor', 'critic']],
  ] as const)('groups by %s', async (groupBy, keys) => {
    const rig = await reported();
    const report = await rig.service.report({ from: DAY, to: '2026-11-11', groupBy });
    expect(report.groupBy).toBe(groupBy);
    expect(report.groups.map((g) => g.key)).toEqual(keys);
  });

  it('compares two periods and two scenarios, with the change of each figure', async () => {
    const rig = await reported();
    const periods = await rig.service.report({
      from: DAY,
      to: DAY,
      compareFrom: '2026-11-11',
      compareTo: '2026-11-11',
    });
    expect(periods.compare?.period).toMatchObject({ from: '2026-11-11', to: '2026-11-11' });
    const quota = periods.compare!.deltas.find((d) => d.metric === 'wait.quota.sumMs')!;
    expect(quota).toEqual({
      metric: 'wait.quota.sumMs',
      base: 30 * S,
      other: 300 * S,
      delta: 270 * S,
      ratio: 9,
    });

    const scenarios = await rig.service.report({
      from: DAY,
      to: '2026-11-11',
      scenario: 's1',
      compareScenario: 's2',
    });
    expect(scenarios.period.scenario).toBe('s1');
    expect(scenarios.compare?.period.scenario).toBe('s2');
    expect(scenarios.compare!.deltas.find((d) => d.metric === 'attempts')).toMatchObject({
      base: 3,
      other: 0,
      delta: -3,
    });
  });

  it('leaves a figure nobody knew as null in the comparison, not as a change', async () => {
    const rig = await reported();
    const report = await rig.service.report({
      from: DAY,
      to: DAY,
      scenario: 's1',
      compareScenario: 's2',
    });
    const cost = report.compare!.deltas.find((d) => d.metric === 'cost.realUsd')!;
    expect(cost).toMatchObject({ base: 0.5, other: null, delta: null, ratio: null });
  });

  it('counts the days of the period the aggregates do not hold', async () => {
    const rig = await reported();
    const report = await rig.service.report({ from: '2026-11-08', to: '2026-11-11' });
    expect(report.missingDays).toBe(2);
  });

  it('defaults the period to analysis.report.default_days up to the last day ready', async () => {
    const rig = await reported();
    const report = await rig.service.report();
    expect(report.period).toMatchObject({ from: '2026-11-05', to: '2026-11-11' });
    expect(report.groupBy).toBe('day');
  });

  it('says when the percentiles are joined from more than one row', async () => {
    const rig = await reported();
    const exact = await rig.service.report({ from: DAY, to: DAY, scenario: 's1', groupBy: 'role' });
    expect(exact.groups.find((g) => g.key === 'actor')!.summary.attempts.duration).toMatchObject({
      count: 2,
      p50Ms: 100 * S,
      p95Ms: 200 * S,
    });
    const joined = await rig.service.report({ from: DAY, to: '2026-11-11' });
    expect(joined.percentilesApproximate).toBe(true);
  });

  it('answers an empty report before the first aggregate', async () => {
    const rig = makeRig({ nowMs: NOON_AFTER });
    const report = await rig.service.report();
    expect(report.readyThrough).toBeNull();
    expect(report.groups).toEqual([]);
    expect(report.period.summary.attempts.total).toBe(0);
    expect(report.period.summary.coverage.attemptCoverage).toBeNull();
    expect(report.period.bottlenecks).toEqual([]);
  });

  it.each([
    [{ from: '2026-11-11', to: '2026-11-10' }],
    [{ from: '2026-02-30', to: '2026-03-02' }],
    [{ from: '2010-01-01', to: '2026-11-10' }],
    [{ compareScenario: 's2' }],
    [{ compareFrom: '2026-11-01' }],
    [{ scenario: 's1', compareScenario: 's2', compareFrom: '2026-11-01', compareTo: '2026-11-02' }],
  ])('refuses the query %j', async (query) => {
    const rig = await reported();
    await expect(rig.service.report(query)).rejects.toBeInstanceOf(InvalidInput);
  });
});

/** Compile-time check that the fixture really is a port. */
export const port: TelemetryStore = new MemoryTelemetryStore();
