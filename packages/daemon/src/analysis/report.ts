// SPDX-License-Identifier: MPL-2.0
import type { RollupRow } from '@otheater/core';
import type {
  AnalysisBottleneck,
  AnalysisCoverage,
  AnalysisDelta,
  AnalysisGroup,
  AnalysisGroupBy,
  AnalysisStat,
  AnalysisSummary,
} from '@otheater/protocol';
import { ROLLUP_METRIC } from './aggregator.js';

/**
 * The report over the rows of `rollups_daily` (Phase 8, P9). Pure: rows in, figures out.
 *
 * The rows of one metric and facet are joined by adding the counts and the sums; a percentile
 * joined across rows is approximate (the p50 is the mean of the p50s weighted by their counts, the
 * p95 is the greatest p95), and exact when a single row is joined. A figure that no row knew stays
 * `null`: a gap is never a zero.
 */

interface StatAcc {
  count: number;
  sum: number | null;
  weightedP50: number;
  p50Weight: number;
  p95: number | null;
  max: number | null;
  /** Rows with samples that went into it. */
  rows: number;
}

function newStat(): StatAcc {
  return { count: 0, sum: null, weightedP50: 0, p50Weight: 0, p95: null, max: null, rows: 0 };
}

function addToStat(acc: StatAcc, row: RollupRow): void {
  acc.count += row.count;
  if (row.sum !== null) acc.sum = (acc.sum ?? 0) + row.sum;
  if (row.p50 !== null && row.count > 0) {
    acc.weightedP50 += row.p50 * row.count;
    acc.p50Weight += row.count;
  }
  if (row.p95 !== null) acc.p95 = Math.max(acc.p95 ?? 0, row.p95);
  if (row.max !== null) acc.max = Math.max(acc.max ?? 0, row.max);
  if (row.count > 0) acc.rows += 1;
}

function finishStat(acc: StatAcc): AnalysisStat {
  return {
    count: acc.count,
    sumMs: acc.sum,
    p50Ms: acc.p50Weight === 0 ? null : acc.weightedP50 / acc.p50Weight,
    p95Ms: acc.p95,
    maxMs: acc.max,
  };
}

const EMPTY_STAT: AnalysisStat = { count: 0, sumMs: null, p50Ms: null, p95Ms: null, maxMs: null };

/** What a build of a summary also learned, for the report as a whole. */
export interface SummaryBuild {
  readonly summary: AnalysisSummary;
  /** A percentile was joined from more than one row. */
  readonly approximate: boolean;
}

function fraction(part: number, total: number): number | null {
  return total === 0 ? null : part / total;
}

