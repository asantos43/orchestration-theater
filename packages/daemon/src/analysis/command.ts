// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode, InvalidInput } from '@otheater/core';
import {
  ANALYSIS_GROUP_BY,
  API_ROUTES,
  AnalysisDaySchema,
  AnalysisReportSchema,
  type AnalysisGroupBy,
  type AnalysisReport,
  type AnalysisStat,
  type AnalysisSummary,
  type GetAnalysisQuery,
} from '@otheater/protocol';
import { readApiToken, readDiscovery } from '../api/files.js';
import type { ApiFetch } from '../commands-api.js';
import { compose } from '../compose.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';
import { loadConfig } from '../config.js';
import { InstanceLock, releaseOnFailure } from '../instance-lock.js';
import { dataPaths, ensureDataDir } from '../paths.js';
import { AnalysisService } from './analysis-service.js';

/** The options of `ot analysis` (every period default comes from `analysis.report.*`). */
export interface AnalysisOptions {
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly groupBy: string | undefined;
  readonly scenario: string | undefined;
  readonly compareFrom: string | undefined;
  readonly compareTo: string | undefined;
  readonly compareScenario: string | undefined;
  readonly json: boolean;
}

export interface AnalysisDeps {
  readonly fetch?: ApiFetch | undefined;
}

/**
 * `ot analysis` (Phase 8, P9; N55 and N217). [proposta] Two paths, decided by the instance lock, as
 * `ot trajectory export`:
 * - daemon running: the report is asked of it (`GET /v1/analysis`, authenticated with the token of
 *   `api-token`);
 * - no daemon: this process takes the lock, builds the days still missing (`analysis.schedule`
 *   does not matter here: the days are closed) and reads the report with the same service.
 * The text is for people; `--json` prints the report as the route gives it.
 */
export async function runAnalysisCommand(
  context: CommandContext,
  deps: AnalysisDeps,
  options: AnalysisOptions,
): Promise<number> {
  const { t } = context;
  const usage = (message: string): number => {
    context.err(message);
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };
  // The options are checked before the data folder is touched.
  for (const [flag, value] of [
    ['--from', options.from],
    ['--to', options.to],
    ['--compare-from', options.compareFrom],
    ['--compare-to', options.compareTo],
  ] as const) {
    if (value !== undefined && !AnalysisDaySchema.safeParse(value).success) {
      return usage(t('usage.analysisDay', { flag }));
    }
  }
  if (options.groupBy !== undefined && !isGroupBy(options.groupBy)) {
    return usage(t('usage.analysisGroupBy', { values: ANALYSIS_GROUP_BY.join(', ') }));
  }
  if ((options.compareFrom === undefined) !== (options.compareTo === undefined)) {
    return usage(t('usage.analysisComparePair'));
  }
  if (options.compareScenario !== undefined && options.scenario === undefined) {
    return usage(t('usage.analysisCompareScenario'));
  }
  if (options.compareScenario !== undefined && options.compareFrom !== undefined) {
    return usage(t('usage.analysisCompareOne'));
  }
  const query: GetAnalysisQuery = {
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    ...(options.groupBy === undefined || !isGroupBy(options.groupBy)
      ? {}
      : { groupBy: options.groupBy }),
    ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
    ...(options.compareFrom === undefined ? {} : { compareFrom: options.compareFrom }),
    ...(options.compareTo === undefined ? {} : { compareTo: options.compareTo }),
    ...(options.compareScenario === undefined ? {} : { compareScenario: options.compareScenario }),
  };

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);

  let lock: InstanceLock | undefined;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (!hasErrorCode(error, 'CONFLICT')) throw error;
  }

  if (lock !== undefined) {
    const held = lock;
    const composition = await releaseOnFailure(held, () =>
      compose(config, {
        dataDir: paths.dataDir,
        ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
      }),
    );
    try {
      if (composition.telemetry === undefined) {
        context.err(t('analysis.noTelemetry'));
        return EXIT_FAILED;
      }
      const service = new AnalysisService({
        clock: composition.clock,
        telemetry: composition.telemetry,
        events: composition.store.events,
        usage: composition.store.usage,
        settings: () => config.analysis,
        situations: composition.situations,
        logger: composition.logger,
      });
      try {
        await service.catchUp();
        return print(context, await service.report(query), options.json);
      } catch (error) {
        if (error instanceof InvalidInput) return usage(error.message);
        throw error;
      } finally {
        await composition.situations.idle().catch(() => undefined);
      }
    } finally {
      await composition.close().catch(() => undefined);
      await held.release();
    }
  }

  // A daemon holds the data folder: ask it.
  const discovery = await readDiscovery(paths.apiDiscovery);
  if (discovery.kind !== 'live') {
    context.err(t('api.noApi'));
    return EXIT_FAILED;
  }
  const token = await readApiToken(paths.apiToken);
  if (token === undefined) {
    context.err(t('analysis.noToken'));
    return EXIT_FAILED;
  }
  const route = API_ROUTES.getAnalysis;
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  ).toString();
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(
      `${discovery.info.url}${route.path}${search === '' ? '' : `?${search}`}`,
      { method: route.method, headers: { authorization: `Bearer ${token}` } },
    );
  } catch {
    context.err(t('api.unreachable', { url: discovery.info.url }));
    return EXIT_FAILED;
  }
  if (response.status === 401 || response.status === 403) {
    context.err(t('api.rejected', { status: response.status }));
    return EXIT_FAILED;
  }
  if (response.status === 400) return usage(t('analysis.badRequest'));
  if (response.status === 503) {
    context.err(t('analysis.noTelemetry'));
    return EXIT_FAILED;
  }
  if (!response.ok) {
    context.err(t('analysis.failedOnline', { status: response.status }));
    return EXIT_FAILED;
  }
  const parsed = AnalysisReportSchema.safeParse(await response.json());
  if (!parsed.success) {
    context.err(t('analysis.failedOnline', { status: response.status }));
    return EXIT_FAILED;
  }
  return print(context, parsed.data, options.json);
}

