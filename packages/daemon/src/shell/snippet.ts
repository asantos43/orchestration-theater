// SPDX-License-Identifier: MPL-2.0
import type { SnippetKeepMode } from '../shell-config.js';

/**
 * The cut of the output of a `!` command into the snippet the chat shows and the Director reads
 * (architecture 5.19, `terminal.snippet.max_lines`). Pure.
 */

/**
 * The longest line of a snippet, in characters; a longer one is cut with an ellipsis (the log
 * keeps it whole). [proposta] Not a config key: it is a guard so one minified file does not fill the
 * snippet, as `DRAIN_MS` is for the pipes; `terminal.snippet.max_lines` is the limit of the work.
 */
export const MAX_LINE_CHARS = 4096;

// eslint-disable-next-line no-control-regex -- the escape character is what the sequences start with
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- see above
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * What a person reads of the raw output: no colour or cursor sequences, `\r\n` as `\n`, and a
 * line redrawn with a lone `\r` (a progress bar) reduced to its last version.
 */
export function cleanOutput(raw: string): string {
  const text = raw.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(/\r\n/g, '\n');
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      const redrawn = line.split('\r');
      return redrawn[redrawn.length - 1] ?? '';
    })
    .join('\n');
}

/** The lines of an output; the newline that ends the last one does not start another. */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface Snippet {
  /** The kept lines, joined with `\n` (empty when the output was). */
  readonly text: string;
  readonly totalLines: number;
  readonly shownLines: number;
  readonly keep: SnippetKeepMode;
}

/** Keeps `maxLines` lines of the output, from its end (`tail`) or its start (`head`). */
export function cutSnippet(raw: string, maxLines: number, keep: SnippetKeepMode): Snippet {
  const lines = linesOf(cleanOutput(raw));
  const kept =
    lines.length <= maxLines
      ? lines
      : keep === 'tail'
        ? lines.slice(-maxLines)
        : lines.slice(0, maxLines);
  const text = kept
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line))
    .join('\n');
  return { text, totalLines: lines.length, shownLines: kept.length, keep };
}

/**
 * A prompt left on the last line, with no newline after it: `Continue? `, `Password:`, `name> `,
 * `[y/N] `.
 */
const PROMPT_TAIL = /(?:[?:>\]]|\([yn]\/[yn]\)|\[[yn]\/[yn]\])\s*$/i;

/**
 * What programs say when they ask for input and get the end of the file instead. Looked for in the
 * last lines of a command that failed.
 */
const END_OF_INPUT =
  /\bEOFError\b|\bEOF\b|end of (?:file|input|stdin)|unexpected end of|not (?:from )?a (?:tty|terminal)|no tty|a terminal is required|inappropriate ioctl for device|stdin (?:is )?(?:closed|not)|reading from stdin|input is not a/i;

/** The last lines the second rule looks at. */
const END_OF_INPUT_WINDOW = 5;

/**
 * [proposta] Whether a command seems to have waited for input and got the end of the file (stdin
 * is closed, so it never waits for long). A heuristic, not a fact: it looks at the output, because
 * the daemon cannot see a process read its stdin. Two signs: the output ends with a prompt and no
 * newline (the program printed the question and then read), or the command failed and its last
 * lines say it found no input. A program that reads silently and goes on is not caught.
 */
export function seemsToAskForInput(raw: string, exitCode: number | null): boolean {
  const text = cleanOutput(raw);
  if (text === '') return false;
  if (!text.endsWith('\n')) {
    const last = text.slice(text.lastIndexOf('\n') + 1);
    if (last.trim() !== '' && PROMPT_TAIL.test(last)) return true;
  }
  if (exitCode === 0 || exitCode === null) return false;
  return linesOf(text)
    .slice(-END_OF_INPUT_WINDOW)
    .some((line) => END_OF_INPUT.test(line));
}
