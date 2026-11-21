// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { breakLine, cellWidth } from './text.js';

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
