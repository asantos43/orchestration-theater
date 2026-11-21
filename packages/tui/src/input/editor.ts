// SPDX-License-Identifier: MPL-2.0

/**
 * The editing of the text box, as pure functions over `{text, cursor}` (readline style, N35).
 * `cursor` is an index in UTF-16 code units, always on the boundary of a grapheme. An "atom" is a
 * range of the text the cursor treats as one character: the markers of attachments (`[Pasted text
 * #1]`), which a single Backspace removes whole and the cursor never stops inside.
 */

export interface EditorState {
  readonly text: string;
  readonly cursor: number;
  /** What the last cut took out (the text Ctrl+Y puts back). */
  readonly killed: string;
}

export type Atom = readonly [start: number, end: number];

export function createEditor(text = ''): EditorState {
  return { text, cursor: text.length, killed: '' };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** The part of the text looked at around the cursor to find a grapheme (a ZWJ emoji is ~ 20 units). */
const WINDOW = 64;

/** The start of the grapheme that ends at `index`. */
export function previousBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  const from = Math.max(0, index - WINDOW);
  let last = from;
  for (const part of segmenter.segment(text.slice(from, index))) last = from + part.index;
  return last;
}

/** The end of the grapheme that starts at `index`. */
export function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const first = segmenter
    .segment(text.slice(index, index + WINDOW))
    [Symbol.iterator]()
    .next();
  return index + (first.done === true ? 1 : first.value.segment.length);
}

