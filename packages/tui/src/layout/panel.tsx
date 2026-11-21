// SPDX-License-Identifier: MPL-2.0
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { Frame } from './frame.js';
import { Hints, type Hint } from './shortcut-bar.js';
import { layoutTabBar, type TabLabel } from './tab-bar.js';
import { cellWidth } from './text.js';
import { COLOR, paint } from './theme.js';

/** Cells and rows left to the content of a panel of this size: the frame, the tab bar and the footer take the rest. */
export function panelContentSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(0, width - 2), height: Math.max(0, height - 5) };
}

export interface PanelProps {
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly tabs: readonly TabLabel[];
  readonly active: string | undefined;
  /** The keys of `+` and `⟩`, as the person reads them. */
  readonly keys: { readonly add: string | undefined; readonly toggle: string | undefined };
  readonly footer: readonly Hint[];
  readonly children: ReactNode;
}

/** The panel of tabs: the bar with its tabs, a line under it, the content of the active tab and a footer of hints. */
export function Panel(props: PanelProps): ReactNode {
  const inner = Math.max(0, props.width - 2);
  const right = `+${props.keys.add === undefined ? '' : ` ${props.keys.add}`}  ⟩${props.keys.toggle === undefined ? '' : ` ${props.keys.toggle}`} `;
  const left = Math.max(0, inner - cellWidth(right));
  const bar = layoutTabBar(props.tabs, props.active, left);
  const used = bar.segments.reduce((total, segment) => total + cellWidth(segment.text), 0);
  const gap = Math.max(0, inner - used - cellWidth(right));
  const content = panelContentSize(props.width, props.height);
  return (
    <Frame width={props.width} height={props.height} active={props.focused}>
      <Text wrap="truncate">
        {bar.segments.map((segment) =>
          segment.id.startsWith('sep-') ? (
            <Text key={segment.id} dimColor>
              {segment.text}
            </Text>
          ) : (
            <Text
              key={segment.id}
              bold={segment.active}
              {...paint(segment.active ? 'white' : undefined, segment.active ? COLOR.selected : undefined)}
              dimColor={!segment.active}
            >
              {segment.text}
            </Text>
          ),
        )}
        {' '.repeat(gap)}
        <Text color={COLOR.accent}>{right}</Text>
      </Text>
      <Text color={props.focused ? COLOR.borderActive : COLOR.border} wrap="truncate">
        {(bar.underline + '─'.repeat(Math.max(0, inner - cellWidth(bar.underline)))).slice(0, inner)}
      </Text>
      <Box width={content.width} height={content.height} flexDirection="column" overflow="hidden">
        {props.children}
      </Box>
      <Hints width={inner} hints={props.footer} />
    </Frame>
  );
}
