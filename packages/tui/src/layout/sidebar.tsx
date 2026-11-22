// SPDX-License-Identifier: MPL-2.0
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ClickTarget } from '../mouse/index.js';
import { Frame } from './frame.js';
import {
  fillBar,
  type FinishedRow,
  type QuotaRow,
  type ScenarioMark,
  type ScenarioRow,
} from './scenario-rows.js';
import { cellWidth, fit, fitRight } from './text.js';
import { COLOR, paint } from './theme.js';

/**
 * The sections of the side bar. `scenarios` and `subscriptions` fold through the `LayoutStore`;
 * `finished` (P11 of docs/19) starts as `ui.sidebar.finishedPlays` says and the person opens and
 * closes it in the session (the key `sidebar.toggleFinished`, Enter or a click).
 */
export const SIDEBAR_SECTIONS = {
  scenarios: 'sidebar.scenarios',
  finished: 'sidebar.finished',
  subscriptions: 'sidebar.subscriptions',
} as const;

/** What the cursor of the side bar can be on: a section header, a scenario or a finished play. */
export interface SidebarItem {
  readonly kind: 'section' | 'scenario' | 'finished';
  readonly id: string;
  /** The scenario a `finished` item belongs to (what the chat shows when it is opened). */
  readonly scenarioId?: string | undefined;
}

/** The "Terminadas" section: absent when `ui.sidebar.finishedPlays` is `hidden`. */
export interface SidebarFinished {
  readonly rows: readonly FinishedRow[];
  readonly open: boolean;
}

/** The items the cursor walks, top to bottom; the rail has the scenarios only. */
export function sidebarItems(
  rows: readonly ScenarioRow[],
  folded: ReadonlySet<string>,
  mode: 'expanded' | 'rail',
  finished?: SidebarFinished,
): SidebarItem[] {
  const scenarios = rows.map((row): SidebarItem => ({ kind: 'scenario', id: row.id }));
  if (mode === 'rail') return folded.has(SIDEBAR_SECTIONS.scenarios) ? [] : scenarios;
  return [
    { kind: 'section', id: SIDEBAR_SECTIONS.scenarios },
    ...(folded.has(SIDEBAR_SECTIONS.scenarios) ? [] : scenarios),
    ...(finished === undefined
      ? []
      : [
          { kind: 'section', id: SIDEBAR_SECTIONS.finished } satisfies SidebarItem,
          ...(finished.open
            ? finished.rows.map((row): SidebarItem => ({
                kind: 'finished',
                id: row.id,
                scenarioId: row.scenarioId,
              }))
            : []),
        ]),
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
  /** The sidebar is pressed with the mouse: it takes the focus. */
  readonly onFocus?: (() => void) | undefined;
  readonly rows: readonly ScenarioRow[];
  /** The "Terminadas" section; `undefined` leaves it out (`ui.sidebar.finishedPlays: hidden`). */
  readonly finished?: SidebarFinished | undefined;
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
  /** A click on a section or a scenario (N34); the same as Enter with the cursor on it. */
  readonly onActivate?: ((item: SidebarItem) => void) | undefined;
  /** A click on the settings line. */
  readonly onSettings?: (() => void) | undefined;
  /** A click on the `«` of the title, or on the `»` of the rail. */
  readonly onToggle?: (() => void) | undefined;
  /** [P22] A click on the `+` of the scenarios (the same as the key of `sidebar.newProject`). */
  readonly onNewProject?: (() => void) | undefined;
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
  readonly onClick?: (() => void) | undefined;
}): ReactNode {
  const { t } = useTranslation();
  const { row, inner } = props;
  const state = t(`layout.state.${row.mark}`);
  const nameWidth = Math.max(1, inner - 4 - cellWidth(state) - 1);
  return (
    <ClickTarget onClick={() => props.onClick?.()} enabled={props.onClick !== undefined}>
      <Text wrap="truncate" {...paint(undefined, props.cursor ? COLOR.selected : undefined)}>
        <Text color={COLOR.accent}>{props.selected ? '▸ ' : '  '}</Text>
        <Text {...paint(MARK_COLOR[row.mark])}>{MARK_GLYPH[row.mark]}</Text>{' '}
        {fit(row.name, nameWidth)} <Text dimColor>{state}</Text>
      </Text>
    </ClickTarget>
  );
}

