// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The analysis of the system (Phase 8, P9; architecture 5.11, N55 and N217). [proposta] One read
 * over the daily aggregates (`rollups_daily` of the telemetry base): where the time of the plays
 * goes, what is waited for, what the attempts cost, and how much of that is known (the coverage).
 * It never reads the raw telemetry, so it still answers after the raw records were purged.
 *
 * The days are the days of the daemon (`analysis.day_boundary`), written `YYYY-MM-DD`. The report
 * only holds the days the aggregation has closed (`readyThrough`); today is not in it.
 */

/** A day, `YYYY-MM-DD`. */
export const AnalysisDaySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);

/** How the groups of the report are cut. */
export const ANALYSIS_GROUP_BY = ['day', 'scenario', 'executor', 'role'] as const;
export type AnalysisGroupBy = (typeof ANALYSIS_GROUP_BY)[number];

/** What a duration is made of; every figure is in milliseconds. `null`: no sample knew it. */
export const AnalysisStatSchema = z.strictObject({
  count: z.int().min(0),
  sumMs: z.number().min(0).nullable(),
  p50Ms: z.number().min(0).nullable(),
  p95Ms: z.number().min(0).nullable(),
  maxMs: z.number().min(0).nullable(),
});
export type AnalysisStat = z.infer<typeof AnalysisStatSchema>;

/** How much of the picture is known. A fraction is `null` when there is nothing to divide. */
export const AnalysisCoverageSchema = z.strictObject({
  attempts: z.int().min(0),
  /** Attempts with at least one record of the client itself (OTLP) in the base. */
  attemptsWithClientTelemetry: z.int().min(0),
  attemptCoverage: z.number().min(0).max(1).nullable(),
  usageTurns: z.int().min(0),
  usageTurnsWithTokens: z.int().min(0),
  tokenCoverage: z.number().min(0).max(1).nullable(),
  usageTurnsWithCost: z.int().min(0),
  costCoverage: z.number().min(0).max(1).nullable(),
  /** Where the numbers came from: `daemon`, `client`, `otlp`, `pricing_table`. */
  origins: z.array(z.string()),
});
export type AnalysisCoverage = z.infer<typeof AnalysisCoverageSchema>;

const nullableNumber = z.number().min(0).nullable();

/** The figures of one group (or of the whole period). */
export const AnalysisSummarySchema = z.strictObject({
  attempts: z.strictObject({
    total: z.int().min(0),
    /** By how the attempt ended (`submitted`, `cancelled`, `aborted`, `unknown`). */
    byEnd: z.record(z.string(), z.int().min(0)),
    duration: AnalysisStatSchema,
  }),
  /** The times a review sent the play back (a plan, a script or a critique that did not approve). */
  rejections: z.int().min(0),
  /** The interruptions of the sessions by cause. */
  interruptions: z.record(z.string(), z.int().min(0)),
  approvedDemands: z.int().min(0),
  /** The time in each state of the play, by state. */
  stages: z.record(z.string(), AnalysisStatSchema),
  /** The waits by kind: `quota`, `prompt_queue`, `pool_admission`, `tool_semaphore`, `executor_selection`, `producer`. */
  waits: z.record(z.string(), AnalysisStatSchema),
  /** `null` when no turn reported it: a gap, never a zero. */
  tokens: z.strictObject({
    input: nullableNumber,
    output: nullableNumber,
    cached: nullableNumber,
  }),
  cost: z.strictObject({
    /** What the account was charged. */
    realUsd: nullableNumber,
    /** What the tokens would cost by API. */
    apiEquivalentUsd: nullableNumber,
    /** The costs above divided by the approved demands; `null` when either is unknown or there is none. */
    realPerApprovedDemandUsd: nullableNumber,
    apiEquivalentPerApprovedDemandUsd: nullableNumber,
  }),
  coverage: AnalysisCoverageSchema,
});
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;

