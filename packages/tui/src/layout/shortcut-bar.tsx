// SPDX-License-Identifier: MPL-2.0
import { translateUiText, type UiBarItem } from '@otheater/client';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useUiTranslate } from './use-ui-translate.js';
import { cellWidth } from './text.js';
import { COLOR } from './theme.js';

/** A key and what it does, already translated. */
export interface Hint {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

/** `^B Lateral  ^J Painel`: the hints that fit in `width`, from the first; what does not fit is left out. */
export function Hints(props: { readonly width: number; readonly hints: readonly Hint[] }): ReactNode {
  const shown: Hint[] = [];
  let used = 1;
  for (const hint of props.hints) {
    const cost = cellWidth(hint.label) + 2 + cellWidth(hint.text) + 3;
    if (used + cost > props.width) break;
    shown.push(hint);
    used += cost;
  }
  return (
    <Box width={props.width} height={1}>
      <Text wrap="truncate">
        {' '}
        {shown.map((hint) => (
          <Text key={hint.id}>
            <Text color={COLOR.key} bold backgroundColor={COLOR.keyBackground}>
              {` ${hint.label} `}
            </Text>
            <Text dimColor>{` ${hint.text}  `}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/**
 * The last row: the shortcuts that are active now, as the registry and the keymap give them
 * (`deriveShortcutBar`). What does not fit in the width is left out from the end, so the first
 * (the layout's own) stay.
 */
export function ShortcutBar(props: {
  readonly width: number;
  readonly items: readonly UiBarItem[];
}): ReactNode {
  const t = useUiTranslate();
  const hints = props.items.map((item) => ({
    id: item.id,
    label: item.label,
    text: translateUiText(t, item.text),
  }));
  return <Hints width={props.width} hints={hints} />;
}
