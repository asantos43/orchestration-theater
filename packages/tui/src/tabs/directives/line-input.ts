// SPDX-License-Identifier: MPL-2.0

/**
 * A one-line text field of the forms of the tab Directives. Pure: the state and the keys in, the
 * new state out. [proposta] It is small on purpose (insert, delete, move, cut), because the
 * forms ask for a sentence or a date; the text box of the Producer (`input/`) is for the chat.
 */

export interface LineState {
  readonly value: string;
  /** Position in characters (code points), from `0` to the length of `value`. */
  readonly cursor: number;
}

export const EMPTY_LINE: LineState = { value: '', cursor: 0 };

export function lineOf(value: string): LineState {
  return { value, cursor: Array.from(value).length };
}

/** What the person did: the combination of a key (`Left`, `Ctrl+U`) and the bytes the terminal sent. */
export interface LineKey {
  readonly combo: string | undefined;
  readonly data: string;
}

function chars(state: LineState): string[] {
  return Array.from(state.value);
}

function make(list: readonly string[], cursor: number): LineState {
  return { value: list.join(''), cursor: Math.max(0, Math.min(list.length, cursor)) };
}

/** Text a person typed or pasted: no control characters, and a line break becomes a space. */
export function printableText(data: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  return data.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** The start of the word before the cursor (spaces first, then the word). */
function wordStart(list: readonly string[], from: number): number {
  let at = from;
  while (at > 0 && list[at - 1] === ' ') at -= 1;
  while (at > 0 && list[at - 1] !== ' ') at -= 1;
  return at;
}

/**
 * Applies one key. Returns the same state when the key is not for the field (a key it does not
 * know, or an escape sequence), so the caller can tell by identity.
 */
export function editLine(state: LineState, key: LineKey): LineState {
  const list = chars(state);
  const at = state.cursor;
  switch (key.combo) {
    case 'Left':
    case 'Ctrl+B':
      return at === 0 ? state : { ...state, cursor: at - 1 };
    case 'Right':
    case 'Ctrl+F':
      return at >= list.length ? state : { ...state, cursor: at + 1 };
    case 'Home':
    case 'Ctrl+A':
      return at === 0 ? state : { ...state, cursor: 0 };
    case 'End':
    case 'Ctrl+E':
      return at >= list.length ? state : { ...state, cursor: list.length };
    case 'Backspace':
      return at === 0 ? state : make([...list.slice(0, at - 1), ...list.slice(at)], at - 1);
    case 'Delete':
      return at >= list.length ? state : make([...list.slice(0, at), ...list.slice(at + 1)], at);
    case 'Ctrl+U':
      return at === 0 ? state : make(list.slice(at), 0);
    case 'Ctrl+K':
      return at >= list.length ? state : make(list.slice(0, at), at);
    case 'Ctrl+W':
    case 'Alt+Backspace': {
      const start = wordStart(list, at);
      return start === at ? state : make([...list.slice(0, start), ...list.slice(at)], start);
    }
    default:
      break;
  }
  // Not a key of the field: text (a character, or a paste), unless it is an escape sequence.
  if (key.data.startsWith('\u001b')) return state;
  const text = printableText(key.data);
  if (text === '') return state;
  const added = Array.from(text);
  return make([...list.slice(0, at), ...added, ...list.slice(at)], at + added.length);
}

/** The text split at the cursor, for drawing it: before, the character under it (a space at the end), after. */
export function splitAtCursor(state: LineState): {
  before: string;
  under: string;
  after: string;
} {
  const list = chars(state);
  return {
    before: list.slice(0, state.cursor).join(''),
    under: list[state.cursor] ?? ' ',
    after: list.slice(state.cursor + 1).join(''),
  };
}
