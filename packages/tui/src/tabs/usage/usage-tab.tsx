// SPDX-License-Identifier: MPL-2.0
import {
  formatTokens,
  formatUsd,
  type BudgetView,
  type CapRow,
  type UsageRow,
  type UsageView,
} from '@otheater/client';
import { Box } from 'ink';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../../layout/themed-text.js';
import { keyLabel } from '../../keys/labels.js';
import { useRawKeys, type KeyEvent } from '../../keys/use-keymap.js';
import { fillBar } from '../../layout/scenario-rows.js';
import { Section } from '../../layout/section.js';
import type { TabContentProps, TabDefinition } from '../../layout/tab-types.js';
import { useTabHost } from '../../layout/tab-host.js';
import { cellWidth, fit } from '../../layout/text.js';
import { TOKEN } from '../../layout/theme.js';
import { useStoreValue } from '../../use-store-value.js';
import { DEFAULT_USAGE_SETTINGS, type UsageSectionName } from '../settings.js';
import { followedSubject } from '../trajectories/model.js';
import { formatClock } from '../use-now.js';
import { BottlenecksSection } from './bottlenecks.js';
import { trendWindow } from './panels-model.js';
import { PlaySection, type PlayPanelSubject } from './play-panel.js';
import { TelemetrySection } from './telemetry-panel.js';
import { TrendSection } from './trend.js';
import { usePanels } from './use-panels.js';
import { useUsage } from './use-usage.js';

/** Every section the tab can draw, in the default order (`ui.usage.sections` picks and orders them). */
export const USAGE_SECTIONS = DEFAULT_USAGE_SETTINGS.sections.map(
  (name) => `usage.${name}`,
) as readonly string[];

