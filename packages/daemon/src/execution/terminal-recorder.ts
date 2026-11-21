// SPDX-License-Identifier: MPL-2.0
import type { NormalizedUpdate } from '@otheater/core';
import { TERMINAL_BLOCK_BYTES, type TerminalOutputPayload } from '@otheater/protocol';
import { maskSecrets } from './continuation-package.js';
import type { TerminalOutputSettings } from './settings.js';

/** What the recorder hands out: the payload of one `terminal.output`, without the correlation fields. */
export type TerminalBlock = Omit<
  TerminalOutputPayload,
  'sessionId' | 'playId' | 'demandId' | 'attemptId'
>;

type TerminalUpdate = Extract<NormalizedUpdate, { kind: 'terminal_output' }>;

/** The start of a private key: it must not be cut from its body (see {@link safeCut}). */
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

interface Terminal {
  readonly toolCallId: string | undefined;
  /** Text received and not written yet: the last line may still be growing, and a secret may cross a chunk. */
  held: string;
  /** Bytes of text written for this terminal (after the mask). */
  written: number;
  /** Bytes the cut left out. */
  omitted: number;
}

/**
 * Turns the live output of the terminals of one attempt into `terminal.output` blocks (Phase 8,
 * P11, N200 item 3). It is pure and synchronous: the attempt runner hands it every `terminal_output`
 * update, writes what `push` and `flush` return, and calls `flush` when the turn ends.
 *
 * - The text is masked with `maskSecrets` (the same net as the continuation package). A secret
 *   can reach the daemon split across two chunks, so the text is held until a line ends (or the
 *   held part is as large as a block, or the command ended, or `flush` asks) and the mask runs on
 *   whole lines. A private key is held until its end line arrives (or `flush`).
 * - A block is at most {@link TERMINAL_BLOCK_BYTES} of text.
 * - `events.terminal_output: truncated`: after `maxBytes` of one terminal, the rest is left out; the
 *   block the cut falls in is marked `truncated`, and the end of the terminal tells how much was left out.
 * - `off` writes nothing. `on` has no limit.
 */
export class TerminalRecorder {
  readonly #settings: () => TerminalOutputSettings;
  readonly #terminals = new Map<string, Terminal>();

  constructor(settings: () => TerminalOutputSettings) {
    this.#settings = settings;
  }

  /** Takes one update; gives the blocks that are ready to be written, in order. */
  push(update: TerminalUpdate): TerminalBlock[] {
    const { mode } = this.#settings();
    if (mode === 'off') return [];
    let terminal = this.#terminals.get(update.terminalId);
    if (terminal === undefined) {
      terminal = { toolCallId: update.toolCallId, held: '', written: 0, omitted: 0 };
      this.#terminals.set(update.terminalId, terminal);
    }
    const out: TerminalBlock[] = [];
    if (update.text !== undefined) {
      terminal.held += update.text;
      const ready = safeCut(terminal.held);
      if (ready > 0) {
        this.#emit(update.terminalId, terminal, terminal.held.slice(0, ready), out);
        terminal.held = terminal.held.slice(ready);
      }
    }
    if (update.exit !== undefined) {
      this.#finish(update.terminalId, terminal, update.exit, out);
      this.#terminals.delete(update.terminalId);
    }
    return out;
  }

  /** The turn or the session ended: whatever is held goes out, and a terminal with no exit ends here. */
  flush(): TerminalBlock[] {
    const out: TerminalBlock[] = [];
    for (const [terminalId, terminal] of this.#terminals)
      this.#finish(terminalId, terminal, undefined, out);
    this.#terminals.clear();
    return out;
  }

  #finish(
    terminalId: string,
    terminal: Terminal,
    exit: TerminalUpdate['exit'],
    out: TerminalBlock[],
  ): void {
    if (terminal.held !== '') {
      this.#emit(terminalId, terminal, terminal.held, out);
      terminal.held = '';
    }
    const note = terminal.omitted > 0 ? { truncated: true, omittedBytes: terminal.omitted } : {};
    if (exit === undefined) {
      // No exit was told: the closing note is the only thing left to say, if the output was cut.
      if (terminal.omitted > 0) out.push(this.#block(terminalId, terminal, '', note));
      return;
    }
    const closing = { ...note, exitCode: exit.code, signal: exit.signal };
    const last = out[out.length - 1];
    if (last?.terminalId === terminalId && terminal.omitted === 0) {
      // The last block of this terminal carries the exit.
      Object.assign(last, closing);
    } else {
      out.push(this.#block(terminalId, terminal, '', closing));
    }
  }

  #emit(terminalId: string, terminal: Terminal, raw: string, out: TerminalBlock[]): void {
    const { mode, maxBytes } = this.#settings();
    let text = maskSecrets(raw);
    if (text === '') return;
    let cutHere = false;
    if (mode === 'truncated') {
      const room = Math.max(0, maxBytes - terminal.written);
      const size = Buffer.byteLength(text);
      if (size > room) {
        const kept = takeBytes(text, room);
        terminal.omitted += size - Buffer.byteLength(kept);
        text = kept;
        cutHere = true;
      }
    }
    if (text === '') return;
    terminal.written += Buffer.byteLength(text);
    for (const piece of blocksOf(text)) {
      out.push(this.#block(terminalId, terminal, piece, {}));
    }
    if (cutHere) {
      const last = out[out.length - 1];
      if (last?.terminalId === terminalId) last.truncated = true;
    }
  }

  #block(
    terminalId: string,
    terminal: Terminal,
    text: string,
    extra: Partial<TerminalBlock>,
  ): TerminalBlock {
    return {
      terminalId,
      ...(terminal.toolCallId === undefined ? {} : { toolCallId: terminal.toolCallId }),
      text,
      ...extra,
    };
  }
}

/**
 * How much of `text` can be written now: up to the last line break, and not past the start of a
 * private key that has not ended. A held text with no line break that is as large as a block goes
 * whole, so a command that never breaks a line still shows up.
 */
function safeCut(text: string): number {
  let end = text.lastIndexOf('\n') + 1;
  for (const match of text.matchAll(KEY_BEGIN)) {
    const start = match.index;
    if (!KEY_END.test(text.slice(start))) {
      end = Math.min(end, text.lastIndexOf('\n', start - 1) + 1);
      break;
    }
  }
  if (
    end === 0 &&
    Buffer.byteLength(text) >= TERMINAL_BLOCK_BYTES &&
    !text.includes('-----BEGIN')
  ) {
    return text.length;
  }
  return end;
}

/** The longest start of `text` that fits in `bytes`, never in the middle of a character. */
function takeBytes(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  let used = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    used += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** `text` in pieces of at most {@link TERMINAL_BLOCK_BYTES}. */
function blocksOf(text: string): string[] {
  if (Buffer.byteLength(text) <= TERMINAL_BLOCK_BYTES) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest !== '') {
    const piece = takeBytes(rest, TERMINAL_BLOCK_BYTES);
    pieces.push(piece);
    rest = rest.slice(piece.length);
  }
  return pieces;
}
