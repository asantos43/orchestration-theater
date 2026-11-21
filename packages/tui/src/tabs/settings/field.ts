// SPDX-License-Identifier: MPL-2.0

/**
 * A one-line text field, as a pure step: what the value becomes with one key press (P16 of Phase 7).
 * Enter ends it, Esc drops it, Backspace takes the last character and Ctrl+U clears it; anything
 * printable (a typed letter or a paste) is appended, with the line breaks and the marks of a
 * bracketed paste left out. What is not printable (the arrows, the function keys) changes nothing.
 */
export interface FieldStep {
  readonly value: string;
  readonly done?: 'submit' | 'cancel';
}

const PASTE_MARKS = new RegExp(String.raw`\u001b\[20[01]~`, 'g');

export function fieldStep(value: string, combo: string | undefined, data: string): FieldStep {
  switch (combo) {
    case 'Enter':
      return { value, done: 'submit' };
    case 'Esc':
      return { value, done: 'cancel' };
    case 'Backspace':
      return { value: Array.from(value).slice(0, -1).join('') };
    case 'Ctrl+U':
      return { value: '' };
    default:
      break;
  }
  const text = data.replace(PASTE_MARKS, '').replace(/[\r\n]+/g, '');
  // Anything left that is a control character is a key, not text.
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\x00-\x1f\x7f]/.test(text)) return { value };
  return { value: value + text };
}
