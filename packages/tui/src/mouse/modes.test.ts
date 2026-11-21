// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { MOUSE_DISABLE_SEQUENCE, MouseModes, mouseEnableSequence } from './modes.js';

describe('mouse modes', () => {
  it('asks for the clicks, the drags and the SGR form in full, and for less in wheel', () => {
    expect(mouseEnableSequence('full')).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    expect(mouseEnableSequence('wheel')).toBe('\x1b[?1000h\x1b[?1006h');
    expect(mouseEnableSequence('off')).toBe('');
  });

  it('writes them on once and off once', () => {
    const written: string[] = [];
    const modes = new MouseModes({ write: (text) => written.push(text) }, 'full');
    modes.enable();
    modes.enable();
    expect(modes.enabled).toBe(true);
    modes.disable();
    modes.disable();
    expect(modes.enabled).toBe(false);
    expect(written).toEqual([mouseEnableSequence('full'), MOUSE_DISABLE_SEQUENCE]);
  });

  it('writes nothing when the mouse is off', () => {
    const written: string[] = [];
    const modes = new MouseModes({ write: (text) => written.push(text) }, 'off');
    modes.enable();
    modes.disable();
    expect(written).toEqual([]);
  });

  it('turns off the SGR form last, as it was turned on last', () => {
    expect(MOUSE_DISABLE_SEQUENCE).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
  });
});
