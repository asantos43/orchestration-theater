// SPDX-License-Identifier: MPL-2.0
import { Box } from 'ink';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EMPTY_PICKER_STATE,
  initialPickerState,
  pickerRows,
  pickerStep,
  pickerWindow,
  selectedIndex,
  type FolderFs,
  type GitMark,
  type PickerContext,
  type PickerEffect,
  type PickerRow,
  type PickerState,
} from './folder-picker.js';
import { Text } from './themed-text.js';
import { cellWidth, clip, clipStart, fit } from './text.js';
import { TOKEN } from './theme.js';

/**
 * The folder browser of "New scenario" (N332) as a component: {@link useFolderPicker} keeps its
 * state for the prompt (which hands it the keys), and {@link FolderPicker} draws the lines that
 * stand for the folder: the path, the offer to go up to the root of the repository, the filter and
 * the list. The prompt draws what is around it (the status and the hint).
 */

/** The lines the browser takes besides the list: the folder, the root of the repository and the filter. */
export const PICKER_FIXED_LINES = 3;

export interface UseFolderPickerOptions {
  readonly fs: FolderFs;
  /** Whether the browser is on (`ui.newProject.picker: browser`); off, nothing is read from the disk. */
  readonly enabled: boolean;
  /** The folder it starts on; the nearest one that exists is used, and an empty text is the home folder. */
  readonly wanted: string;
  readonly showHidden: boolean;
  readonly projects: readonly string[];
  readonly favorites: readonly string[];
  /** The rows of the list. */
  readonly height: number;
}

export interface FolderPickerHandle {
  readonly state: PickerState;
  /** The rows of the list now (shortcuts, this folder, the subfolders). */
  readonly rows: readonly PickerRow[];
  /** One key press; the effect, when the prompt has something to do. */
  readonly press: (event: {
    readonly combo: string | undefined;
    readonly data: string;
  }) => PickerEffect | undefined;
  /** The state after the last key, even when it has not been drawn yet. */
  readonly current: () => PickerState;
  /** Starts again on `wanted` (back from the field of the path). */
  readonly reset: (wanted: string) => void;
}

export function useFolderPicker(options: UseFolderPickerOptions): FolderPickerHandle {
  const [state, setState] = useState<PickerState>(() =>
    options.enabled
      ? initialPickerState(options.fs, options.wanted, options.showHidden)
      : EMPTY_PICKER_STATE,
  );
  // The latest state and context, kept in step with every key, so keys that arrive faster than a
  // render (a paste, a burst of typing) each act on what the one before left.
  const latest = useRef(state);
  const context = useRef<PickerContext>(options);
  context.current = options;
  const { projects, favorites } = options;
  return useMemo(
    () => ({
      state,
      rows: pickerRows(state, context.current),
      press: (event) => {
        const step = pickerStep(latest.current, event, context.current);
        if (step.state !== latest.current) {
          latest.current = step.state;
          setState(step.state);
        }
        return step.effect;
      },
      current: () => latest.current,
      reset: (wanted) => {
        const { fs } = context.current;
        const next = initialPickerState(fs, wanted, latest.current.showHidden);
        latest.current = next;
        setState(next);
      },
    }),
    [state, projects, favorites],
  );
}

type Translate = (key: string, params?: Record<string, string>) => string;

/** What a folder says about Git, in words: `git main`, `git detached a1b2c3d`, `git main, worktree`. */
export function gitLabel(mark: GitMark, t: Translate): string {
  let label: string;
  if (mark.ref === '') label = t('layout.newProject.picker.gitBare');
  else if (mark.detached) label = t('layout.newProject.picker.gitDetached', { ref: mark.ref });
  else label = t('layout.newProject.picker.git', { ref: mark.ref });
  return mark.worktree ? t('layout.newProject.picker.worktree', { label }) : label;
}

interface RowParts {
  readonly marker: string;
  readonly markerColor: string;
  readonly main: string;
  readonly mainDim: boolean;
  readonly suffix: string;
}

function partsOf(row: PickerRow, t: Translate): RowParts {
  const suffixOf = (git: GitMark | undefined): string =>
    git === undefined ? '' : `  [${gitLabel(git, t)}]`;
  switch (row.kind) {
    case 'shortcut':
      return {
        marker: row.favorite ? '★ ' : '◆ ',
        markerColor: row.favorite ? TOKEN.warn : TOKEN.info,
        main: row.path,
        mainDim: false,
        suffix: suffixOf(row.git),
      };
    case 'here':
      return {
        marker: row.favorite ? '★ ' : '  ',
        markerColor: TOKEN.warn,
        main: t('layout.newProject.picker.here'),
        mainDim: true,
        suffix: suffixOf(row.git),
      };
    case 'folder':
      return {
        marker: row.favorite ? '★ ' : '  ',
        markerColor: TOKEN.warn,
        main: row.name,
        mainDim: false,
        suffix: suffixOf(row.git),
      };
    case 'drive':
      return { marker: '  ', markerColor: TOKEN.text, main: row.path, mainDim: false, suffix: '' };
    case 'header':
      return {
        marker: '',
        markerColor: TOKEN.text,
        main: t(`layout.newProject.picker.sections.${row.section}`),
        mainDim: true,
        suffix: '',
      };
  }
}

