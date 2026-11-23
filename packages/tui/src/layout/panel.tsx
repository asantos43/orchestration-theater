// SPDX-License-Identifier: MPL-2.0
import { Box, type DOMElement } from 'ink';
import { useRef, type ReactNode } from 'react';
import { Text } from './themed-text.js';
import { useMouseTarget } from '../mouse/index.js';
import { edgeMargin, frameInner, useDensity } from './density-context.js';
import { Frame } from './frame.js';
import { Hints, type Hint } from './shortcut-bar.js';
import { layoutTabBar, type TabLabel } from './tab-bar.js';
import { panelBarRight, tabBarHit, type TabBarHit } from './tab-bar-hit.js';
import { cellWidth } from './text.js';
import { TOKEN, paint } from './theme.js';

/**
 * Cells and rows left to the content of a panel of this size: the frame (with its margin, `pad`
 * columns on each side), the tab bar and the footer take the rest.
 */
export function panelContentSize(
  width: number,
  height: number,
  pad = 0,
): { width: number; height: number } {
  return { width: frameInner(width, pad), height: Math.max(0, height - 5) };
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
  /** A click on the tab bar (N34): a tab, its `✕`, the `+` or the `⟩`. */
  readonly onBarClick?: ((hit: TabBarHit) => void) | undefined;
  /** The wheel over the content; positive lines are toward the end. */
  readonly onWheel?: ((lines: number) => void) | undefined;
  /** The panel is pressed with the mouse: it takes the focus. */
  readonly onFocus?: (() => void) | undefined;
  readonly children: ReactNode;
}

/** The panel of tabs: the bar with its tabs, a line under it, the content of the active tab and a footer of hints. */
export function Panel(props: PanelProps): ReactNode {
  const { pad } = useDensity();
  // The bar and the line under it go from border to border (`inner`); the tabs start after the margin.
  const inner = Math.max(0, props.width - 2);
  const right = panelBarRight(props.keys);
  const left = Math.max(0, inner - pad - cellWidth(right));
  const bar = layoutTabBar(props.tabs, props.active, left);
  const used = bar.segments.reduce((total, segment) => total + cellWidth(segment.text), 0);
  const gap = Math.max(0, inner - pad - used - cellWidth(right));
  const content = panelContentSize(props.width, props.height, pad);
  const barRef = useRef<DOMElement>(null);
  const bodyRef = useRef<DOMElement>(null);
  useMouseTarget(barRef, {
    onClick: (point) => {
      // The bar is counted from the border; the tabs start after the margin.
      const hit = tabBarHit(props.tabs, props.active, props.keys, inner - pad, point.x - pad);
      if (hit !== undefined) props.onBarClick?.(hit);
    },
  });
  useMouseTarget(bodyRef, {
    onWheel: (lines) => {
      props.onWheel?.(lines);
    },
  });
  return (
    <Frame
      width={props.width}
      height={props.height}
      active={props.focused}
      pad={pad}
      onPress={props.onFocus}
    >
      <Box ref={barRef} width={inner} height={1} {...edgeMargin(pad)}>
        <Text wrap="truncate">
          {' '.repeat(pad)}
          {bar.segments.map((segment) =>
            segment.id.startsWith('sep-') ? (
              <Text key={segment.id} dimColor>
                {segment.text}
              </Text>
            ) : (
              <Text
                key={segment.id}
                bold={segment.active}
                {...paint(
                  segment.active ? TOKEN.tabText : undefined,
                  segment.active ? TOKEN.selected : undefined,
                )}
                dimColor={!segment.active}
              >
                {segment.text}
              </Text>
            ),
          )}
          {' '.repeat(gap)}
          <Text color={TOKEN.accent}>{right}</Text>
        </Text>
      </Box>
      <Box {...edgeMargin(pad)}>
        <Text color={props.focused ? TOKEN.borderActive : TOKEN.border} wrap="truncate">
          {(
            '─'.repeat(pad) +
            bar.underline +
            '─'.repeat(Math.max(0, inner - pad - cellWidth(bar.underline)))
          ).slice(0, inner)}
        </Text>
      </Box>
      <Box
        ref={bodyRef}
        width={content.width}
        height={content.height}
        flexDirection="column"
        overflow="hidden"
      >
        {props.children}
      </Box>
      <Hints width={content.width} hints={props.footer} bare={pad > 0} />
    </Frame>
  );
}
