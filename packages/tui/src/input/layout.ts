// SPDX-License-Identifier: MPL-2.0
import { nextBoundary, type Atom } from './editor.js';

/**
 * How the box is drawn, as data: the visible window of lines, and each line cut into the parts
 * that get a style (the text, a marker of an attachment, the cursor). Pure, so the component only
 * maps the parts to `<Text>`.
 */

export type SegmentKind = 'text' | 'marker' | 'cursor';

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
}

export interface BoxLayout {
  /** Lines of the text above the window. */
  readonly above: number;
  /** Lines of the text below the window. */
  readonly below: number;
  readonly lines: readonly (readonly Segment[])[];
}

/**
 * The window of at most `maxVisible` lines that holds the cursor, and its lines in parts. The
 * cursor is the character it stands on (a space at the end of a line); on a marker, the whole
 * marker is the cursor.
 */
export function layoutBox(
  text: string,
  cursor: number,
  atoms: readonly Atom[],
  maxVisible: number,
): BoxLayout {
  const rows: { start: number; end: number }[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      rows.push({ start, end: text.length });
      break;
    }
    rows.push({ start, end: newline });
    start = newline + 1;
  }
  const cursorRow = rows.findIndex((row) => cursor >= row.start && cursor <= row.end);
  const height = Math.max(1, maxVisible);
  const first = Math.min(
    Math.max(0, cursorRow - Math.floor(height / 2)),
    Math.max(0, rows.length - height),
  );
  const shown = rows.slice(first, first + height);
  return {
    above: first,
    below: rows.length - first - shown.length,
    lines: shown.map((row) => segmentsOf(text, row.start, row.end, cursor, atoms)),
  };
}

function segmentsOf(
  text: string,
  start: number,
  end: number,
  cursor: number,
  atoms: readonly Atom[],
): readonly Segment[] {
  const segments: Segment[] = [];
  const push = (kind: SegmentKind, value: string): void => {
    if (value === '') return;
    const last = segments[segments.length - 1];
    if (last?.kind === kind && kind === 'text') {
      segments[segments.length - 1] = { kind, text: last.text + value };
    } else {
      segments.push({ kind, text: value });
    }
  };
  let at = start;
  while (at < end) {
    const atom = atoms.find(([from, to]) => from === at && to <= end);
    if (atom !== undefined) {
      push(cursor === at ? 'cursor' : 'marker', text.slice(atom[0], atom[1]));
      at = atom[1];
      continue;
    }
    const next = Math.min(nextBoundary(text, at), end);
    push(cursor === at ? 'cursor' : 'text', text.slice(at, next));
    at = next;
  }
  if (cursor === end && cursor >= start) push('cursor', ' ');
  return segments;
}