function PickerLine(props: {
  readonly row: PickerRow;
  readonly cursor: boolean;
  readonly width: number;
  readonly t: Translate;
}): ReactNode {
  const { row, cursor, width, t } = props;
  const parts = partsOf(row, t);
  if (row.kind === 'header') {
    return (
      <Text dimColor bold wrap="truncate">
        {` ${parts.main}`}
      </Text>
    );
  }
  // The cursor takes the whole line: one text, padded to the width.
  const gutter = cursor ? '▸' : ' ';
  const room = Math.max(1, width - 1 - cellWidth(parts.marker) - cellWidth(parts.suffix));
  const main = row.kind === 'shortcut' ? clipStart(parts.main, room) : clipEnd(parts.main, room);
  if (cursor) {
    return (
      <Text selection wrap="truncate">
        {fit(`${gutter}${parts.marker}${main}${parts.suffix}`, width)}
      </Text>
    );
  }
  return (
    <Text wrap="truncate">
      <Text color={TOKEN.accent}>{gutter}</Text>
      <Text color={parts.markerColor}>{parts.marker}</Text>
      <Text dimColor={parts.mainDim}>{main}</Text>
      <Text color={TOKEN.ok}>{parts.suffix}</Text>
    </Text>
  );
}

/** The start of `text` in `width` cells, with an ellipsis when it was cut (a name is read from its start). */
function clipEnd(text: string, width: number): string {
  if (cellWidth(text) <= width) return text;
  return `${clip(text, width - 1)}…`;
}

export interface FolderPickerProps {
  readonly state: PickerState;
  readonly rows: readonly PickerRow[];
  readonly width: number;
  /** The rows of the list. */
  readonly height: number;
}

/** The lines of the browser: PICKER_FIXED_LINES, then `height` lines of the list. */
export function FolderPicker(props: FolderPickerProps): ReactNode {
  const { state, rows, width, height } = props;
  const { t } = useTranslation();
  const tr = t as unknown as Translate;
  const mark = state.here;
  const suffix = mark === undefined ? '' : `  [${gitLabel(mark, tr)}]`;
  const where =
    state.view === 'drives'
      ? tr('layout.newProject.picker.sections.drives')
      : tr('layout.newProject.picker.dir', { dir: state.dir });
  const cursor = selectedIndex(rows, state);
  const folders = rows.filter((row) => row.kind === 'folder').length;
  const warning =
    state.unreadable === undefined
      ? undefined
      : tr('layout.newProject.picker.unreadable', { code: state.unreadable });
  const note =
    state.view === 'folders' && state.unreadable === undefined && folders === 0
      ? tr(
          state.filter === ''
            ? 'layout.newProject.picker.empty'
            : 'layout.newProject.picker.noMatch',
        )
      : undefined;
  // The warning or the note takes the last line of the list.
  const window = pickerWindow(
    rows,
    state,
    warning === undefined && note === undefined ? height : height - 1,
  );
  const shown = rows.slice(window.start, window.end);
  return (
    <>
      <Text wrap="truncate">
        {clipStart(where, Math.max(1, width - cellWidth(suffix)))}
        <Text color={TOKEN.ok}>{suffix}</Text>
      </Text>
      <Text color={TOKEN.accent} wrap="truncate">
        {state.root === undefined
          ? ' '
          : clipStart(tr('layout.newProject.picker.root', { root: state.root }), width)}
      </Text>
      <Text wrap="truncate">
        {state.filter === '' ? (
          <Text dimColor>{tr('layout.newProject.picker.filterEmpty')}</Text>
        ) : (
          <>
            <Text color={TOKEN.accent}>
              {tr('layout.newProject.picker.filter', { text: state.filter })}
            </Text>
            <Text caret> </Text>
          </>
        )}
        <Text dimColor>
          {` · ${tr(state.showHidden ? 'layout.newProject.picker.hiddenShown' : 'layout.newProject.picker.hiddenHidden')}`}
        </Text>
      </Text>
      <Box flexDirection="column" height={height}>
        {shown.map((row, index) => (
          <PickerLine
            key={row.key}
            row={row}
            cursor={window.start + index === cursor}
            width={width}
            t={tr}
          />
        ))}
        {warning !== undefined && (
          <Text color={TOKEN.warn} wrap="truncate">
            {`  ${warning}`}
          </Text>
        )}
        {note !== undefined && (
          <Text dimColor wrap="truncate">
            {`  ${note}`}
          </Text>
        )}
      </Box>
    </>
  );
}
