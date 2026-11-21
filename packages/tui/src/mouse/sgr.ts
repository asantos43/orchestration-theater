// SPDX-License-Identifier: MPL-2.0

/**
 * The mouse reports of the terminal in SGR form (`ESC [ < b ; x ; y M` for a press and `m` for a
 * release, `?1006`), read out of the bytes the keyboard shares the line with (N34). Pure: the parser
 * takes chunks as they come, gives back the events and the text that is not mouse, and holds what
 * is cut in the middle until the next chunk. No byte of a report ever goes on as text, so neither
 * the text box nor the keymap sees one.
 */

export type MouseButton = 'left' | 'middle' | 'right' | 'none';
export type WheelDirection = 'up' | 'down' | 'left' | 'right';

export interface MouseEvent {
  /** `press` and `release` of a button, `drag` (moved with a button down), `move` (no button), `wheel`. */
  readonly action: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  readonly button: MouseButton;
  /** Set when `action` is `wheel`. */
  readonly wheel?: WheelDirection | undefined;
  /** 0-based column and row of the terminal (the report counts from 1). */
  readonly col: number;
  readonly row: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

// eslint-disable-next-line no-control-regex
const REPORT = /^\x1b\[<(\d{1,6});(\d{1,6});(\d{1,6})([Mm])/;
// A report that stopped before its end: `ESC`, `ESC [`, `ESC [ <`, `ESC [ < 3 ; 12`...
// eslint-disable-next-line no-control-regex
const REPORT_PREFIX = /^\x1b(?:\[(?:<\d*(?:;\d*){0,2})?)?$/;

const BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right', 'none'];
const WHEELS: readonly WheelDirection[] = ['up', 'down', 'left', 'right'];

/** One report decoded: `code` is the button field, `final` is `M` or `m`. */
export function decodeReport(
  code: number,
  column: number,
  row: number,
  final: 'M' | 'm',
): MouseEvent {
  const low = code & 3;
  const base = {
    col: Math.max(0, column - 1),
    row: Math.max(0, row - 1),
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
  if ((code & 64) !== 0) {
    return { ...base, action: 'wheel', button: 'none', wheel: WHEELS[low] };
  }
  const button = BUTTONS[low] ?? 'none';
  if ((code & 32) !== 0) {
    return { ...base, action: button === 'none' ? 'move' : 'drag', button };
  }
  return { ...base, action: final === 'm' ? 'release' : 'press', button };
}

/** The bytes of a report, as a terminal writes them (for the tests and for the recordings). */
export function sgrReport(event: {
  readonly action: MouseEvent['action'];
  readonly button?: MouseButton | undefined;
  readonly wheel?: WheelDirection | undefined;
  readonly col: number;
  readonly row: number;
  readonly shift?: boolean | undefined;
  readonly alt?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
}): string {
  let code: number;
  if (event.action === 'wheel') code = 64 + Math.max(0, WHEELS.indexOf(event.wheel ?? 'up'));
  else {
    code = Math.max(0, BUTTONS.indexOf(event.button ?? 'left'));
    if (event.action === 'drag' || event.action === 'move') code |= 32;
  }
  if (event.shift === true) code |= 4;
  if (event.alt === true) code |= 8;
  if (event.ctrl === true) code |= 16;
  const final = event.action === 'release' ? 'm' : 'M';
  return `${ESC}[<${String(code)};${String(event.col + 1)};${String(event.row + 1)}${final}`;
}

export interface SgrFeed {
  readonly events: readonly MouseEvent[];
  /** Everything of the chunk that is not a report, in order. */
  readonly text: string;
}

/** How many characters at the end of `text` start `marker` (the longest such tail, short of all of it). */
function partialTail(text: string, marker: string): number {
  for (let size = Math.min(marker.length - 1, text.length); size > 0; size -= 1) {
    if (marker.startsWith(text.slice(text.length - size))) return size;
  }
  return 0;
}

export class SgrMouseParser {
  #held = '';
  #inPaste = false;

  /** Something is held: the end of a chunk that may be the start of a report. */
  get holding(): boolean {
    return this.#held !== '';
  }

  push(chunk: string): SgrFeed {
    const data = this.#held + chunk;
    this.#held = '';
    const events: MouseEvent[] = [];
    let text = '';
    let at = 0;
    while (at < data.length) {
      if (this.#inPaste) {
        // What is pasted is text, even when it looks like a report.
        const end = data.indexOf(PASTE_END, at);
        if (end === -1) {
          const keep = partialTail(data.slice(at), PASTE_END);
          text += data.slice(at, data.length - keep);
          this.#held = data.slice(data.length - keep);
          break;
        }
        text += data.slice(at, end + PASTE_END.length);
        at = end + PASTE_END.length;
        this.#inPaste = false;
        continue;
      }
      const esc = data.indexOf(ESC, at);
      if (esc === -1) {
        text += data.slice(at);
        break;
      }
      text += data.slice(at, esc);
      const rest = data.slice(esc);
      const report = REPORT.exec(rest);
      if (report !== null) {
        events.push(
          decodeReport(
            Number(report[1]),
            Number(report[2]),
            Number(report[3]),
            report[4] === 'm' ? 'm' : 'M',
          ),
        );
        at = esc + report[0].length;
        continue;
      }
      if (rest.startsWith(PASTE_START)) {
        text += PASTE_START;
        at = esc + PASTE_START.length;
        this.#inPaste = true;
        continue;
      }
      if (REPORT_PREFIX.test(rest) || PASTE_START.startsWith(rest)) {
        this.#held = rest;
        break;
      }
      text += ESC;
      at = esc + 1;
    }
    return { events, text };
  }

  /** Gives back what is held (a lone Esc, a cut that never ended) as text, and holds nothing. */
  flush(): string {
    const held = this.#held;
    this.#held = '';
    return held;
  }
}
