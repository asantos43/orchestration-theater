// SPDX-License-Identifier: MPL-2.0
import { SgrMouseParser, type MouseEvent } from './sgr.js';

/**
 * Takes the mouse reports out of the bytes Ink reads from the keyboard (N34). Ink reads with
 * `stdin.read()` and throws away the reports it cannot name, so they would never reach us there.
 * The tap stands in front of `read`: what it returns is the same text without the reports, and the
 * reports go to `onEvent`. What is cut in the middle of a report is held until the rest comes; a
 * hold that is not completed within `holdMs` (a lone Esc, which is a key) is let go to Ink.
 */

/** The part of a stream the tap needs. */
export interface TappableStdin {
  read(size?: number): string | Buffer | null;
  emit(event: 'readable'): boolean;
}

export interface TapOptions {
  readonly holdMs?: number | undefined;
  readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
  readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export const DEFAULT_HOLD_MS = 20;

/** Starts the tap; returns the function that puts `read` back. */
export function tapStdin(
  stdin: TappableStdin,
  onEvent: (event: MouseEvent) => void,
  options: TapOptions = {},
): () => void {
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with `stdin` as `this`
  const original = stdin.read;
  const own = Object.hasOwn(stdin, 'read');
  const parser = new SgrMouseParser();
  let released = '';
  let timer: unknown;

  const stop = (): void => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const arm = (): void => {
    stop();
    if (!parser.holding) return;
    timer = setTimer(() => {
      timer = undefined;
      const held = parser.flush();
      if (held === '') return;
      released += held;
      stdin.emit('readable');
    }, holdMs);
  };

  const tapped = (size?: number): string | Buffer | null => {
    if (released !== '') {
      const out = released;
      released = '';
      return out;
    }
    for (;;) {
      const chunk = original.call(stdin, size);
      if (chunk === null) return null;
      const feed = parser.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      for (const event of feed.events) onEvent(event);
      arm();
      if (feed.text !== '') return feed.text;
    }
  };
  stdin.read = tapped;
  return () => {
    stop();
    if (stdin.read !== tapped) return;
    if (own) stdin.read = original;
    else delete (stdin as { read?: unknown }).read;
  };
}