export function buildSummary(rows: readonly RollupRow[]): SummaryBuild {
  const stages = new Map<string, StatAcc>();
  const waits = new Map<string, StatAcc>();
  const attemptDuration = newStat();
  const byEnd: Record<string, number> = {};
  const interruptions: Record<string, number> = {};
  let attemptsTotal = 0;
  let rejections = 0;
  let approved = 0;
  const tokens: Record<'input' | 'output' | 'cached', number | null> = {
    input: null,
    output: null,
    cached: null,
  };
  const cost: Record<'real' | 'api_equivalent', number | null> = {
    real: null,
    api_equivalent: null,
  };
  const counts = {
    coverageTotal: 0,
    coverageClient: 0,
    turns: 0,
    tokensKnown: 0,
    costKnown: 0,
  };
  const origins = new Set<string>();

  const stat = (map: Map<string, StatAcc>, key: string): StatAcc => {
    let acc = map.get(key);
    if (acc === undefined) {
      acc = newStat();
      map.set(key, acc);
    }
    return acc;
  };
  const addTokens = (key: 'input' | 'output' | 'cached', row: RollupRow): void => {
    if (row.sum !== null) tokens[key] = (tokens[key] ?? 0) + row.sum;
  };

  for (const row of rows) {
    origins.add(row.origin);
    switch (row.metric) {
      case ROLLUP_METRIC.stageMs:
        addToStat(stat(stages, row.facet), row);
        break;
      case ROLLUP_METRIC.waitMs:
        addToStat(stat(waits, row.facet), row);
        break;
      case ROLLUP_METRIC.attemptMs:
        addToStat(attemptDuration, row);
        break;
      case ROLLUP_METRIC.attempts:
        attemptsTotal += row.count;
        byEnd[row.facet] = (byEnd[row.facet] ?? 0) + row.count;
        break;
      case ROLLUP_METRIC.rejections:
        rejections += row.count;
        break;
      case ROLLUP_METRIC.interruptions:
        interruptions[row.facet] = (interruptions[row.facet] ?? 0) + row.count;
        break;
      case ROLLUP_METRIC.approvedDemands:
        approved += row.count;
        break;
      case ROLLUP_METRIC.tokensIn:
        addTokens('input', row);
        break;
      case ROLLUP_METRIC.tokensOut:
        addTokens('output', row);
        break;
      case ROLLUP_METRIC.tokensCached:
        addTokens('cached', row);
        break;
      case ROLLUP_METRIC.costUsd:
        if (row.sum !== null && (row.facet === 'real' || row.facet === 'api_equivalent')) {
          cost[row.facet] = (cost[row.facet] ?? 0) + row.sum;
        }
        break;
      case ROLLUP_METRIC.usageTurns:
        if (row.facet === 'total') counts.turns += row.count;
        else if (row.facet === 'tokens_known') counts.tokensKnown += row.count;
        else if (row.facet === 'cost_known') counts.costKnown += row.count;
        break;
      case ROLLUP_METRIC.coverageAttempts:
        if (row.facet === 'total') counts.coverageTotal += row.count;
        else if (row.facet === 'with_client_telemetry') counts.coverageClient += row.count;
        break;
      default:
        break;
    }
  }

  const per = (usd: number | null): number | null =>
    usd === null || approved === 0 ? null : usd / approved;
  const coverage: AnalysisCoverage = {
    attempts: counts.coverageTotal,
    attemptsWithClientTelemetry: counts.coverageClient,
    attemptCoverage: fraction(counts.coverageClient, counts.coverageTotal),
    usageTurns: counts.turns,
    usageTurnsWithTokens: counts.tokensKnown,
    tokenCoverage: fraction(counts.tokensKnown, counts.turns),
    usageTurnsWithCost: counts.costKnown,
    costCoverage: fraction(counts.costKnown, counts.turns),
    origins: [...origins].sort(),
  };
  const finishAll = (map: Map<string, StatAcc>): Record<string, AnalysisStat> =>
    Object.fromEntries(
      [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, finishStat(v)]),
    );
  const approximate = [...stages.values(), ...waits.values(), attemptDuration].some(
    (acc) => acc.rows > 1,
  );
  return {
    approximate,
    summary: {
      attempts: {
        total: attemptsTotal,
        byEnd: sortKeys(byEnd),
        duration:
          attemptDuration.count === 0 && attemptDuration.rows === 0
            ? EMPTY_STAT
            : finishStat(attemptDuration),
      },
      rejections,
      interruptions: sortKeys(interruptions),
      approvedDemands: approved,
      stages: finishAll(stages),
      waits: finishAll(waits),
      tokens,
      cost: {
        realUsd: cost.real,
        apiEquivalentUsd: cost.api_equivalent,
        realPerApprovedDemandUsd: per(cost.real),
        apiEquivalentPerApprovedDemandUsd: per(cost.api_equivalent),
      },
      coverage,
    },
  };
}

function sortKeys(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The key of a row in a grouping. */
function groupKey(groupBy: AnalysisGroupBy, row: RollupRow): string {
  switch (groupBy) {
    case 'day':
      return row.day;
    case 'scenario':
      return row.scenarioId;
    case 'executor':
      return row.executor;
    case 'role':
      return row.role;
  }
}

export function buildGroups(
  rows: readonly RollupRow[],
  groupBy: AnalysisGroupBy,
): { groups: AnalysisGroup[]; approximate: boolean } {
  const buckets = new Map<string, RollupRow[]>();
  for (const row of rows) {
    const key = groupKey(groupBy, row);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }
  let approximate = false;
  const groups = [...buckets]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, bucket]) => {
      const built = buildSummary(bucket);
      approximate ||= built.approximate;
      return { key, summary: built.summary };
    });
  return { groups, approximate };
}

