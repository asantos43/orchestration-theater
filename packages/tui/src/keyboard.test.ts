// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { KEYBOARD_FLAGS, kittyKeyboardOption } from './keyboard.js';

/** `ui.keyboard.protocol` as the `kittyKeyboard` option of Ink's `render`. */

describe('kittyKeyboardOption', () => {
  it('auto lets Ink ask the terminal', () => {
    expect(kittyKeyboardOption('auto')).toEqual({
      mode: 'auto',
      flags: ['disambiguateEscapeCodes'],
    });
  });

  it('kitty has Ink turn the protocol on without asking', () => {
    expect(kittyKeyboardOption('kitty')).toEqual({
      mode: 'enabled',
      flags: ['disambiguateEscapeCodes'],
    });
  });

  it('off passes no option, so Ink neither asks nor turns anything on', () => {
    expect(kittyKeyboardOption('off')).toBeUndefined();
  });

  it('asks only for the flag that tells the keys apart, and gives each call its own list', () => {
    expect(KEYBOARD_FLAGS).toEqual(['disambiguateEscapeCodes']);
    const first = kittyKeyboardOption('auto');
    const second = kittyKeyboardOption('auto');
    expect(first?.flags).not.toBe(second?.flags);
  });
});
