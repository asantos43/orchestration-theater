// SPDX-License-Identifier: MPL-2.0
import type { AnalysisBottleneck, AnalysisReport } from '@otheater/protocol';
import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Section, type SectionControl } from '../../layout/section.js';
import { fit } from '../../layout/text.js';
import { COLOR } from '../../layout/theme.js';
import { formatDuration, formatFraction, formatMaybeDuration } from './panels-model.js';
import { shownOf, SourceNotice } from './source-notice.js';
import type { SourceLoad } from './use-panels.js';

/** How many states and how many waits the section lists. */
export const BOTTLENECK_ROWS = 5;

/**
 * The bottlenecks of the Usage tab (Phase 8, P10; architecture 5.13): where the time of the plays
 * went in the period, by state and by kind of wait (`period.bottlenecks` of `GET /v1/analysis`),
 * with how much of the picture is known and where the numbers came from. A time no span measured
 * is a dash; a coverage nobody could compute is a dash too.
 */

function Row(props: { readonly row: AnalysisBottleneck; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { row, width } = props;
  return (
    <Text wrap="truncate">
      {fit(
        t('usage.bottlenecks.row', {
          name: row.name,
          total: formatDuration(row.totalMs),
          count: row.count,
          p95: formatMaybeDuration(row.p95Ms),
          share: formatFraction(row.share),
        }),
        width,
      )}
    </Text>
  );
}

export function BottlenecksSection(props: {
  readonly load: SourceLoad<AnalysisReport>;
  readonly width: number;
  readonly control: SectionControl;
}): ReactNode {
  const { t } = useTranslation();
  const { load, width } = props;
  const shown = shownOf(load);
  const report = shown?.value;
  const stages = report?.period.bottlenecks.filter((row) => row.kind === 'stage') ?? [];
  const waits = report?.period.bottlenecks.filter((row) => row.kind === 'wait') ?? [];
  const coverage = report?.period.summary.coverage;
  return (
    <Section
      id="usage.bottlenecks"
      title={t('usage.bottlenecks.title')}
      right={report === undefined ? undefined : `${report.period.from} → ${report.period.to}`}
      width={width}
      control={props.control}
    >
      <SourceNotice load={load} width={width} />
      {report === undefined || coverage === undefined ? null : (
        <>
          <Text dimColor wrap="truncate">
            {t('usage.bottlenecks.stages')}
          </Text>
          {stages.length === 0 ? (
            <Text dimColor wrap="truncate">
              {t('usage.bottlenecks.none')}
            </Text>
          ) : (
            stages
              .slice(0, BOTTLENECK_ROWS)
              .map((row) => <Row key={`stage/${row.name}`} row={row} width={width} />)
          )}
          <Text dimColor wrap="truncate">
            {t('usage.bottlenecks.waits')}
          </Text>
          {waits.length === 0 ? (
            <Text dimColor wrap="truncate">
              {t('usage.bottlenecks.none')}
            </Text>
          ) : (
            waits
              .slice(0, BOTTLENECK_ROWS)
              .map((row) => <Row key={`wait/${row.name}`} row={row} width={width} />)
          )}
          <Text dimColor wrap="truncate">
            {fit(
              t('usage.bottlenecks.coverage', {
                attempts: formatFraction(coverage.attemptCoverage),
                tokens: formatFraction(coverage.tokenCoverage),
                cost: formatFraction(coverage.costCoverage),
              }),
              width,
            )}
          </Text>
          <Text dimColor wrap="truncate">
            {fit(
              t('usage.bottlenecks.origin', {
                origins: coverage.origins.length === 0 ? '—' : coverage.origins.join(', '),
              }),
              width,
            )}
          </Text>
          {report.percentilesApproximate && (
            <Text color={COLOR.warn} wrap="truncate">
              {fit(t('usage.bottlenecks.approximate'), width)}
            </Text>
          )}
        </>
      )}
    </Section>
  );
}