/**
 * Where the time goes: the states and the waits of the period by total time. The wait for the
 * Producer is left out (its time is already in the state it comes from), and the waits overlap the
 * states they happen in, so `share` is the share of the sum of the times listed, not of the clock.
 */
export function buildBottlenecks(summary: AnalysisSummary, top: number): AnalysisBottleneck[] {
  const candidates: Omit<AnalysisBottleneck, 'share'>[] = [];
  for (const [name, stat] of Object.entries(summary.stages)) {
    if (stat.sumMs !== null) {
      candidates.push({
        kind: 'stage',
        name,
        count: stat.count,
        totalMs: stat.sumMs,
        p95Ms: stat.p95Ms,
      });
    }
  }
  for (const [name, stat] of Object.entries(summary.waits)) {
    if (name !== 'producer' && stat.sumMs !== null) {
      candidates.push({
        kind: 'wait',
        name,
        count: stat.count,
        totalMs: stat.sumMs,
        p95Ms: stat.p95Ms,
      });
    }
  }
  const total = candidates.reduce((acc, c) => acc + c.totalMs, 0);
  return candidates
    .sort((a, b) => b.totalMs - a.totalMs || (a.kind + a.name < b.kind + b.name ? -1 : 1))
    .slice(0, top)
    .map((c) => ({ ...c, share: total === 0 ? 0 : c.totalMs / total }));
}

function delta(metric: string, base: number | null, other: number | null): AnalysisDelta {
  const d = base === null || other === null ? null : other - base;
  return {
    metric,
    base,
    other,
    delta: d,
    ratio: d === null || base === null || base === 0 ? null : d / base,
  };
}

/** The changes from `base` to `other`, figure by figure. */
export function compareSummaries(base: AnalysisSummary, other: AnalysisSummary): AnalysisDelta[] {
  const out: AnalysisDelta[] = [
    delta('attempts', base.attempts.total, other.attempts.total),
    delta('attempt.p50Ms', base.attempts.duration.p50Ms, other.attempts.duration.p50Ms),
    delta('attempt.p95Ms', base.attempts.duration.p95Ms, other.attempts.duration.p95Ms),
    delta('rejections', base.rejections, other.rejections),
    delta('approvedDemands', base.approvedDemands, other.approvedDemands),
    delta('interruptions', sum(base.interruptions), sum(other.interruptions)),
  ];
  for (const state of union(base.stages, other.stages)) {
    out.push(
      delta(
        `stage.${state}.sumMs`,
        base.stages[state]?.sumMs ?? null,
        other.stages[state]?.sumMs ?? null,
      ),
    );
  }
  for (const kind of union(base.waits, other.waits)) {
    out.push(
      delta(
        `wait.${kind}.sumMs`,
        base.waits[kind]?.sumMs ?? null,
        other.waits[kind]?.sumMs ?? null,
      ),
    );
  }
  out.push(
    delta('tokens.input', base.tokens.input, other.tokens.input),
    delta('tokens.output', base.tokens.output, other.tokens.output),
    delta('cost.realUsd', base.cost.realUsd, other.cost.realUsd),
    delta('cost.apiEquivalentUsd', base.cost.apiEquivalentUsd, other.cost.apiEquivalentUsd),
    delta(
      'cost.realPerApprovedDemandUsd',
      base.cost.realPerApprovedDemandUsd,
      other.cost.realPerApprovedDemandUsd,
    ),
    delta('coverage.attempts', base.coverage.attemptCoverage, other.coverage.attemptCoverage),
    delta('coverage.tokens', base.coverage.tokenCoverage, other.coverage.tokenCoverage),
  );
  return out;
}

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

function union(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}
