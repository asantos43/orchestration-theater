// SPDX-License-Identifier: MPL-2.0
import { Box, type DOMElement } from 'ink';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Text } from './themed-text.js';
import { useMouseTarget } from '../mouse/index.js';
import { isEmptySelection, rowSpan, selectionRange } from '../mouse/selection.js';
import { scrollWindow } from './scroll.js';
import { fit, sliceCells } from './text.js';
import { paint } from './theme.js';

/** One line of a list, as it is drawn. */
export interface ListLine {
  readonly text: string;
  readonly color?: string | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
}

export interface ScrollListProps {
  readonly count: number;
  readonly width: number;
  readonly height: number;
  /** Lines scrolled away from the anchor; `0` shows the end of the list (`bottom`) or its start (`top`). */
  readonly offset: number;
  /** `bottom` (the default) is a chat that follows its last line; `top` is a list read from its start. */
  readonly anchor?: 'top' | 'bottom' | undefined;
  /**
   * The lines of item `index` at `width`. It is asked only for the items the window touches, and
   * the answer is kept while `lines` and the width stay the same, so a long list costs what the
   * screen holds.
   */
  readonly lines: (index: number, width: number) => readonly ListLine[];
  /** Called when the list got shorter than the offset: the offset that really shows. */
  readonly onOffset?: ((offset: number) => void) | undefined;
  /** The text of the mark that tells there is more above, and below. */
  readonly marks?: { readonly above: string; readonly below: string } | undefined;
}

/** A window over a long list that is anchored at its end (the chat follows the last message). */
export function ScrollList(props: ScrollListProps): ReactNode {
  const { count, width, height, offset, lines, onOffset } = props;
  const anchor = props.anchor ?? 'bottom';
  const marks = props.marks ?? { above: '▲', below: '▼' };
  const cache = useMemo(() => new Map<number, readonly ListLine[]>(), [lines, width]);
  const window = useMemo(() => {
    const linesOf = (index: number): readonly ListLine[] => {
      let found = cache.get(index);
      if (found === undefined) {
        found = lines(index, width);
        cache.set(index, found);
      }
      return found;
    };
    const result = scrollWindow({
      count,
      height,
      offset,
      anchor,
      heightOf: (index) => linesOf(index).length,
    });
    const rows: ListLine[] = [];
    for (const slice of result.slices) {
      rows.push(...linesOf(slice.index).slice(slice.skip, slice.skip + slice.take));
    }
    return { rows, offset: result.offset, more: result.more };
  }, [cache, count, height, offset, lines, width, anchor]);
  useEffect(() => {
    if (window.offset !== offset) onOffset?.(window.offset);
  }, [window.offset, offset, onOffset]);
  const last = window.rows.length - 1;
  // What each row shows, and what it is when copied (without the mark of "more above/below").
  const shown = window.rows.map((row, index) => {
    const plain = fit(row.text, width).trimEnd();
    const mark =
      index === 0 && window.more.above
        ? marks.above
        : index === last && window.more.below
          ? marks.below
          : '';
    return { plain, text: mark === '' ? plain : `${fit(row.text, width - 1)}${mark}` };
  });
  // The wheel scrolls the list and the drag selects inside it (N34, N36).
  const ref = useRef<DOMElement>(null);
  const { selection } = useMouseTarget(ref, {
    onWheel: (lines) => {
      onOffset?.(Math.max(0, window.offset + (anchor === 'bottom' ? -lines : lines)));
    },
    rows: () => shown.map((row) => row.plain),
  });
  const range =
    selection === undefined || isEmptySelection(selection) ? undefined : selectionRange(selection);
  return (
    <Box ref={ref} flexDirection="column" width={width} height={height} overflow="hidden">
      {window.rows.map((row, index) => {
        const text = shown[index]?.text ?? '';
        const span = range === undefined ? undefined : rowSpan(range, index, width);
        return (
          <Text
            key={index}
            {...paint(row.color)}
            bold={row.bold === true}
            dimColor={row.dim === true}
            wrap="truncate"
          >
            {span === undefined ? (
              text === '' ? (
                ' '
              ) : (
                text
              )
            ) : (
              <>
                {sliceCells(text, 0, span[0])}
                <Text inverse>{sliceCells(text, span[0], span[1]) || ' '}</Text>
                {sliceCells(text, span[1], width)}
              </>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