function FinishedLine(props: {
  readonly row: FinishedRow;
  readonly inner: number;
  readonly cursor: boolean;
  readonly onClick?: (() => void) | undefined;
}): ReactNode {
  const { t } = useTranslation();
  const { row, inner } = props;
  const state = t(`layout.sidebar.finishedState.${row.outcome}`);
  const need = fit(row.need, Math.max(1, inner - 4 - cellWidth(state) - 1));
  return (
    <ClickTarget onClick={() => props.onClick?.()} enabled={props.onClick !== undefined}>
      <Text wrap="truncate" {...paint(undefined, props.cursor ? COLOR.selected : undefined)}>
        {'  '}
        <Text
          {...paint(row.outcome === 'done' ? COLOR.ok : undefined)}
          dimColor={row.outcome !== 'done'}
        >
          {row.outcome === 'done' ? '✓' : '✗'}
        </Text>{' '}
        {need} <Text dimColor>{state}</Text>
      </Text>
    </ClickTarget>
  );
}

function SectionHead(props: {
  readonly title: string;
  readonly right: string;
  readonly inner: number;
  readonly folded: boolean;
  readonly cursor: boolean;
  readonly onClick?: (() => void) | undefined;
  /** A click on the right side of the head (the `+` of the scenarios) answers with this instead. */
  readonly onRight?: (() => void) | undefined;
}): ReactNode {
  const head = `${props.folded ? '▸' : '▾'} ${props.title}`;
  const line = `${fit(head, Math.max(1, props.inner - cellWidth(props.right) - 1))} ${props.right}`;
  const rightFrom = props.inner - cellWidth(props.right) - 1;
  return (
    <ClickTarget
      onClick={(point) => {
        if (props.onRight !== undefined && point.x >= rightFrom) props.onRight();
        else props.onClick?.();
      }}
      enabled={props.onClick !== undefined || props.onRight !== undefined}
    >
      <Text
        bold
        dimColor={!props.cursor}
        {...paint(undefined, props.cursor ? COLOR.selected : undefined)}
        wrap="truncate"
      >
        {fit(line, props.inner)}
      </Text>
    </ClickTarget>
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
  const activate = (item: SidebarItem): (() => void) | undefined =>
    props.onActivate === undefined
      ? undefined
      : () => {
          props.onActivate?.(item);
        };
  return (
    <>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <SectionHead
          title={t('layout.sidebar.scenarios')}
          right="+"
          inner={inner}
          folded={scenariosFolded}
          cursor={props.focused && props.cursor === SIDEBAR_SECTIONS.scenarios}
          onClick={activate({ kind: 'section', id: SIDEBAR_SECTIONS.scenarios })}
          onRight={props.onNewProject}
        />
        {!scenariosFolded &&
          props.rows.map((row) => (
            <ScenarioLine
              key={row.id}
              row={row}
              inner={inner}
              selected={props.selectedId === row.id}
              cursor={props.focused && props.cursor === row.id}
              onClick={activate({ kind: 'scenario', id: row.id })}
            />
          ))}
        {!scenariosFolded && props.rows.length === 0 && (
          <Text dimColor wrap="truncate">
            {`  ${t('layout.sidebar.empty')}`}
          </Text>
        )}
        {props.finished !== undefined && (
          <>
            <Text> </Text>
            <SectionHead
              title={t('layout.sidebar.finished')}
              right={String(props.finished.rows.length)}
              inner={inner}
              folded={!props.finished.open}
              cursor={props.focused && props.cursor === SIDEBAR_SECTIONS.finished}
              onClick={activate({ kind: 'section', id: SIDEBAR_SECTIONS.finished })}
            />
            {props.finished.open &&
              props.finished.rows.map((row) => (
                <FinishedLine
                  key={row.id}
                  row={row}
                  inner={inner}
                  cursor={props.focused && props.cursor === row.id}
                  onClick={activate({
                    kind: 'finished',
                    id: row.id,
                    scenarioId: row.scenarioId,
                  })}
                />
              ))}
            {props.finished.open && props.finished.rows.length === 0 && (
              <Text dimColor wrap="truncate">
                {`  ${t('layout.sidebar.noFinished')}`}
              </Text>
            )}
          </>
        )}
        <Text> </Text>
        <SectionHead
          title={t('layout.sidebar.subscriptions')}
          right={quotaLegend}
          inner={inner}
          folded={subsFolded}
          cursor={props.focused && props.cursor === SIDEBAR_SECTIONS.subscriptions}
          onClick={activate({ kind: 'section', id: SIDEBAR_SECTIONS.subscriptions })}
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
      <ClickTarget onClick={() => props.onSettings?.()} enabled={props.onSettings !== undefined}>
        <Text wrap="truncate">
          {fit(`⚙ ${settings}`, Math.max(1, inner - (props.keys.settings?.length ?? 0) - 1))}{' '}
          <Text color={COLOR.key}>
            {fitRight(props.keys.settings ?? '', (props.keys.settings ?? '').length)}
          </Text>
        </Text>
      </ClickTarget>
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
        <ClickTarget onClick={() => props.onToggle?.()} enabled={props.onToggle !== undefined}>
          <Text dimColor>{fit('»', inner)}</Text>
        </ClickTarget>
        {props.rows.map((row) => (
          <ClickTarget
            key={row.id}
            onClick={() => props.onActivate?.({ kind: 'scenario', id: row.id })}
            enabled={props.onActivate !== undefined}
          >
            <Text
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
          </ClickTarget>
        ))}
        <ClickTarget
          onClick={() => props.onNewProject?.()}
          enabled={props.onNewProject !== undefined}
        >
          <Text dimColor>+</Text>
        </ClickTarget>
        <Text> </Text>
        {props.quotas.map((row) => (
          <Text key={row.profile} color={quotaColor(row)} wrap="truncate">
            {fillBar(inner, row.fiveHour ?? 0)}
          </Text>
        ))}
      </Box>
      <ClickTarget onClick={() => props.onSettings?.()} enabled={props.onSettings !== undefined}>
        <Text>⚙</Text>
      </ClickTarget>
      <Text color={props.live ? COLOR.ok : COLOR.warn}>●</Text>
    </>
  );
}

/** The side bar, whole (`expanded`) or as a rail of a few cells, with the scenarios and the quotas of the subscriptions. */
export function Sidebar(props: SidebarProps): ReactNode {
  const { t } = useTranslation();
  const right = props.mode === 'expanded' ? `« ${props.keys.toggle ?? ''}`.trimEnd() : undefined;
  return (
    <ClickTarget
      width={props.width}
      height={props.height}
      onClick={(point) => {
        // The `«` of the title, in the top line, before the corner.
        if (right === undefined || point.y !== 0) return;
        const from = props.width - 2 - cellWidth(right) - 2;
        if (point.x >= from && point.x < props.width - 2) props.onToggle?.();
      }}
      enabled={props.onToggle !== undefined && right !== undefined}
    >
      <Frame
        width={props.width}
        height={props.height}
        active={props.focused}
        title={props.mode === 'expanded' ? t('layout.sidebar.title') : undefined}
        titleRight={right}
        onPress={props.onFocus}
      >
        {props.mode === 'expanded' ? <Expanded {...props} /> : <Rail {...props} />}
      </Frame>
    </ClickTarget>
  );
}
