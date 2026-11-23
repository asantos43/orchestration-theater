// SPDX-License-Identifier: MPL-2.0
import { Box, type DOMElement } from 'ink';
import { useRef, type ReactNode, type Ref } from 'react';
import { useTheme } from './theme-context.js';
import { Text } from './themed-text.js';
import { useMouseTarget } from '../mouse/index.js';
import { cellWidth, clip, fit } from './text.js';
import { TOKEN } from './theme.js';

/**
 * A rounded frame whose top and bottom lines are drawn here, so each can carry a title and a label
 * (Ink's border has no title). The right border is drawn here too: a stretch of it can be the
 * handle `┃` that the chat is widened by.
 */

export interface FrameHandle {
  /** First inner row of the handle. */
  readonly from: number;
  /** Rows it takes. */
  readonly rows: number;
  /** The border has the focus. */
  readonly active: boolean;
}

export interface FrameProps {
  readonly width: number;
  readonly height: number;
  readonly active: boolean;
  /** In the top line, left. */
  readonly title?: string | undefined;
  /** In the top line, right. */
  readonly titleRight?: string | undefined;
  /** In the bottom line, right. */
  readonly bottomLabel?: string | undefined;
  readonly handle?: FrameHandle | undefined;
  /** The box of the right border, for what answers to the mouse on it (the drag that widens the chat). */
  readonly edgeRef?: Ref<DOMElement> | undefined;
  /** A mouse press anywhere in the frame (the area takes the focus); what is inside still gets its click. */
  readonly onPress?: (() => void) | undefined;
  /**
   * Columns of margin inside the border, on each side (`ui.tuiLayout.density`, N258): what is
   * inside has `frameInner(width, pad)` cells. What goes from border to border (a separator, the
   * line of a selection) takes the margin back with a negative `marginX`. Default 0.
   */
  readonly pad?: number | undefined;
  readonly children: ReactNode;
}

/** The three parts of the top line: what comes before the title, the title (with its spaces) and the rest. */
export function frameLineParts(
  width: number,
  corners: readonly [string, string],
  left: string | undefined,
  right: string | undefined,
): { readonly before: string; readonly title: string; readonly after: string } {
  const [first, last] = corners;
  const available = Math.max(0, width - 4);
  let leftText = left === undefined || left === '' ? '' : ` ${left} `;
  let rightText = right === undefined || right === '' ? '' : ` ${right} `;
  if (cellWidth(leftText) > available)
    leftText = ` ${fit(left ?? '', Math.max(0, available - 2))} `;
  if (cellWidth(leftText) + cellWidth(rightText) > available) {
    rightText = clip(rightText, Math.max(0, available - cellWidth(leftText)));
  }
  const filler = Math.max(0, available - cellWidth(leftText) - cellWidth(rightText));
  return {
    before: `${first}─`,
    title: leftText,
    after: `${'─'.repeat(filler)}${rightText}─${last}`,
  };
}

/** `╭─ title ───── right ─╮` in exactly `width` cells. */
export function frameLine(
  width: number,
  corners: readonly [string, string],
  left: string | undefined,
  right: string | undefined,
): string {
  const parts = frameLineParts(width, corners, left, right);
  return fit(`${parts.before}${parts.title}${parts.after}`, width);
}

function column(glyph: string, rows: number): string {
  return Array.from({ length: Math.max(0, rows) }, () => glyph).join('\n');
}

export function Frame(props: FrameProps): ReactNode {
  const { width, height, active, handle } = props;
  const rootRef = useRef<DOMElement>(null);
  const { onPress } = props;
  useMouseTarget(
    rootRef,
    {
      onPress: () => {
        onPress?.();
      },
    },
    { enabled: onPress !== undefined },
  );
  const palette = useTheme();
  const color = active ? TOKEN.borderActive : TOKEN.border;
  const inner = Math.max(0, height - 2);
  const top = frameLine(width, ['╭', '╮'], props.title, props.titleRight);
  const bottom = frameLine(width, ['╰', '╯'], undefined, props.bottomLabel);
  const handleRows =
    handle === undefined ? 0 : Math.max(0, Math.min(handle.rows, inner - handle.from));
  const before = handle === undefined ? inner : Math.max(0, Math.min(handle.from, inner));
  const after = Math.max(0, inner - before - handleRows);
  return (
    <Box ref={rootRef} flexDirection="column" width={width} height={height}>
      {palette.paintsDim && props.title !== undefined && props.title !== '' && width >= 6 ? (
        <TitledTop
          parts={frameLineParts(width, ['╭', '╮'], props.title, props.titleRight)}
          width={width}
          active={active}
          color={color}
        />
      ) : (
        <Text color={color} bold={active}>
          {top}
        </Text>
      )}
      <Box height={inner}>
        <Box width={1} flexDirection="column">
          <Text color={color}>{column('│', inner)}</Text>
        </Box>
        <Box
          width={Math.max(0, width - 2)}
          height={inner}
          paddingX={props.pad ?? 0}
          flexDirection="column"
          overflow="hidden"
        >
          {props.children}
        </Box>
        <Box ref={props.edgeRef} width={1} flexDirection="column">
          {before > 0 && <Text color={color}>{column('│', before)}</Text>}
          {handle !== undefined && handleRows > 0 && (
            <Text color={handle.active ? TOKEN.borderActive : TOKEN.border} bold={handle.active}>
              {column('┃', handleRows)}
            </Text>
          )}
          {after > 0 && <Text color={color}>{column('│', after)}</Text>}
        </Box>
      </Box>
      <Text color={color}>{bottom}</Text>
    </Box>
  );
}

/**
 * The top line of the frame in `otheater`: the border in its colour and the title in its own (bold,
 * lighter when the frame has the focus), as in the mockup.
 */
function TitledTop(props: {
  readonly parts: ReturnType<typeof frameLineParts>;
  readonly width: number;
  readonly active: boolean;
  readonly color: string;
}): ReactNode {
  const { parts, width, active, color } = props;
  const used = cellWidth(parts.before) + cellWidth(parts.title);
  return (
    <Text wrap="truncate">
      <Text color={color}>{parts.before}</Text>
      <Text color={active ? TOKEN.titleActive : TOKEN.title} bold>
        {parts.title}
      </Text>
      <Text color={color}>{fit(parts.after, Math.max(0, width - used))}</Text>
    </Text>
  );
}
