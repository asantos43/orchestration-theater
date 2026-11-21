// SPDX-License-Identifier: MPL-2.0
import {
  API_ROUTES,
  type AnalysisReport,
  type AnalysisSummary,
  type PlaySpan,
  type PlaySpans,
  type TelemetryStatus,
} from '@otheater/protocol';
import { vi } from 'vitest';
import type { FakeOnline } from '../../layout.test-support.js';
import { trendRows, trendWindow } from './panels-model.js';

/** What the tests of the telemetry panels of the Usage tab (P10) share: the fixtures and the stub. */

/** The window of the trend the tab asks for with the default 14 days, at the moment of the test. */
export function defaultWindow(days = 14): { readonly from: string; readonly to: string } {
  return trendWindow(Date.now(), days);
}

export function summary(extra: Partial<AnalysisSummary> = {}): AnalysisSummary {
  const stat = { count: 0, sumMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  return {
    attempts: { total: 3, byEnd: { submitted: 3 }, duration: { ...stat, count: 3, sumMs: 9000 } },
    rejections: 0,
    interruptions: {},
    approvedDemands: 1,
    stages: {},
    waits: {},
    tokens: { input: 12_500, output: 3_400, cached: 1_000 },
    cost: {
      realUsd: 1.5,
      apiEquivalentUsd: 4.25,
      realPerApprovedDemandUsd: 1.5,
      apiEquivalentPerApprovedDemandUsd: 4.25,
    },
    coverage: {
      attempts: 3,
      attemptsWithClientTelemetry: 2,
      attemptCoverage: 0.67,
      usageTurns: 10,
      usageTurnsWithTokens: 9,
      tokenCoverage: 0.9,
      usageTurnsWithCost: 5,
      costCoverage: 0.5,
      origins: ['daemon', 'otlp'],
    },
    ...extra,
  };
}

export interface AnalysisFixture {
  readonly report: AnalysisReport;
  /** The day the aggregates have nothing for. */
  readonly gapDay: string;
  /** The day whose cost no turn reported. */
  readonly unknownCostDay: string;
}

/** A report for the window: every day but one has its aggregate, and one of them has no cost. */
export function analysis(
  window: { readonly from: string; readonly to: string } = defaultWindow(),
  extra: Partial<AnalysisReport> = {},
): AnalysisFixture {
  const days = trendRows({ groups: [] }, window).map((row) => row.day);
  const gapDay = days[2] ?? window.from;
  const unknownCostDay = days[4] ?? window.from;
  const groups = days
    .filter((day) => day !== gapDay)
    .map((key) => ({
      key,
      summary:
        key === unknownCostDay
          ? summary({
              cost: {
                realUsd: null,
                apiEquivalentUsd: null,
                realPerApprovedDemandUsd: null,
                apiEquivalentPerApprovedDemandUsd: null,
              },
            })
          : summary(),
    }));
  const stat = (count: number, sumMs: number) => ({
    count,
    sumMs,
    p50Ms: sumMs / count,
    p95Ms: sumMs / count,
    maxMs: sumMs / count,
  });
  const report: AnalysisReport = {
    groupBy: 'day',
    readyThrough: window.to,
    period: {
      from: window.from,
      to: window.to,
      scenario: null,
      summary: summary({
        tokens: { input: 150_000, output: 40_000, cached: 9_000 },
        cost: {
          realUsd: 12.5,
          apiEquivalentUsd: 31.75,
          realPerApprovedDemandUsd: null,
          apiEquivalentPerApprovedDemandUsd: null,
        },
        stages: { WRITING: stat(4, 120_000) },
        waits: { quota: stat(2, 30_000) },
      }),
      bottlenecks: [
        { kind: 'stage', name: 'WRITING', count: 4, totalMs: 120_000, p95Ms: 45_000, share: 0.5 },
        { kind: 'stage', name: 'REVIEW', count: 3, totalMs: 65_000, p95Ms: null, share: 0.25 },
        { kind: 'wait', name: 'quota', count: 2, totalMs: 30_000, p95Ms: 20_000, share: 0.125 },
      ],
    },
    groups,
    compare: null,
    missingDays: 1,
    percentilesApproximate: true,
    ...extra,
  };
  return { report, gapDay, unknownCostDay };
}

export function span(id: string, extra: Partial<PlaySpan> = {}): PlaySpan {
  return {
    spanId: id,
    parentSpanId: null,
    kind: 'stage',
    depth: 0,
    label: '',
    detail: null,
    startMs: 1_000,
    durationMs: 1_500,
    status: 'ok',
    attemptId: null,
    ...extra,
  };
}

/** A play with a stage, an attempt, a session and a tool call (the span of the play itself last). */
export function playSpans(extra: Partial<PlaySpans> = {}): PlaySpans {
  return {
    playId: 'P-any',
    spans: [
      span('s-play', { kind: 'play', durationMs: 125_000 }),
      span('s-stage', { parentSpanId: 's-play', depth: 1, label: 'WRITING', durationMs: 62_000 }),
      span('s-attempt', {
        parentSpanId: 's-stage',
        kind: 'attempt',
        depth: 2,
        label: 'author',
        detail: 'fake/one',
        durationMs: 61_000,
      }),
      span('s-tool', {
        parentSpanId: 's-attempt',
        kind: 'tool',
        depth: 3,
        label: 'write_file',
        durationMs: 250,
        status: 'error',
      }),
    ],
    playClosed: true,
    truncated: false,
    ...extra,
  };
}

export function telemetryStatus(extra: Partial<TelemetryStatus> = {}): TelemetryStatus {
  return {
    state: 'on',
    daemonSpans: true,
    receiver: {
      port: 4318,
      accepted: { traces: 12, metrics: 3, logs: 0 },
      rejected: { format: 1, size: 0, token: 2 },
    },
    base: {
      state: 'ok',
      queued: 0,
      written: 345,
      droppedOverflow: 0,
      discarded: 0,
      resets: 0,
      fileBytes: 4096,
    },
    export: {
      mode: 'both',
      otlp: { destination: 'http://127.0.0.1:4317', exported: 77, dropped: { network: 2 } },
      prometheus: true,
    },
    ...extra,
  };
}

export interface PanelsStub {
  /** `id` and the query or params of every read, in order. */
  readonly calls: { id: string; input: unknown }[];
  analysis: () => Promise<AnalysisReport>;
  spans: () => Promise<PlaySpans>;
  telemetry: () => Promise<TelemetryStatus>;
}

export const reads = (stub: Pick<PanelsStub, 'calls'>, id: string): number =>
  stub.calls.filter((call) => call.id === id).length;

/**
 * Answers the three routes of the panels of the client of a fake daemon, and sends every other
 * route to `other` (the totals and the budget of the tab); a route nobody answers is refused.
 */
export function stubPanels(
  fake: FakeOnline,
  other: (route: unknown, input?: { query?: unknown }) => Promise<unknown> | undefined = () =>
    undefined,
  answers: Partial<Pick<PanelsStub, 'analysis' | 'spans' | 'telemetry'>> = {},
): PanelsStub {
  const stub: PanelsStub = {
    calls: [],
    analysis: () => Promise.resolve(analysis().report),
    spans: () => Promise.resolve(playSpans()),
    telemetry: () => Promise.resolve(telemetryStatus()),
    ...answers,
  };
  vi.spyOn(fake.client, 'call').mockImplementation(
    (route: unknown, input?: { query?: unknown; params?: unknown }): Promise<never> => {
      if (route === API_ROUTES.getAnalysis) {
        stub.calls.push({ id: 'getAnalysis', input: input?.query });
        return stub.analysis() as Promise<never>;
      }
      if (route === API_ROUTES.getPlaySpans) {
        stub.calls.push({
          id: 'getPlaySpans',
          input: { params: input?.params, query: input?.query },
        });
        return stub.spans() as Promise<never>;
      }
      if (route === API_ROUTES.getTelemetryStatus) {
        stub.calls.push({ id: 'getTelemetryStatus', input: undefined });
        return stub.telemetry() as Promise<never>;
      }
      return (other(route, input) ??
        Promise.reject(new Error('unexpected route'))) as Promise<never>;
    },
  );
  return stub;
}
