// SPDX-License-Identifier: MPL-2.0
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Frame } from './frame.js';
import { fillBar, type QuotaRow, type ScenarioMark, type ScenarioRow } from './scenario-rows.js';
import { cellWidth, fit, fitRight } from './text.js';
import { COLOR, paint } from './theme.js';

/** The two sections of the side bar, by the id the `LayoutStore` keeps them under. */
export const SIDEBAR_SECTIONS = {
  scenarios: 'sidebar.scenarios',
  subscriptions: 'sidebar.subscriptions',
} as const;

/** What the cursor of the side bar can be on: a section header or a scenario. */
export interface SidebarItem {
  readonly kind: 'section' | 'scenario';
  readonly id: string;
}

/** The items the cursor walks, top to bottom; the rail has the scenarios only. */
export function sidebarItems(
  rows: readonly ScenarioRow[],
  folded: ReadonlySet<string>,
  mode: 'expanded' | 'rail',
): SidebarItem[] {
  const scenarios = rows.map((row): SidebarItem => ({ kind: 'scenario', id: row.id }));
  if (mode === 'rail') return folded.has(SIDEBAR_SECTIONS.scenarios) ? [] : scenarios;
  return [
    { kind: 'section', id: SIDEBAR_SECTIONS.scenarios },
    ...(folded.has(SIDEBAR_SECTIONS.scenarios) ? [] : scenarios),
    { kind: 'section', id: SIDEBAR_SECTIONS.subscriptions },
  ];
}

const MARK_GLYPH: Readonly<Record<ScenarioMark, string>> = {
  decision: '!',
  running: '●',
  done: '✓',
  idle: '○',
};

const MARK_COLOR: Readonly<Record<ScenarioMark, string | undefined>> = {
  decision: COLOR.warn,
  running: COLOR.ok,
  done: COLOR.ok,
  idle: undefined,
};

export interface SidebarProps {
  readonly mode: 'expanded' | 'rail';
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly rows: readonly ScenarioRow[];
  readonly quotas: readonly QuotaRow[];
  readonly folded: ReadonlySet<string>;
  /** The scenario the chat is about. */
  readonly selectedId: string | undefined;
  /** What the cursor is on (a scenario id or a section id). */
  readonly cursor: string | undefined;
  readonly address: string;
  readonly live: boolean;
  /** The keys, as the person reads them. */
  readonly keys: {
    readonly toggle: string | undefined;
    readonly settings: string | undefined;
  };
}

function quotaColor(row: QuotaRow): string {
  if (row.state === 'exhausted') return COLOR.error;
  if (row.state === 'near_limit') return COLOR.warn;
  return COLOR.ok;
}

function ExpandedQuota(props: { readonly row: QuotaRow; readonly inner: number }): ReactNode {
  const { t } = useTranslation();
  const { row, inner } = props;
  const color = quotaColor(row);
  const cells = Math.max(4, inner - 2);
  const values =
    row.fiveHour === undefined && row.week === undefined
      ? t('layout.sidebar.noReading')
      : `${row.fiveHour === undefined ? '—' : `${String(row.fiveHour)}%`} · ${row.week === undefined ? '—' : `${String(row.week)}%`}${row.state === 'near_limit' || row.state === 'exhausted' ? ' !' : ''}`;
  const name = fit(row.profile, Math.max(1, inner - cellWidth(values) - 1));
  return (
    <>
      <Text wrap="truncate">
        {name} <Text {...paint(row.state === 'ok' ? undefined : color)}>{values}</Text>
      </Text>
      {row.fiveHour !== undefined && (
        <Text color={color} wrap="truncate">
          {fillBar(cells, row.fiveHour)}
        </Text>
      )}
      {row.week !== undefined && (
        <Text color={color} dimColor wrap="truncate">
          {fillBar(cells, row.week, '━', '─')}
        </Text>
      )}
    </>
  );
}

