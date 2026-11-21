// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  baseName,
  classifyPaste,
  countLines,
  isImagePath,
  normalizeNewlines,
  parsePastedPaths,
  sanitizeForBox,
  splitShellWords,
} from './paste.js';
import { DEFAULT_INPUT_SETTINGS } from './settings.js';

const rules = DEFAULT_INPUT_SETTINGS.paste;
const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${String(i)}`).join('\n');

describe('paste', () => {
  it('turns the line breaks of a terminal into `\\n`', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(sanitizeForBox('a\tb\u001b[31m\u0007')).toBe('a    b[31m');
  });

  it('counts the lines of a text, not the last empty one', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('keeps a short paste in the box and makes a marker of a long one', () => {
    expect(classifyPaste(lines(10), rules)).toBe('inline');
    expect(classifyPaste(lines(11), rules)).toBe('marker');
    expect(classifyPaste(lines(2000), rules)).toBe('marker');
    expect(classifyPaste('x'.repeat(2000), rules)).toBe('inline');
    expect(classifyPaste('x'.repeat(2001), rules)).toBe('marker');
  });

  it('keeps everything in the box with `paste.mode: inline`', () => {
    expect(classifyPaste(lines(2000), { ...rules, mode: 'inline' })).toBe('inline');
  });

  describe('paths', () => {
    const options = { homedir: '/home/ana', platform: 'linux' as const };

    it('splits words as a shell does', () => {
      expect(splitShellWords('/a/b.png \'/c d/e.png\' /f\\ g/h.png "/i j/k"')).toEqual([
        '/a/b.png',
        '/c d/e.png',
        '/f g/h.png',
        '/i j/k',
      ]);
      expect(splitShellWords("'open")).toBeUndefined();
      expect(splitShellWords('a\nb')).toEqual(['a', 'b']);
    });

    it('reads absolute paths, home paths and file:// URLs', () => {
      expect(parsePastedPaths('/tmp/a.png', options)).toEqual(['/tmp/a.png']);
      expect(parsePastedPaths("'/tmp/a b.png'\n/tmp/c.txt", options)).toEqual([
        '/tmp/a b.png',
        '/tmp/c.txt',
      ]);
      expect(parsePastedPaths('~/doc.md', options)).toEqual(['/home/ana/doc.md']);
      expect(parsePastedPaths('file:///tmp/a%20b.png', options)).toEqual(['/tmp/a b.png']);
    });

    it('is not a paste of paths when something else is in it', () => {
      expect(parsePastedPaths('see /tmp/a.png', options)).toBeUndefined();
      expect(parsePastedPaths('docs/a.png', options)).toBeUndefined();
      expect(parsePastedPaths('   ', options)).toBeUndefined();
      expect(parsePastedPaths('~/a', { homedir: '', platform: 'linux' })).toBeUndefined();
      expect(parsePastedPaths('C:\\a\\b.png', { ...options, platform: 'win32' })).toEqual([
        'C:\\a\\b.png',
      ]);
    });
  });

  it('knows an image by its extension and a file by its name', () => {
    expect(isImagePath('/a/B.PNG')).toBe(true);
    expect(isImagePath('/a/b.txt')).toBe(false);
    expect(isImagePath('/a/noext')).toBe(false);
    expect(baseName('/a/b/c.txt')).toBe('c.txt');
    expect(baseName('C:\\a\\c.txt')).toBe('c.txt');
  });
});
