// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { sliceCells } from '../layout/text.js';
import { isEmptySelection, rowSpan, selectedText, selectionRange } from './selection.js';

describe('selection', () => {
  it('puts the two ends in reading order', () => {
    const range = selectionRange({ anchor: { x: 5, y: 3 }, head: { x: 2, y: 1 } });
    expect(range).toEqual({ start: { x: 2, y: 1 }, end: { x: 5, y: 3 } });
    expect(selectionRange({ anchor: { x: 9, y: 2 }, head: { x: 1, y: 2 } }).start.x).toBe(1);
  });

  it('knows a selection that did not leave its cell', () => {
    expect(isEmptySelection({ anchor: { x: 1, y: 1 }, head: { x: 1, y: 1 } })).toBe(true);
    expect(isEmptySelection({ anchor: { x: 1, y: 1 }, head: { x: 2, y: 1 } })).toBe(false);
  });

  it('chooses to the end of the rows in the middle of a range', () => {
    const range = { start: { x: 4, y: 0 }, end: { x: 2, y: 2 } };
    expect(rowSpan(range, 0, 10)).toEqual([4, 10]);
    expect(rowSpan(range, 1, 10)).toEqual([0, 10]);
    expect(rowSpan(range, 2, 10)).toEqual([0, 3]);
    expect(rowSpan(range, 3, 10)).toBeUndefined();
  });

  it('reads the text of a range out of the rows', () => {
    const rows = ['hello world   ', 'second line   ', 'third'];
    expect(selectedText(rows, { start: { x: 6, y: 0 }, end: { x: 5, y: 1 } }, 14)).toBe(
      'world\nsecond',
    );
    expect(selectedText(rows, { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }, 14)).toBe('hello');
    expect(selectedText(rows, { start: { x: 3, y: 2 }, end: { x: 9, y: 2 } }, 14)).toBe('rd');
  });

  it('counts cells, not characters, for wide letters', () => {
    expect(sliceCells('日本語abc', 2, 6)).toBe('本語');
    expect(sliceCells('abc', 1, 2)).toBe('b');
    expect(selectedText(['日本語'], { start: { x: 0, y: 0 }, end: { x: 3, y: 0 } }, 6)).toBe(
      '日本',
    );
  });
});
