// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  blendHex,
  OTHEATER_PALETTE,
  paletteOf,
  TERMINAL_PALETTE,
  TOKEN,
  TOKEN_NAMES,
} from './palette.js';

describe('the palette of ui.theme', () => {
  it('has otheater (the mockup) and terminal (the 16 colours of the terminal)', () => {
    expect(paletteOf('otheater')).toBe(OTHEATER_PALETTE);
    expect(paletteOf('terminal')).toBe(TERMINAL_PALETTE);
    expect(OTHEATER_PALETTE.mode).toBe('otheater');
    expect(TERMINAL_PALETTE.mode).toBe('terminal');
  });

  it('otheater: the colours of the mockup in hex', () => {
    const colors: Record<string, string> = {
      text: '#c9ced6',
      border: '#3a4150',
      borderActive: '#7d8cff',
      title: '#e6e8ec',
      titleActive: '#aab4ff',
      dim: '#6b7380',
      hint: '#9aa3af',
      accent: '#8f9cff',
      ok: '#4fc98f',
      warn: '#e8a948',
      error: '#ef6b6b',
      sys: '#b4a6ff',
      you: '#7cc4ff',
      header: '#3a46a8',
      headerKey: '#ffd479',
      keyBackground: '#2b3140',
      selected: '#232a44',
    };
    for (const [name, hex] of Object.entries(colors)) {
      expect(OTHEATER_PALETTE.resolve(`@${name}`), name).toBe(hex);
    }
  });

  it('terminal: the named colours the TUI had, and nothing for what the terminal draws', () => {
    expect(TERMINAL_PALETTE.resolve(TOKEN.border)).toBe('gray');
    expect(TERMINAL_PALETTE.resolve(TOKEN.borderActive)).toBe('blueBright');
    expect(TERMINAL_PALETTE.resolve(TOKEN.ok)).toBe('green');
    expect(TERMINAL_PALETTE.resolve(TOKEN.warn)).toBe('yellow');
    expect(TERMINAL_PALETTE.resolve(TOKEN.error)).toBe('red');
    expect(TERMINAL_PALETTE.resolve(TOKEN.sys)).toBe('magenta');
    expect(TERMINAL_PALETTE.resolve(TOKEN.you)).toBe('cyanBright');
    expect(TERMINAL_PALETTE.resolve(TOKEN.text)).toBeUndefined();
    expect(TERMINAL_PALETTE.resolve(TOKEN.dim)).toBeUndefined();
    expect(TERMINAL_PALETTE.paintsDim).toBe(false);
    expect(OTHEATER_PALETTE.paintsDim).toBe(true);
  });

  it('every role has a token, and a value that is not a role stays as it is', () => {
    for (const name of TOKEN_NAMES) expect(TOKEN[name]).toBe(`@${name}`);
    for (const palette of [OTHEATER_PALETTE, TERMINAL_PALETTE]) {
      expect(palette.resolve(undefined)).toBeUndefined();
      expect(palette.resolve('#123456')).toBe('#123456');
      expect(palette.resolve('green')).toBe('green');
      expect(palette.resolve('@nope')).toBe('@nope');
    }
  });

  it('the seven-day bars are the colour at opacity .6 over the background of the mockup', () => {
    expect(blendHex('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(blendHex('green', '#000000', 0.5)).toBe('green');
    expect(OTHEATER_PALETTE.fade('#4fc98f')).toBe('#368160');
    expect(OTHEATER_PALETTE.fade('#e8a948')).toBe('#926d36');
    expect(OTHEATER_PALETTE.fade('#ef6b6b')).toBe('#96484b');
    expect(TERMINAL_PALETTE.fade('green')).toBe('green');
  });
});