function ScenarioLine(props: {
  readonly row: ScenarioRow;
  readonly inner: number;
  readonly selected: boolean;
  readonly cursor: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const { row, inner } = props;
  const state = t(`layout.state.${row.mark}`);
  const nameWidth = Math.max(1, inner - 4 - cellWidth(state) - 1);
  return (
    <Text wrap="truncate" {...paint(undefined, props.cursor ? COLOR.selected : undefined)}>
      <Text color={COLOR.accent}>{props.selected ? '▸ ' : '  '}</Text>
      <Text {...paint(MARK_COLOR[row.mark])}>{MARK_GLYPH[row.mark]}</Text>{' '}
      {fit(row.name, nameWidth)} <Text dimColor>{state}</Text>
    </Text>
  );
}

function SectionHead(props: {
  readonly title: string;
  readonly right: string;
  readonly inner: number;
  readonly folded: boolean;
  readonly cursor: boolean;
}): ReactNode {
  const head = `${props.folded ? '▸' : '▾'} ${props.title}`;
  const line = `${fit(head, Math.max(1, props.inner - cellWidth(props.right) - 1))} ${props.right}`;
  return (
    <Text
      bold
      dimColor={!props.cursor}
      {...paint(undefined, props.cursor ? COLOR.selected : undefined)}
      wrap="truncate"
    >
      {fit(line, props.inner)}
    </Text>
  );
}

function Expanded(props: SidebarProps): ReactNode {
  const { t } = useTranslation();
  const inner = props.width - 2;
  const scenariosFolded = props.folded.has(SIDEBAR_SECTIONS.scenarios);
  const subsFolded = props.folded.has(SIDEBAR_SECTIONS.subscriptions);
  const quotaLegend = `█${t('layout.sidebar.fiveHour')} ━${t('layout.sidebar.week')}`;
  const settings = t('layout.sidebar.settings');
  const daemon = t('layout.sidebar.daemon', { address: props.address });
  return (
    <>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <SectionHead
          title={t('layout.sidebar.scenarios')}
          right="+"
          inner={inner}
          folded={scenariosFolded}
          cursor={props.focused && props.cursor === SIDEBAR_SECTIONS.scenarios}
        />
        {!scenariosFolded &&
          props.rows.map((row) => (
            <ScenarioLine
              key={row.id}
              row={row}
              inner={inner}
              selected={props.selectedId === row.id}
              cursor={props.focused && props.cursor === row.id}
            />
          ))}
        {!scenariosFolded && props.rows.length === 0 && (
          <Text dimColor wrap="truncate">
            {`  ${t('layout.sidebar.empty')}`}
          </Text>
        )}
        <Text> </Text>
        <SectionHead
          title={t('layout.sidebar.subscriptions')}
          right={quotaLegend}
          inner={inner}
          folded={subsFolded}
          cursor={props.focused && props.cursor === SIDEBAR_SECTIONS.subscriptions}
        />
        {!subsFolded &&
          props.quotas.map((row) => <ExpandedQuota key={row.profile} row={row} inner={inner} />)}
        {!subsFolded && props.quotas.length === 0 && (
          <Text dimColor wrap="truncate">
            {`  ${t('layout.sidebar.noQuota')}`}
          </Text>
        )}
      </Box>
      <Text dimColor>{'─'.repeat(inner)}</Text>
      <Text wrap="truncate">
        {fit(`⚙ ${settings}`, Math.max(1, inner - (props.keys.settings?.length ?? 0) - 1))}{' '}
        <Text color={COLOR.key}>
          {fitRight(props.keys.settings ?? '', (props.keys.settings ?? '').length)}
        </Text>
      </Text>
      <Text wrap="truncate">
        <Text color={props.live ? COLOR.ok : COLOR.warn}>●</Text>{' '}
        {fit(daemon, Math.max(1, inner - 2))}
      </Text>
    </>
  );
}

function Rail(props: SidebarProps): ReactNode {
  const inner = props.width - 2;
  return (
    <>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text dimColor>{fit('»', inner)}</Text>
        {props.rows.map((row) => (
          <Text
            key={row.id}
            wrap="truncate"
            {...paint(
              undefined,
              props.focused && props.cursor === row.id ? COLOR.selected : undefined,
            )}
          >
            <Text
              {...paint(props.selectedId === row.id ? COLOR.accent : undefined)}
              bold={props.selectedId === row.id}
            >
              {fit(Array.from(row.name)[0]?.toUpperCase() ?? ' ', 1)}
            </Text>
            <Text {...paint(MARK_COLOR[row.mark])}>{MARK_GLYPH[row.mark]}</Text>
          </Text>
        ))}
        <Text dimColor>+</Text>
        <Text> </Text>
        {props.quotas.map((row) => (
          <Text key={row.profile} color={quotaColor(row)} wrap="truncate">
            {fillBar(inner, row.fiveHour ?? 0)}
          </Text>
        ))}
      </Box>
      <Text>⚙</Text>
      <Text color={props.live ? COLOR.ok : COLOR.warn}>●</Text>
    </>
  );
}

/** The side bar, whole (`expanded`) or as a rail of a few cells, with the scenarios and the quotas of the subscriptions. */
export function Sidebar(props: SidebarProps): ReactNode {
  const { t } = useTranslation();
  const right = props.mode === 'expanded' ? `« ${props.keys.toggle ?? ''}`.trimEnd() : undefined;
  return (
    <Frame
      width={props.width}
      height={props.height}
      active={props.focused}
      title={props.mode === 'expanded' ? t('layout.sidebar.title') : undefined}
      titleRight={right}
    >
      {props.mode === 'expanded' ? <Expanded {...props} /> : <Rail {...props} />}
    </Frame>
  );
}
