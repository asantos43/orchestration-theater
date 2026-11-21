// SPDX-License-Identifier: MPL-2.0
import {
  formatTokens,
  formatUsd,
  type BudgetView,
  type CapRow,
  type UsageRow,
  type UsageView,
} from '@otheater/client';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { keyLabel } from '../../keys/labels.js';
import { useRawKeys, type KeyEvent } from '../../keys/use-keymap.js';
import { fillBar } from '../../layout/scenario-rows.js';
import { Section } from '../../layout/section.js';
import type { TabContentProps, TabDefinition } from '../../layout/tab-types.js';
import { useTabHost } from '../../layout/tab-host.js';
import { cellWidth, fit } from '../../layout/text.js';
import { COLOR } from '../../layout/theme.js';
import { formatClock } from '../use-now.js';
import { useUsage } from './use-usage.js';

/** The ids of the sections, top to bottom. */
export const USAGE_SECTIONS = ['usage.totals', 'usage.groups', 'usage.budget'] as const;

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
        <Text color={COLOR.warn} wrap="truncate">
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
  const color = cap.exceeded ? COLOR.error : cap.percent >= 80 ? COLOR.warn : COLOR.ok;
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
        <Text key={item.profile} color={COLOR.error} wrap="truncate">
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

function UsageTab(props: TabContentProps): ReactNode {
  const { t } = useTranslation();
  const host = useTabHost();
  const { width, sections, focused } = props;
  const settings = host.settings.usage;
  const reader = useUsage(host.client, settings.groupBy, settings.refreshSeconds, host.now);

  useRawKeys(
    (event: KeyEvent) => {
      if (event.combo === undefined) return;
      if (host.keymap.match(event.combo, ['global', 'panel']) === 'usage.refresh') reader.refresh();
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
  } else if (load.status === 'loading') {
    notice = (
      <Text dimColor wrap="truncate">
        {t('usage.loading')}
      </Text>
    );
  } else if (load.status === 'error') {
    notice = (
      <Text color={COLOR.error} wrap="truncate">
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

  return (
    <Box flexDirection="column" width={width}>
      {notice}
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
    </Box>
  );
}

/** The Usage tab: the totals of `/v1/usage` split by `ui.usage.groupBy`, and the caps of `/v1/budget`. */
export const usageTab: TabDefinition = {
  sections: USAGE_SECTIONS,
  render: (props) => <UsageTab {...props} />,
};
