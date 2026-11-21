// SPDX-License-Identifier: MPL-2.0
import { cellWidth, sliceCells } from '../layout/text.js';

/**
 * The selection the interface makes by itself inside one area (N36): a drag from a cell to a cell,
 * read in the order of reading, as a text editor does. Pure: the area gives its visible rows as
 * text and the selection says which cells of them are chosen.
 */

/** A cell of the area, counted from its top left corner. */
export interface Cell {
  readonly x: number;
  readonly y: number;
}

export interface Selection {
  /** The drag started here. */
  readonly anchor: Cell;
  /** The drag is here now. */
  readonly head: Cell;
}

export interface SelectionRange {
  readonly start: Cell;
  /** Included. */
  readonly end: Cell;
}

/** `anchor` and `head` in reading order: the row first, then the column. */
export function selectionRange(selection: Selection): SelectionRange {
  const { anchor, head } = selection;
  const forward = anchor.y < head.y || (anchor.y === head.y && anchor.x <= head.x);
  return forward ? { start: anchor, end: head } : { start: head, end: anchor };
}

/** The selection is more than the cell it started in. */
export function isEmptySelection(selection: Selection): boolean {
  return selection.anchor.x === selection.head.x && selection.anchor.y === selection.head.y;
}

/**
 * The cells of row `y` the range chooses, as `[from, to)`, or `undefined` when the row is out of it.
 * `width` is the width of the area: a row in the middle of a range is chosen to its end.
 */
export function rowSpan(
  range: SelectionRange,
  y: number,
  width: number,
): readonly [number, number] | undefined {
  if (y < range.start.y || y > range.end.y) return undefined;
  const from = y === range.start.y ? range.start.x : 0;
  const to = y === range.end.y ? range.end.x + 1 : width;
  return to > from ? [from, to] : undefined;
}

/** The text a range chooses out of the rows of an area: each row without the blanks at its end. */
export function selectedText(
  rows: readonly string[],
  range: SelectionRange,
  width: number,
): string {
  const lines: string[] = [];
  for (let y = range.start.y; y <= range.end.y; y += 1) {
    const row = rows[y] ?? '';
    const span = rowSpan(range, y, Math.max(width, cellWidth(row)));
    lines.push(span === undefined ? '' : sliceCells(row, span[0], span[1]).trimEnd());
  }
  return lines.join('\n').trimEnd();
}
