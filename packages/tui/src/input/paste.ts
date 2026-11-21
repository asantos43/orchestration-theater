// SPDX-License-Identifier: MPL-2.0
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InputSettings } from './settings.js';

/**
 * What the box does with a paste (N35): bracketed paste arrives as one string; a long one becomes a
 * marker plus an attachment, and a path of an existing file becomes an attachment.
 */

/** The line breaks as `\n` (a terminal pastes `\r` or `\r\n`). */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The pasted text as the box shows it: `\n` lines, tabs as spaces, no control characters. */
export function sanitizeForBox(text: string): string {
  return (
    normalizeNewlines(text)
      .replace(/\t/g, '    ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
  );
}

export function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export type PasteKind = 'inline' | 'marker';

/** Whether a paste goes into the box as it is, or becomes a marker and an attachment. */
export function classifyPaste(text: string, settings: InputSettings['paste']): PasteKind {
  if (settings.mode === 'inline') return 'inline';
  return countLines(text) > settings.lines || text.length > settings.chars ? 'marker' : 'inline';
}

/**
 * The words of `text`, as a shell would split them: spaces or line breaks separate them, quotes
 * group them and a backslash escapes the next character (a file dropped on a terminal comes as
 * `'/home/a b/c.png'` or `/home/a\ b/c.png`). `escapes: false` leaves the backslashes alone (the
 * paths of Windows). `undefined` when a quote is not closed.
 */
export function splitShellWords(text: string, escapes = true): string[] | undefined {
  const words: string[] = [];
  let current: string | undefined;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current = (current ?? '') + char;
    } else if (escapes && char === '\\' && i + 1 < text.length && /[^\n]/.test(text[i + 1] ?? '')) {
      // Inside double quotes a backslash only escapes `"`, `\` and `$`.
      const next = text[i + 1] ?? '';
      if (quote === '"' && !'"\\$'.includes(next)) current = (current ?? '') + char;
      else {
        current = (current ?? '') + next;
        i += 1;
      }
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else current = (current ?? '') + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current ??= '';
    } else if (/\s/.test(char)) {
      if (current !== undefined) words.push(current);
      current = undefined;
    } else {
      current = (current ?? '') + char;
    }
  }
  if (quote !== undefined) return undefined;
  if (current !== undefined) words.push(current);
  return words;
}

export interface PathOptions {
  readonly homedir: string;
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * The paths a paste is made of, or `undefined` when it is not only paths. A path is absolute, `~/`
 * or `file://`; anything else in the paste (a sentence, a relative name) makes it plain text.
 */
export function parsePastedPaths(text: string, options: PathOptions): string[] | undefined {
  const trimmed = normalizeNewlines(text).trim();
  if (trimmed === '' || trimmed.length > 16_384) return undefined;
  const words = splitShellWords(trimmed, options.platform !== 'win32');
  if (words === undefined || words.length === 0 || words.length > 32) return undefined;
  const paths: string[] = [];
  for (const word of words) {
    const path = toPath(word, options);
    if (path === undefined) return undefined;
    paths.push(path);
  }
  return paths;
}

function toPath(word: string, options: PathOptions): string | undefined {
  if (word.startsWith('file://')) {
    try {
      return fileURLToPath(word);
    } catch {
      return undefined;
    }
  }
  if (word === '~' || word.startsWith('~/')) {
    return options.homedir === '' ? undefined : `${options.homedir}${word.slice(1)}`;
  }
  if (isAbsolute(word) || (options.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(word))) {
    return word;
  }
  return undefined;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** True when the file name says it is an image the agents can look at. */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** The name of a path, for the line of attachments. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}