/** `23/11 14:05`: the moment a cap starts over, in the local time of the terminal. */
function formatMoment(timestamp: number): string {
  const date = new Date(timestamp);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function TotalsLines(props: { readonly usage: UsageView; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { totals } = props.usage;
  return (
    <>
      <Text wrap="truncate">
        {fit(
          t('usage.totals.tokens', {
            turns: totals.turns,
            input: formatTokens(totals.inputTokens),
            output: formatTokens(totals.outputTokens),
            cached: formatTokens(totals.cachedTokens),
          }),
          props.width,
        )}
      </Text>
      <Text wrap="truncate">
        {fit(
          t('usage.totals.money', {
            real: formatUsd(totals.realUsd),
            api: formatUsd(totals.apiEquivalentUsd),
          }),
          props.width,
        )}
      </Text>
      {!totals.complete && (
        <Text color={TOKEN.warn} wrap="truncate">
          {fit(t('usage.totals.incomplete', { count: totals.unknownCostTurns }), props.width)}
        </Text>
      )}
    </>
  );
}

function GroupLine(props: { readonly row: UsageRow; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { row, width } = props;
  const money = `${formatUsd(row.totals.realUsd)}  ≈${formatUsd(row.totals.apiEquivalentUsd)}`;
  return (
    <Text wrap="truncate">
      {fit(row.key ?? t('usage.groups.noKey'), Math.max(1, width - cellWidth(money) - 1))}{' '}
      <Text dimColor>{money}</Text>
    </Text>
  );
}

function CapLines(props: { readonly cap: CapRow; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { cap, width } = props;
  const color = cap.exceeded ? TOKEN.error : cap.percent >= 80 ? TOKEN.warn : TOKEN.ok;
  const name = `${t(`usage.budget.scope.${cap.scope}`)}${cap.id === undefined ? '' : ` ${cap.id}`} · ${t(`usage.budget.period.${cap.period}`)}`;
  const spent = `${formatUsd(cap.spentUsd)} / ${formatUsd(cap.limitUsd)}`;
  const notes: string[] = [];
  if (cap.exceeded) notes.push(t('usage.budget.exceeded'));
  if (cap.blockedByUnknownCost) notes.push(t('usage.budget.blocked'));
  if (cap.endsAt !== undefined)
    notes.push(t('usage.budget.resets', { time: formatMoment(cap.endsAt) }));
  return (
    <>
      <Text wrap="truncate">
        {fit(name, Math.max(1, width - cellWidth(spent) - 1))} {spent}
      </Text>
      <Text wrap="truncate">
        <Text color={color}>{fillBar(Math.max(4, Math.min(20, width - 6)), cap.percent)}</Text>{' '}
        <Text color={color}>{`${String(cap.percent)}%`}</Text>
        {notes.length === 0 ? '' : <Text dimColor>{`  ${notes.join(' · ')}`}</Text>}
      </Text>
    </>
  );
}

function BudgetLines(props: { readonly budget: BudgetView; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { budget, width } = props;
  if (budget.caps.length === 0) {
    return (
      <Text dimColor wrap="truncate">
        {t('usage.budget.empty')}
      </Text>
    );
  }
  return (
    <>
      {budget.caps.map((cap) => (
        <CapLines key={`${cap.scope}/${cap.id ?? ''}/${cap.period}`} cap={cap} width={width} />
      ))}
      {budget.exceeded.map((item) => (
        <Text key={item.profile} color={TOKEN.error} wrap="truncate">
          {fit(
            t('usage.budget.profileExceeded', {
              profile: item.profile,
              time: formatMoment(item.resetsAt),
            }),
            width,
          )}
        </Text>
      ))}
    </>
  );
}

/** The most spans one read of the tree asks for (the rows drawn are `ui.usage.spanRows`). */
const SPAN_READ_LIMIT = 1000;

/** What the section of the play draws about: the play the Trajectories tab follows, by its own rule. */
function usePlaySubject(scenarioId: string | undefined): PlayPanelSubject {
  const { stores, settings } = useTabHost();
  const plays = useStoreValue(stores.plays, (state) => state.byId);
  const direct = useStoreValue(stores.trajectories, (state) => state.direct);
  if (scenarioId === undefined) return { kind: 'none', why: 'noScenario' };
  const subject = followedSubject(plays, direct, scenarioId, settings.trajectories.follow);
  if (subject === undefined) return { kind: 'none', why: 'noPlay' };
  return subject.kind === 'direct'
    ? { kind: 'none', why: 'direct' }
    : { kind: 'play', id: subject.id };
}

function UsageTab(props: TabContentProps): ReactNode {
  const { t } = useTranslation();
  const host = useTabHost();
  const { width, sections, focused } = props;
  const settings = host.settings.usage;
  const wanted = new Set<UsageSectionName>(settings.sections);
  // The totals, the groups and the budget share one read of two routes: with none of the three
  // drawn, it is not made.
  const wantsUsage = wanted.has('totals') || wanted.has('groups') || wanted.has('budget');
  const reader = useUsage(
    wantsUsage ? host.client : undefined,
    settings.groupBy,
    settings.refreshSeconds,
    host.now,
  );
  const subject = usePlaySubject(props.scenarioId);
  const panels = usePanels(
    host.client,
    {
      analysis: wanted.has('trend') || wanted.has('bottlenecks'),
      trendDays: settings.trendDays,
      spansOf: wanted.has('play') && subject.kind === 'play' ? subject.id : undefined,
      spanLimit: SPAN_READ_LIMIT,
      telemetry: wanted.has('telemetry'),
    },
    settings.refreshSeconds,
    host.now,
  );

  useRawKeys(
    (event: KeyEvent) => {
      if (event.combo === undefined) return;
      if (host.keymap.match(event.combo, ['usage']) === 'usage.refresh') {
        reader.refresh();
        panels.refresh();
      }
    },
    { isActive: focused && host.client !== undefined },
  );

  const { load } = reader;
  const shown = load.status === 'ready' ? load : load.status === 'error' ? load.kept : undefined;
  const refreshKey = keyLabel(host.keymap, 'usage.refresh');

  let notice: ReactNode;
  if (host.client === undefined) {
    notice = (
      <Text dimColor wrap="truncate">
        {t('usage.offline')}
      </Text>
    );
  } else if (!wantsUsage) {
    notice =
      refreshKey === undefined ? undefined : (
        <Text dimColor wrap="truncate">
          {t('usage.hint', { key: refreshKey })}
        </Text>
      );
  } else if (load.status === 'loading') {
    notice = (
      <Text dimColor wrap="truncate">
        {t('usage.loading')}
      </Text>
    );
  } else if (load.status === 'error') {
    notice = (
      <Text color={TOKEN.error} wrap="truncate">
        {fit(
          t(`usage.failed.${load.code}`, {
            defaultValue: t('usage.failed.other', { code: load.code }),
          }),
          width,
        )}
      </Text>
    );
  } else if (refreshKey !== undefined) {
    notice = (
      <Text dimColor wrap="truncate">
        {t('usage.hint', { key: refreshKey })}
      </Text>
    );
  }

  const parts: Readonly<Record<UsageSectionName, ReactNode>> = {
    totals: (
      <Section
        id="usage.totals"
        title={t('usage.totals.title')}
        right={
          shown === undefined ? undefined : t('usage.updated', { time: formatClock(shown.at) })
        }
        width={width}
        control={sections}
      >
        {shown === undefined ? (
          <Text dimColor wrap="truncate">
            {t('usage.empty')}
          </Text>
        ) : (
          <TotalsLines usage={shown.usage} width={width} />
        )}
      </Section>
    ),
    groups: (
      <Section
        id="usage.groups"
        title={
          settings.groupBy === 'none'
            ? t('usage.groups.titleNone')
            : t('usage.groups.title', { by: t(`usage.groups.by.${settings.groupBy}`) })
        }
        width={width}
        control={sections}
      >
        {settings.groupBy === 'none' ? (
          <Text dimColor wrap="truncate">
            {t('usage.groups.off')}
          </Text>
        ) : shown === undefined || shown.usage.rows.length === 0 ? (
          <Text dimColor wrap="truncate">
            {t('usage.groups.empty')}
          </Text>
        ) : (
          shown.usage.rows.map((row) => (
            <GroupLine key={row.key ?? '(none)'} row={row} width={width} />
          ))
        )}
      </Section>
    ),
    budget: (
      <Section
        id="usage.budget"
        title={t('usage.budget.title')}
        right={shown?.budget.timezone}
        width={width}
        control={sections}
      >
        {shown === undefined ? (
          <Text dimColor wrap="truncate">
            {t('usage.empty')}
          </Text>
        ) : (
          <BudgetLines budget={shown.budget} width={width} />
        )}
      </Section>
    ),
    trend: (
      <TrendSection
        load={panels.analysis}
        window={trendWindow(host.now(), settings.trendDays)}
        days={settings.trendDays}
        width={width}
        control={sections}
      />
    ),
    bottlenecks: <BottlenecksSection load={panels.analysis} width={width} control={sections} />,
    play: (
      <PlaySection
        subject={subject}
        load={panels.spans}
        rows={settings.spanRows}
        width={width}
        control={sections}
      />
    ),
    telemetry: <TelemetrySection load={panels.telemetry} width={width} control={sections} />,
  };

  return (
    <Box flexDirection="column" width={width}>
      {notice}
      {settings.sections.map((name) => (
        <Fragment key={name}>{parts[name]}</Fragment>
      ))}
    </Box>
  );
}

/**
 * The Usage tab: the totals of `/v1/usage` split by `ui.usage.groupBy`, the caps of `/v1/budget`,
 * and the telemetry panels of Phase 8 (P10): the trend per day, the bottlenecks, the span tree of
 * the followed play and the state of the telemetry. `ui.usage.sections` says which are drawn and in
 * which order, and a section that is left out reads nothing.
 */
export const usageTab: TabDefinition = {
  sections: (context) => context.settings.usage.sections.map((name) => `usage.${name}`),
  render: (props) => <UsageTab {...props} />,
};
