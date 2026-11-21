// SPDX-License-Identifier: MPL-2.0
import type { MouseMode } from '../settings.js';

/**
 * The terminal modes of the mouse (N34): `?1000` reports presses, releases and the wheel, `?1002`
 * adds the moves while a button is down (the drag of the edge, the selection), and `?1006` asks for
 * the reports in the form that has no limit of columns (`ESC [ < b ; x ; y M`). In `wheel` mode only
 * what the wheel needs is on. The terminal keeps its own selection when the mouse is `off` (and
 * under Shift in the others, in most terminals).
 */

/** The sequence that turns the mouse reports on for `mode`; empty for `off`. */
export function mouseEnableSequence(mode: MouseMode): string {
  if (mode === 'off') return '';
  return mode === 'full' ? '\x1b[?1000h\x1b[?1002h\x1b[?1006h' : '\x1b[?1000h\x1b[?1006h';
}

/** Turns all of them off, whatever was on: safe to write twice. */
export const MOUSE_DISABLE_SEQUENCE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/** Where the sequences are written: the terminal of the TUI. */
export interface MouseTerminal {
  write(text: string): void;
}

/** Keeps track of whether the modes are on, so each way out writes them off once and never more. */
export class MouseModes {
  #on = false;
  constructor(
    private readonly terminal: MouseTerminal,
    private readonly mode: MouseMode,
  ) {}

  get enabled(): boolean {
    return this.#on;
  }

  enable(): void {
    const sequence = mouseEnableSequence(this.mode);
    if (this.#on || sequence === '') return;
    this.#on = true;
    this.terminal.write(sequence);
  }

  disable(): void {
    if (!this.#on) return;
    this.#on = false;
    this.terminal.write(MOUSE_DISABLE_SEQUENCE);
  }
}
