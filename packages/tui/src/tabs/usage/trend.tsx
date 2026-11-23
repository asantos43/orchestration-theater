// SPDX-License-Identifier: MPL-2.0
import { formatTokens, formatUsd } from '@otheater/client';
import type { AnalysisReport, AnalysisSummary } from '@otheater/protocol';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../../layout/themed-text.js';
import { Section, type SectionControl } from '../../layout/section.js';
import { fit } from '../../layout/text.js';
import { TOKEN } from '../../layout/theme.js';
import { formatClock } from '../use-now.js';
import { formatFraction, GAP, trendRows } from './panels-model.js';
import { shownOf, SourceNotice } from './source-notice.js';
import type { SourceLoad } from './use-panels.js';

/**
 * The trend of the Usage tab (Phase 8, P10; architecture 5.13): tokens, real cost and cost in API
 * equivalent per day, from the daily aggregates (`GET /v1/analysis`, by day). A day the aggregates
 * do not hold is a line that says so, and a figure no turn reported is a dash: never a zero.
 */

function tokensOf(value: number | null): string {
  return value === null ? GAP : formatTokens(value);
}

function usdOf(value: number | null): string {
  return value === null ? GAP : formatUsd(value);
}

function figures(
  t: (key: string, options: Record<string, string>) => string,
  summary: AnalysisSummary,
): string {
  return t('usage.trend.figures', {
    input: tokensOf(summary.tokens.input),
    output: tokensOf(summary.tokens.output),
    real: usdOf(summary.cost.realUsd),
    api: usdOf(summary.cost.apiEquivalentUsd),
  });
}

export function TrendSection(props: {
  readonly load: SourceLoad<AnalysisReport>;
  readonly window: { readonly from: string; readonly to: string };
  /** How many days the window has (`ui.usage.trendDays`). */
  readonly days: number;
  readonly width: number;
  readonly control: SectionControl;
}): ReactNode {
  const { t } = useTranslation();
  const { load, width } = props;
  const shown = shownOf(load);
  const report = shown?.value;
  const tr = (key: string, options: Record<string, string>): string => t(key, options);
  return (
    <Section
      id="usage.trend"
      title={t('usage.trend.title', { days: props.days })}
      right={shown === undefined ? undefined : t('usage.updated', { time: formatClock(shown.at) })}
      width={width}
      control={props.control}
    >
      <SourceNotice load={load} width={width} />
      {report === undefined ? null : report.readyThrough === null ? (
        <Text dimColor wrap="truncate">
          {t('usage.trend.noneReady')}
        </Text>
      ) : (
        <>
          <Text dimColor wrap="truncate">
            {fit(t('usage.trend.legend'), width)}
          </Text>
          {trendRows(report, props.window).map((row) =>
            row.group === undefined ? (
              <Text key={row.day} dimColor wrap="truncate">
                {fit(t('usage.trend.gapDay', { day: row.day }), width)}
              </Text>
            ) : (
              <Text key={row.day} wrap="truncate">
                {fit(
                  t('usage.trend.row', { day: row.day, figures: figures(tr, row.group.summary) }),
                  width,
                )}
              </Text>
            ),
          )}
          <Text wrap="truncate" bold>
            {fit(t('usage.trend.total', { figures: figures(tr, report.period.summary) }), width)}
          </Text>
          <Text dimColor wrap="truncate">
            {fit(
              t('usage.trend.coverage', {
                tokens: formatFraction(report.period.summary.coverage.tokenCoverage),
                cost: formatFraction(report.period.summary.coverage.costCoverage),
                through: report.readyThrough,
              }),
              width,
            )}
          </Text>
          {report.missingDays > 0 && (
            <Text color={TOKEN.warn} wrap="truncate">
              {fit(t('usage.trend.missing', { count: report.missingDays }), width)}
            </Text>
          )}
        </>
      )}
    </Section>
  );
}