/** The ranges of `text` taken by the given markers (every occurrence). */
export function atomRanges(text: string, markers: readonly string[]): readonly Atom[] {
  const ranges: Atom[] = [];
  for (const marker of new Set(markers)) {
    if (marker === '') continue;
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
      ranges.push([at, at + marker.length]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Moves `index` out of the inside of an atom: to its start going `back`, to its end going `forward`. */
function snap(index: number, atoms: readonly Atom[], direction: 'back' | 'forward'): number {
  for (const [start, end] of atoms) {
    if (index > start && index < end) return direction === 'back' ? start : end;
  }
  return index;
}

function at(state: EditorState, cursor: number): EditorState {
  return { ...state, cursor };
}

// ---- Editing ---------------------------------------------------------------------------------

/** Writes `value` at the cursor, which ends after it. */
export function insert(state: EditorState, value: string): EditorState {
  if (value === '') return state;
  const text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
  return { ...state, text, cursor: state.cursor + value.length };
}

function removeRange(state: EditorState, start: number, end: number, keep: boolean): EditorState {
  if (start >= end) return state;
  return {
    text: state.text.slice(0, start) + state.text.slice(end),
    cursor: start,
    killed: keep ? state.text.slice(start, end) : state.killed,
  };
}

export function deleteBackward(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  const start = snap(previousBoundary(state.text, state.cursor), atoms, 'back');
  return removeRange(state, start, state.cursor, false);
}

export function deleteForward(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  const end = snap(nextBoundary(state.text, state.cursor), atoms, 'forward');
  return removeRange(state, state.cursor, end, false);
}

// ---- Lines -----------------------------------------------------------------------------------

/** The index where the line of `index` starts. */
export function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

/** The index where the line of `index` ends (before its newline, or the end of the text). */
export function lineEndOf(text: string, index: number): number {
  const end = text.indexOf('\n', index);
  return end === -1 ? text.length : end;
}

export function moveToLineStart(state: EditorState): EditorState {
  return at(state, lineStartOf(state.text, state.cursor));
}

export function moveToLineEnd(state: EditorState): EditorState {
  return at(state, lineEndOf(state.text, state.cursor));
}

/** True when the cursor is on the first line of the text. */
export function onFirstLine(state: EditorState): boolean {
  return lineStartOf(state.text, state.cursor) === 0;
}

/** True when the cursor is on the last line of the text. */
export function onLastLine(state: EditorState): boolean {
  return lineEndOf(state.text, state.cursor) === state.text.length;
}

function placeInLine(
  state: EditorState,
  lineStart: number,
  column: number,
  atoms: readonly Atom[],
): EditorState {
  const end = lineEndOf(state.text, lineStart);
  let target = Math.min(lineStart + column, end);
  // Do not stop between the two halves of a surrogate pair.
  const code = state.text.charCodeAt(target);
  if (target > lineStart && target < end && code >= 0xdc00 && code <= 0xdfff) target -= 1;
  return at(state, snap(target, atoms, 'back'));
}

/** One line up, in the same column; the same state when there is no line above. */
export function moveUp(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  const start = lineStartOf(state.text, state.cursor);
  if (start === 0) return state;
  const column = state.cursor - start;
  return placeInLine(state, lineStartOf(state.text, start - 1), column, atoms);
}

/** One line down, in the same column; the same state when there is no line below. */
export function moveDown(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  const end = lineEndOf(state.text, state.cursor);
  if (end === state.text.length) return state;
  const column = state.cursor - lineStartOf(state.text, state.cursor);
  return placeInLine(state, end + 1, column, atoms);
}

// ---- Characters and words --------------------------------------------------------------------

export function moveLeft(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  return at(state, snap(previousBoundary(state.text, state.cursor), atoms, 'back'));
}

export function moveRight(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  return at(state, snap(nextBoundary(state.text, state.cursor), atoms, 'forward'));
}

const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(char: string): boolean {
  return WORD.test(char);
}

/** The start of the word before `index` (skipping what is not a word first). */
export function wordStartBefore(text: string, index: number, atoms: readonly Atom[] = []): number {
  let i = index;
  while (i > 0) {
    const before = previousBoundary(text, i);
    if (isWordChar(text.slice(before, i))) break;
    i = before;
  }
  while (i > 0) {
    const before = previousBoundary(text, i);
    if (!isWordChar(text.slice(before, i))) break;
    i = before;
  }
  return snap(i, atoms, 'back');
}

/** The end of the word after `index` (skipping what is not a word first). */
export function wordEndAfter(text: string, index: number, atoms: readonly Atom[] = []): number {
  let i = index;
  while (i < text.length) {
    const next = nextBoundary(text, i);
    if (isWordChar(text.slice(i, next))) break;
    i = next;
  }
  while (i < text.length) {
    const next = nextBoundary(text, i);
    if (!isWordChar(text.slice(i, next))) break;
    i = next;
  }
  return snap(i, atoms, 'forward');
}

export function moveWordLeft(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  return at(state, wordStartBefore(state.text, state.cursor, atoms));
}

export function moveWordRight(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  return at(state, wordEndAfter(state.text, state.cursor, atoms));
}

// ---- Cutting (the kill ring of readline, with one slot) ---------------------------------------

/** Ctrl+K: from the cursor to the end of the line; at the end of a line, the newline itself. */
export function killToLineEnd(state: EditorState): EditorState {
  const end = lineEndOf(state.text, state.cursor);
  const to = end === state.cursor && end < state.text.length ? end + 1 : end;
  return removeRange(state, state.cursor, to, true);
}

/** Ctrl+U: from the start of the line to the cursor; at the start of a line, the newline before. */
export function killToLineStart(state: EditorState): EditorState {
  const start = lineStartOf(state.text, state.cursor);
  const from = start === state.cursor && start > 0 ? start - 1 : start;
  return removeRange(state, from, state.cursor, true);
}

export function killWordBackward(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  return removeRange(state, wordStartBefore(state.text, state.cursor, atoms), state.cursor, true);
}

export function killWordForward(state: EditorState, atoms: readonly Atom[] = []): EditorState {
  return removeRange(state, state.cursor, wordEndAfter(state.text, state.cursor, atoms), true);
}

/** Ctrl+Y: puts back what was cut last. */
export function yank(state: EditorState): EditorState {
  return insert(state, state.killed);
}