function isGroupBy(value: string): value is AnalysisGroupBy {
  return (ANALYSIS_GROUP_BY as readonly string[]).includes(value);
}

function print(context: CommandContext, report: AnalysisReport, json: boolean): number {
  if (json) {
    context.out(JSON.stringify(report, null, 2));
    return EXIT_OK;
  }
  for (const line of reportLines(context, report)) context.out(line);
  return EXIT_OK;
}

/** A duration in milliseconds as `850ms`, `12.5s`, `3m05s` or `2h10m`; a gap is `n/a`. */
export function formatDuration(ms: number | null, gap: string): string {
  if (ms === null) return gap;
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${String(minutes)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function percent(fraction: number | null, gap: string): string {
  return fraction === null ? gap : `${String(Math.round(fraction * 100))}%`;
}

function usd(value: number | null, gap: string): string {
  return value === null ? gap : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function count(value: number | null, gap: string): string {
  return value === null ? gap : String(Math.round(value));
}

function reportLines(context: CommandContext, report: AnalysisReport): string[] {
  const { t } = context;
  const gap = t('analysis.gap');
  const lines: string[] = [];
  const { period } = report;
  lines.push(
    t('analysis.title', {
      from: period.from,
      to: period.to,
      scenario: period.scenario ?? t('analysis.allScenarios'),
    }),
  );
  lines.push(
    t('analysis.ready', { through: report.readyThrough ?? gap, missing: report.missingDays }),
  );
  lines.push(...summaryLines(context, period.summary, gap));

  if (period.bottlenecks.length > 0) {
    lines.push('', t('analysis.bottlenecks'));
    period.bottlenecks.forEach((b, index) => {
      lines.push(
        t('analysis.bottleneck', {
          rank: index + 1,
          kind: t(`analysis.kind.${b.kind}`),
          name: b.name,
          total: formatDuration(b.totalMs, gap),
          p95: formatDuration(b.p95Ms, gap),
          count: b.count,
          share: percent(b.share, gap),
        }),
      );
    });
  }

  if (report.groups.length > 0) {
    lines.push('', t('analysis.groups', { groupBy: t(`analysis.groupBy.${report.groupBy}`) }));
    for (const group of report.groups) {
      const s = group.summary;
      lines.push(
        t('analysis.group', {
          key: group.key === '' ? gap : group.key,
          attempts: s.attempts.total,
          rejections: s.rejections,
          demands: s.approvedDemands,
          time: formatDuration(s.attempts.duration.sumMs, gap),
          cost: usd(s.cost.realUsd, gap),
          coverage: percent(s.coverage.attemptCoverage, gap),
        }),
      );
    }
  }

  if (report.compare !== null) {
    const other = report.compare.period;
    lines.push(
      '',
      t('analysis.compare', {
        from: other.from,
        to: other.to,
        scenario: other.scenario ?? t('analysis.allScenarios'),
      }),
    );
    for (const delta of report.compare.deltas) {
      lines.push(
        t('analysis.delta', {
          metric: delta.metric,
          base: formatMetric(delta.metric, delta.base, gap),
          other: formatMetric(delta.metric, delta.other, gap),
          change:
            delta.ratio === null
              ? gap
              : `${delta.ratio >= 0 ? '+' : ''}${(delta.ratio * 100).toFixed(0)}%`,
        }),
      );
    }
  }
  if (report.percentilesApproximate) lines.push('', t('analysis.approximate'));
  return lines;
}

function formatMetric(metric: string, value: number | null, gap: string): string {
  if (value === null) return gap;
  if (metric.startsWith('coverage.')) return percent(value, gap);
  if (metric.endsWith('Ms')) return formatDuration(value, gap);
  if (metric.toLowerCase().includes('usd')) return usd(value, gap);
  return count(value, gap);
}

function statText(stat: AnalysisStat | undefined, gap: string): string {
  if (stat === undefined || stat.count === 0) return gap;
  return `${formatDuration(stat.sumMs, gap)} (p50 ${formatDuration(stat.p50Ms, gap)}, p95 ${formatDuration(stat.p95Ms, gap)}, n=${String(stat.count)})`;
}

function summaryLines(context: CommandContext, s: AnalysisSummary, gap: string): string[] {
  const { t } = context;
  const lines: string[] = [];
  const ends = Object.entries(s.attempts.byEnd)
    .map(([end, n]) => `${end} ${String(n)}`)
    .join(', ');
  lines.push(
    t('analysis.attempts', {
      total: s.attempts.total,
      ends: ends === '' ? gap : ends,
      duration: statText(s.attempts.duration, gap),
    }),
  );
  const interruptions = Object.entries(s.interruptions)
    .map(([cause, n]) => `${cause} ${String(n)}`)
    .join(', ');
  lines.push(
    t('analysis.rejections', {
      rejections: s.rejections,
      demands: s.approvedDemands,
      interruptions: interruptions === '' ? gap : interruptions,
    }),
  );
  for (const [state, stat] of Object.entries(s.stages)) {
    lines.push(t('analysis.stage', { state, stat: statText(stat, gap) }));
  }
  for (const [kind, stat] of Object.entries(s.waits)) {
    lines.push(t('analysis.wait', { kind, stat: statText(stat, gap) }));
  }
  lines.push(
    t('analysis.tokens', {
      input: count(s.tokens.input, gap),
      output: count(s.tokens.output, gap),
      cached: count(s.tokens.cached, gap),
    }),
    t('analysis.cost', {
      real: usd(s.cost.realUsd, gap),
      equivalent: usd(s.cost.apiEquivalentUsd, gap),
      perDemand: usd(s.cost.realPerApprovedDemandUsd, gap),
      perDemandEquivalent: usd(s.cost.apiEquivalentPerApprovedDemandUsd, gap),
    }),
  );
  const c = s.coverage;
  lines.push(
    t('analysis.coverage', {
      withClient: c.attemptsWithClientTelemetry,
      attempts: c.attempts,
      attemptCoverage: percent(c.attemptCoverage, gap),
      tokenCoverage: percent(c.tokenCoverage, gap),
      costCoverage: percent(c.costCoverage, gap),
      origins: c.origins.length === 0 ? gap : c.origins.join(', '),
    }),
  );
  return lines;
}
