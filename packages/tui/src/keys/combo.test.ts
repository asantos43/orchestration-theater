// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseTerminalKey } from './combo.js';

describe('parseTerminalKey', () => {
  it('reads the keys of the default keymap', () => {
    expect(parseTerminalKey('\x1bs')).toBe('Alt+S');
    expect(parseTerminalKey('\x1bj')).toBe('Alt+J');
    expect(parseTerminalKey('\x1bk')).toBe('Alt+K');
    expect(parseTerminalKey('\x1ba')).toBe('Alt+A');
    expect(parseTerminalKey('\x1bw')).toBe('Alt+W');
    expect(parseTerminalKey('\x11')).toBe('Ctrl+Q');
    expect(parseTerminalKey('\x03')).toBe('Ctrl+C');
    expect(parseTerminalKey('\x02')).toBe('Ctrl+B');
  });

  it('reads the F keys, which Ink does not tell', () => {
    expect(parseTerminalKey('\x1bOP')).toBe('F1');
    expect(parseTerminalKey('\x1b[11~')).toBe('F1');
    expect(parseTerminalKey('\x1b[15~')).toBe('F5');
    expect(parseTerminalKey('\x1b[17~')).toBe('F6');
    expect(parseTerminalKey('\x1b[24~')).toBe('F12');
    expect(parseTerminalKey('\x1b[15;2~')).toBe('Shift+F5');
  });

  it('reads the arrows with modifiers', () => {
    expect(parseTerminalKey('\x1b[A')).toBe('Up');
    expect(parseTerminalKey('\x1bOB')).toBe('Down');
    expect(parseTerminalKey('\x1b[1;6C')).toBe('Ctrl+Shift+Right');
    expect(parseTerminalKey('\x1b[1;6D')).toBe('Ctrl+Shift+Left');
    expect(parseTerminalKey('\x1b[1;5D')).toBe('Ctrl+Left');
    expect(parseTerminalKey('\x1b[1;3A')).toBe('Alt+Up');
    expect(parseTerminalKey('\x1b[Z')).toBe('Shift+Tab');
  });

  it('reads the extended keyboard forms', () => {
    expect(parseTerminalKey('\x1b[27;6;112~')).toBe('Ctrl+Shift+P');
    expect(parseTerminalKey('\x1b[115;3u')).toBe('Alt+S');
    expect(parseTerminalKey('\x1b[13;2u')).toBe('Shift+Enter');
  });

  // With `ui.keyboard.protocol` on (flag 1 of the kitty protocol) the terminal writes these keys as
  // CSI-u: they must come out as the same combos the keymap already has.
  it('reads the keys the kitty protocol disambiguates (ui.keyboard.protocol)', () => {
    expect(parseTerminalKey('\x1b[27u')).toBe('Esc');
    expect(parseTerminalKey('\x1b[99;5u')).toBe('Ctrl+C');
    expect(parseTerminalKey('\x1b[113;5u')).toBe('Ctrl+Q');
    expect(parseTerminalKey('\x1b[9;2u')).toBe('Shift+Tab');
    expect(parseTerminalKey('\x1b[13;3u')).toBe('Alt+Enter');
    expect(parseTerminalKey('\x1b[13;5u')).toBe('Ctrl+Enter');
  });

  it('reads the plain keys', () => {
    expect(parseTerminalKey('\r')).toBe('Enter');
    expect(parseTerminalKey('\t')).toBe('Tab');
    expect(parseTerminalKey('\x1b')).toBe('Esc');
    expect(parseTerminalKey(' ')).toBe('Space');
    expect(parseTerminalKey('\x7f')).toBe('Backspace');
    expect(parseTerminalKey('\x1b[3~')).toBe('Delete');
    expect(parseTerminalKey('\x1b[5~')).toBe('PageUp');
    expect(parseTerminalKey('a')).toBe('A');
    expect(parseTerminalKey('A')).toBe('Shift+A');
    expect(parseTerminalKey('+')).toBe('Plus');
    expect(parseTerminalKey('\n')).toBe('Ctrl+J');
  });

  it('gives undefined for what it does not know, so the text box keeps it', () => {
    expect(parseTerminalKey('')).toBeUndefined();
    expect(parseTerminalKey('hello')).toBeUndefined();
    expect(parseTerminalKey('\x1b[999~')).toBeUndefined();
    expect(parseTerminalKey('\x1b[200~')).toBeUndefined();
    expect(parseTerminalKey('\x1b[?1;2c')).toBeUndefined();
  });
});