export const AnalysisGroupSchema = z.strictObject({
  /** The day, scenario, Executor (`client/profile`) or role; the empty string where it was not known. */
  key: z.string(),
  summary: AnalysisSummarySchema,
});
export type AnalysisGroup = z.infer<typeof AnalysisGroupSchema>;

/** Where the time goes: the biggest states and waits of the period, by total time. */
export const AnalysisBottleneckSchema = z.strictObject({
  kind: z.enum(['stage', 'wait']),
  /** The state of the play, or the kind of wait. */
  name: z.string(),
  count: z.int().min(0),
  totalMs: z.number().min(0),
  p95Ms: nullableNumber,
  /** The share of the sum of the times of the states and waits listed (they overlap), 0 to 1. */
  share: z.number().min(0).max(1),
});
export type AnalysisBottleneck = z.infer<typeof AnalysisBottleneckSchema>;

export const AnalysisPeriodSchema = z.strictObject({
  from: AnalysisDaySchema,
  to: AnalysisDaySchema,
  /** `null`: every scenario. */
  scenario: z.string().nullable(),
  summary: AnalysisSummarySchema,
  bottlenecks: z.array(AnalysisBottleneckSchema),
});
export type AnalysisPeriod = z.infer<typeof AnalysisPeriodSchema>;

/** One figure of the comparison: the value in each period and the change. */
export const AnalysisDeltaSchema = z.strictObject({
  metric: z.string(),
  base: z.number().nullable(),
  other: z.number().nullable(),
  /** `other - base`; `null` when either is unknown. */
  delta: z.number().nullable(),
  /** `delta / base`; `null` when either is unknown or the base is zero. */
  ratio: z.number().nullable(),
});
export type AnalysisDelta = z.infer<typeof AnalysisDeltaSchema>;

export const AnalysisReportSchema = z.strictObject({
  groupBy: z.enum(ANALYSIS_GROUP_BY),
  /** The last day the aggregates are ready for; `null` before the first one. */
  readyThrough: AnalysisDaySchema.nullable(),
  /** The period and its whole summary. */
  period: AnalysisPeriodSchema,
  groups: z.array(AnalysisGroupSchema),
  /** The second period or scenario, when asked for, with the changes against `period`. */
  compare: z
    .strictObject({
      period: AnalysisPeriodSchema,
      deltas: z.array(AnalysisDeltaSchema),
    })
    .nullable(),
  /** The days of the period the aggregates do not hold (not closed yet, purged, or with nothing in them). */
  missingDays: z.int().min(0),
  /**
   * True when a percentile was joined from more than one aggregate row (days, scenarios,
   * Executors, roles): the p50 is the mean of the rows weighted by their counts, the p95 is the
   * greatest of the rows. Exact when a single row is read.
   */
  percentilesApproximate: z.boolean(),
});
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

export const GetAnalysisQuerySchema = z.strictObject({
  /** First day, `YYYY-MM-DD` (default: `analysis.report.default_days` days before `to`). */
  from: AnalysisDaySchema.optional(),
  /** Last day (default: the last day ready). */
  to: AnalysisDaySchema.optional(),
  groupBy: z.enum(ANALYSIS_GROUP_BY).optional(),
  /** Only this scenario. */
  scenario: z.string().min(1).max(256).optional(),
  /** Compare with this other period (both or none of the two). */
  compareFrom: AnalysisDaySchema.optional(),
  compareTo: AnalysisDaySchema.optional(),
  /** Compare with this other scenario over the same days (needs `scenario`). */
  compareScenario: z.string().min(1).max(256).optional(),
});
export type GetAnalysisQuery = z.input<typeof GetAnalysisQuerySchema>;

export const getAnalysis = defineRoute({
  id: 'getAnalysis',
  method: 'GET',
  path: '/v1/analysis',
  summary:
    'The analysis of the system over the daily aggregates: times, waits, cost, coverage, bottlenecks, and a comparison between two periods or two scenarios',
  query: GetAnalysisQuerySchema,
  response: AnalysisReportSchema,
  errors: ['unavailable'],
});

export const ANALYSIS_ROUTES = defineRoutes(getAnalysis);
