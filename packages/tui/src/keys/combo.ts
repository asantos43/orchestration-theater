// SPDX-License-Identifier: MPL-2.0
import { formatKeyCombo, parseKeyCombo, type KeyCombo } from '@otheater/protocol';

/**
 * From the bytes a terminal sends to the canonical key combination of the keymap (`Alt+S`,
 * `Ctrl+Shift+Left`, `F1`). Ink's `useInput` does not tell the F keys, so the layout reads the
 * input itself. Pure: no Ink here. [proposta] What it understands:
 * - a printable character, `Space`, `Enter` (CR), `Tab`, `Esc`, `Backspace` (DEL and BS);
 * - Ctrl+letter (the control characters; LF is `Ctrl+J`), and Alt+key (ESC before the key);
 * - the CSI and SS3 sequences of the arrows, Home/End, Insert/Delete, PageUp/PageDown, F1 to F12
 *   and the modifier parameter (`ESC [ 1 ; 5 C` is `Ctrl+Right`);
 * - the `modifyOtherKeys` form `ESC [ 27 ; m ; code ~` and the CSI-u form `ESC [ code ; m u`,
 *   which the terminals that were asked for an extended keyboard send.
 * What it does not understand gives `undefined`, so the caller leaves the key to the text box.
 */

const NAMED_CSI_LETTER: Readonly<Record<string, string>> = {
  A: 'Up',
  B: 'Down',
  C: 'Right',
  D: 'Left',
  H: 'Home',
  F: 'End',
  P: 'F1',
  Q: 'F2',
  R: 'F3',
  S: 'F4',
};

const NAMED_CSI_TILDE: Readonly<Record<number, string>> = {
  1: 'Home',
  2: 'Insert',
  3: 'Delete',
  4: 'End',
  5: 'PageUp',
  6: 'PageDown',
  7: 'Home',
  8: 'End',
  11: 'F1',
  12: 'F2',
  13: 'F3',
  14: 'F4',
  15: 'F5',
  17: 'F6',
  18: 'F7',
  19: 'F8',
  20: 'F9',
  21: 'F10',
  23: 'F11',
  24: 'F12',
};

/** The key of a code point of the CSI-u and `modifyOtherKeys` forms. */
function keyOfCode(code: number): string | undefined {
  switch (code) {
    case 9:
      return 'Tab';
    case 13:
      return 'Enter';
    case 27:
      return 'Esc';
    case 32:
      return 'Space';
    case 8:
    case 127:
      return 'Backspace';
    default:
      break;
  }
  if (code < 32) return undefined;
  const char = String.fromCodePoint(code);
  return char.toUpperCase();
}

/** The xterm modifier parameter (1 + bits: shift 1, alt 2, ctrl 4, super 8). */
function modifiersOf(parameter: number): Pick<KeyCombo, 'ctrl' | 'alt' | 'shift' | 'cmd'> {
  const bits = Math.max(0, parameter - 1);
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    cmd: (bits & 8) !== 0,
  };
}

type Modifiers = Pick<KeyCombo, 'ctrl' | 'alt' | 'shift' | 'cmd'>;

const NONE: Modifiers = { ctrl: false, alt: false, shift: false, cmd: false };

function make(key: string, modifiers: Partial<Modifiers> = {}): string {
  return formatKeyCombo({ ...NONE, ...modifiers, key });
}

function parseCsi(body: string, final: string): string | undefined {
  const numbers = body === '' ? [] : body.split(';').map((part) => Number.parseInt(part, 10));
  if (numbers.some((value) => Number.isNaN(value))) return undefined;
  if (final === 'Z') return make('Tab', { shift: true });
  if (final === 'u') {
    const [code, modifier] = numbers;
    const key = code === undefined ? undefined : keyOfCode(code);
    return key === undefined ? undefined : make(key, modifiersOf(modifier ?? 1));
  }
  if (final === '~') {
    const [first, second, third] = numbers;
    if (first === 27 && second !== undefined && third !== undefined) {
      // modifyOtherKeys: ESC [ 27 ; modifier ; code ~
      const key = keyOfCode(third);
      return key === undefined ? undefined : make(key, modifiersOf(second));
    }
    const key = first === undefined ? undefined : NAMED_CSI_TILDE[first];
    return key === undefined ? undefined : make(key, modifiersOf(second ?? 1));
  }
  const key = NAMED_CSI_LETTER[final];
  if (key === undefined) return undefined;
  // `ESC [ 1 ; 5 C`: the first parameter is a 1, the second the modifiers.
  return make(key, modifiersOf(numbers[1] ?? 1));
}

/** The combination one key press (one sequence) sends, or `undefined` when it is not a key we know. */
export function parseTerminalKey(data: string): string | undefined {
  if (data === '') return undefined;
  if (data.startsWith('\x1b')) {
    if (data.length === 1) return make('Esc');
    const next = data[1] ?? '';
    if (next === '[') {
      // eslint-disable-next-line no-control-regex -- an escape sequence starts with the ESC byte
      const match = /^\x1b\[([\d;:]*)([A-Za-z~])$/u.exec(data);
      if (match === null) return undefined;
      return parseCsi(match[1] ?? '', match[2] ?? '');
    }
    if (next === 'O') {
      // eslint-disable-next-line no-control-regex -- an escape sequence starts with the ESC byte
      const match = /^\x1bO(\d*;?\d*)([A-Z])$/u.exec(data);
      if (match === null) return undefined;
      const [, parameters = '', final = ''] = match;
      const modifier = parameters.includes(';')
        ? Number.parseInt(parameters.split(';')[1] ?? '', 10)
        : 1;
      const key = NAMED_CSI_LETTER[final];
      return key === undefined
        ? undefined
        : make(key, modifiersOf(Number.isNaN(modifier) ? 1 : modifier));
    }
    // ESC and one more key: the Alt of that key.
    const inner = parseTerminalKey(data.slice(1));
    const parsed = inner === undefined || data.length > 3 ? undefined : parseKeyCombo(inner);
    return parsed === undefined || parsed.alt
      ? undefined
      : formatKeyCombo({ ...parsed, alt: true });
  }
  const chars = Array.from(data);
  if (chars.length !== 1) return undefined;
  const char = chars[0] ?? '';
  const code = char.codePointAt(0) ?? 0;
  if (code === 13) return make('Enter');
  if (code === 9) return make('Tab');
  if (code === 127 || code === 8) return make('Backspace');
  if (code === 10) return make('J', { ctrl: true });
  if (code === 0) return make('Space', { ctrl: true });
  if (code >= 1 && code <= 26) return make(String.fromCharCode(code + 64), { ctrl: true });
  if (code < 32) return undefined;
  if (char === ' ') return make('Space');
  const upper = char.toUpperCase();
  const isLetter = /^\p{L}$/u.test(char);
  // A capital letter is the key with Shift; a symbol is itself.
  return make(isLetter ? upper : char, { shift: isLetter && char !== char.toLowerCase() });
}
