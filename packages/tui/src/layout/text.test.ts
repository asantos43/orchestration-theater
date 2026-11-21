// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { breakLine, cellWidth, clipStart } from './text.js';

describe('breakLine', () => {
  it('leaves a line that fits as it is, with its spaces', () => {
    expect(breakLine('  a  b', 10)).toEqual(['  a  b']);
    expect(breakLine('', 10)).toEqual(['']);
  });

  it('breaks exactly where the width ends and keeps every space', () => {
    expect(breakLine('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(breakLine('ab  cd  ef', 4)).toEqual(['ab  ', 'cd  ', 'ef']);
  });

  it('counts the cells of a wide character, and always moves on', () => {
    const pieces = breakLine('日本語日本語', 5);
    expect(pieces.join('')).toBe('日本語日本語');
    for (const piece of pieces) expect(cellWidth(piece)).toBeLessThanOrEqual(5);
    // A width of zero or one cell still ends.
    expect(breakLine('abc', 0)).toEqual(['a', 'b', 'c']);
    expect(breakLine('日日', 1).join('')).toBe('日日');
  });
});

describe('clipStart', () => {
  it('keeps a text that fits', () => {
    expect(clipStart('/tmp/repo', 9)).toBe('/tmp/repo');
    expect(clipStart('', 3)).toBe('');
  });

  it('keeps the end after an ellipsis, in the width', () => {
    expect(clipStart('/private/var/folders/repo', 8)).toBe('…rs/repo');
    expect(cellWidth(clipStart('/private/var/folders/repo', 8))).toBeLessThanOrEqual(8);
    expect(clipStart('abcdef', 1)).toBe('…');
    expect(clipStart('abcdef', 0)).toBe('');
  });

  it('counts wide characters by their cells', () => {
    expect(clipStart('ab漢字', 4)).toBe('…字');
  });
});
