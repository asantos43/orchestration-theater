// SPDX-License-Identifier: MPL-2.0
import {
  filterPalette,
  translateUiText,
  type UiCommandRow,
  type UiHelpGroup,
  type UiTranslate,
} from '@otheater/client';
import { Select, TextInput } from '@inkjs/ui';
import { Box, Text } from 'ink';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollList, type ListLine } from './scroll-list.js';
import { fit } from './text.js';
import { useUiTranslate } from './use-ui-translate.js';
import { COLOR } from './theme.js';

/**
 * The three overlays: the palette (every command, filtered as the person types), the help (the
 * shortcuts by group, from the keymap that is really in force) and the picker of the tab to open.
 * They are drawn over the body of the screen; the selectors and the text field are the ones of
 * `@inkjs/ui`, and the key that closes them is the keymap's (`overlay.close`).
 */

export interface OverlayFrame {
  /** Columns and rows of the whole screen. */
  readonly columns: number;
  readonly rows: number;
}

/** The rectangle an overlay takes, centred, inside the screen. */
export function overlayRect(
  screen: OverlayFrame,
  wanted: { readonly width: number; readonly height: number },
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(10, Math.min(wanted.width, screen.columns - 2));
  const height = Math.max(5, Math.min(wanted.height, screen.rows - 2));
  return {
    x: Math.max(0, Math.floor((screen.columns - width) / 2)),
    y: Math.max(1, Math.floor((screen.rows - height) / 2)),
    width,
    height,
  };
}

function OverlayBox(props: {
  readonly screen: OverlayFrame;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  const rect = overlayRect(props.screen, props);
  return (
    <Box
      position="absolute"
      marginLeft={rect.x}
      marginTop={rect.y}
      width={rect.width}
      height={rect.height}
      borderStyle="round"
      borderColor={COLOR.borderActive}
      backgroundColor={COLOR.overlay}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={COLOR.accent} wrap="truncate">
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

/** A function that always calls the latest `fn`, so a component of `@inkjs/ui` is not given a new callback each render. */
function useLatest<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useMemo(
    () =>
      (...args: Args): void => {
        ref.current(...args);
      },
    [],
  );
}

export interface PaletteProps {
  readonly screen: OverlayFrame;
  readonly rows: readonly UiCommandRow[];
  /** `esc close` and so on, already translated. */
  readonly hint: string;
  readonly onRun: (id: string) => void;
}

function commandLabel(t: UiTranslate, row: UiCommandRow): string {
  const keys = row.labels.length === 0 ? '' : `  ${row.labels.join(' / ')}`;
  return `${translateUiText(t, row.text)}${keys}`;
}

export function PaletteOverlay(props: PaletteProps): ReactNode {
  const { t } = useTranslation();
  const ut = useUiTranslate();
  const [query, setQuery] = useState('');
  const found = useMemo(() => filterPalette(props.rows, query, ut), [props.rows, query, ut]);
  const options = useMemo(
    () => found.map((row) => ({ label: commandLabel(ut, row), value: row.id })),
    [found, ut],
  );
  const visible = Math.max(3, Math.min(12, props.screen.rows - 10));
  const run = useLatest(props.onRun);
  return (
    <OverlayBox
      screen={props.screen}
      width={76}
      height={visible + 6}
      title={t('layout.palette.title')}
    >
      <Box>
        <Text color={COLOR.accent}>{'› '}</Text>
        <TextInput placeholder={t('layout.palette.placeholder')} onChange={setQuery} />
      </Box>
      <Box flexDirection="column" height={visible} marginTop={1}>
        {options.length === 0 ? (
          <Text dimColor>{t('layout.palette.empty')}</Text>
        ) : (
          <Select options={options} visibleOptionCount={visible} onChange={run} />
        )}
      </Box>
      <Text dimColor wrap="truncate">
        {props.hint}
      </Text>
    </OverlayBox>
  );
}

export interface HelpProps {
  readonly screen: OverlayFrame;
  readonly groups: readonly UiHelpGroup[];
  readonly offset: number;
  readonly onOffset: (offset: number) => void;
  readonly hint: string;
}

/** The lines of the help: a header per group, then one line per command with its keys. */
export function helpLines(
  groups: readonly UiHelpGroup[],
  t: UiTranslate,
  width: number,
): ListLine[] {
  const lines: ListLine[] = [];
  const keysWidth = Math.min(28, Math.floor(width / 2));
  for (const group of groups) {
    if (lines.length > 0) lines.push({ text: '' });
    lines.push({ text: t(group.textKey), bold: true, color: COLOR.accent });
    for (const row of group.rows) {
      const keys = row.labels.length === 0 ? t('layout.help.paletteOnly') : row.labels.join(' / ');
      lines.push({
        text: `  ${fit(keys, keysWidth)} ${translateUiText(t, row.text)}`,
        dim: row.labels.length === 0,
      });
    }
  }
  return lines;
}

export function HelpOverlay(props: HelpProps): ReactNode {
  const { t } = useTranslation();
  const ut = useUiTranslate();
  const height = Math.max(8, props.screen.rows - 6);
  const width = Math.min(84, props.screen.columns - 4);
  const rect = overlayRect(props.screen, { width, height });
  const inner = rect.width - 4;
  const body = rect.height - 4;
  const all = useMemo(() => helpLines(props.groups, ut, inner), [props.groups, ut, inner]);
  const lines = useMemo(
    () =>
      (index: number): readonly ListLine[] => {
        const line = all[index];
        return line === undefined ? [{ text: '' }] : [line];
      },
    [all],
  );
  return (
    <OverlayBox screen={props.screen} width={width} height={height} title={t('layout.help.title')}>
      <ScrollList
        count={all.length}
        width={inner}
        height={body}
        offset={props.offset}
        anchor="top"
        lines={lines}
        onOffset={props.onOffset}
      />
      <Text dimColor wrap="truncate">
        {props.hint}
      </Text>
    </OverlayBox>
  );
}

export interface TabPickerProps {
  readonly screen: OverlayFrame;
  /** The tabs that can be opened: id and name. */
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly hint: string;
  readonly onPick: (id: string) => void;
}

export function TabPickerOverlay(props: TabPickerProps): ReactNode {
  const { t } = useTranslation();
  const options = useMemo(
    () => props.choices.map((choice) => ({ label: choice.label, value: choice.id })),
    [props.choices],
  );
  const visible = Math.max(1, Math.min(options.length, 10));
  const pick = useLatest(props.onPick);
  return (
    <OverlayBox
      screen={props.screen}
      width={44}
      height={Math.max(visible, 1) + 4}
      title={t('layout.picker.title')}
    >
      {options.length === 0 ? (
        <Text dimColor>{t('layout.picker.allOpen')}</Text>
      ) : (
        <Select options={options} visibleOptionCount={visible} onChange={pick} />
      )}
      <Text dimColor wrap="truncate">
        {props.hint}
      </Text>
    </OverlayBox>
  );
}
