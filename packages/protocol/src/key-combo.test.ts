// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { formatKeyCombo, isKeyCombo, normalizeKeyCombo, parseKeyCombo } from './key-combo.js';

describe('key combination', () => {
  it('writes the canonical form: modifiers in a fixed order, the key in upper case', () => {
    expect(normalizeKeyCombo('alt+s')).toBe('Alt+S');
    expect(normalizeKeyCombo('shift+ctrl+left')).toBe('Ctrl+Shift+Left');
    expect(normalizeKeyCombo('Option+K')).toBe('Alt+K');
    expect(normalizeKeyCombo('Control+Q')).toBe('Ctrl+Q');
    expect(normalizeKeyCombo('Command+C')).toBe('Cmd+C');
    expect(normalizeKeyCombo('f1')).toBe('F1');
    expect(normalizeKeyCombo('Ctrl+→')).toBe('Ctrl+Right');
    expect(normalizeKeyCombo('Alt+Plus')).toBe('Alt+Plus');
  });

  it('parses the modifiers and the key', () => {
    expect(parseKeyCombo('Ctrl+Shift+Left')).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      cmd: false,
      key: 'Left',
    });
    const combo = parseKeyCombo('Alt+S');
    expect(combo && formatKeyCombo(combo)).toBe('Alt+S');
  });

  it('refuses what is not a combination', () => {
    for (const text of [
      '',
      'Ctrl+',
      '+S',
      'Ctrl+Ctrl+S',
      'Hyper+S',
      'Alt+Foo',
      'Alt+SS',
      'Alt+ ',
    ]) {
      expect(isKeyCombo(text), text).toBe(false);
    }
  });
});
