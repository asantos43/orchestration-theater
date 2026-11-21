// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { EMPTY_LINE, editLine, lineOf, printableText, splitAtCursor } from './line-input.js';

const text = (data: string) => ({ combo: undefined, data });
const key = (combo: string) => ({ combo, data: '' });

describe('the line field of the forms', () => {
  it('types and pastes text at the cursor', () => {
    let state = editLine(EMPTY_LINE, text('abc'));
    expect(state).toEqual({ value: 'abc', cursor: 3 });
    state = editLine(editLine(state, key('Left')), text('X'));
    expect(state).toEqual({ value: 'abXc', cursor: 3 });
    expect(editLine(EMPTY_LINE, text('one\ntwo\r\nthree')).value).toBe('one two three');
  });

  it('moves, deletes and cuts', () => {
    const state = lineOf('one two three');
    expect(editLine(state, key('Backspace')).value).toBe('one two thre');
    expect(editLine(state, key('Ctrl+W')).value).toBe('one two ');
    expect(editLine(editLine(state, key('Home')), key('Delete')).value).toBe('ne two three');
    expect(editLine({ value: 'abcdef', cursor: 3 }, key('Ctrl+U'))).toEqual({
      value: 'def',
      cursor: 0,
    });
    expect(editLine({ value: 'abcdef', cursor: 3 }, key('Ctrl+K'))).toEqual({
      value: 'abc',
      cursor: 3,
    });
  });

  it('keeps the same state for what is not for the field, so the caller can tell', () => {
    const state = lineOf('a');
    expect(editLine(state, { combo: undefined, data: '\u001b[99~' })).toBe(state);
    expect(editLine(state, { combo: 'F5', data: '\u001b[15~' })).toBe(state);
    expect(editLine(EMPTY_LINE, key('Backspace'))).toBe(EMPTY_LINE);
    expect(editLine(lineOf('a'), key('Right'))).toEqual(lineOf('a'));
  });

  it('counts characters, not bytes, so an accent or an emoji is one step', () => {
    const state = lineOf('ação');
    expect(state.cursor).toBe(4);
    expect(editLine(state, key('Backspace')).value).toBe('açã');
    expect(splitAtCursor({ value: 'ação', cursor: 1 })).toEqual({
      before: 'a',
      under: 'ç',
      after: 'ão',
    });
    expect(splitAtCursor(lineOf('ab'))).toEqual({ before: 'ab', under: ' ', after: '' });
  });

  it('takes the control characters out of what is pasted', () => {
    expect(printableText('a\u0000b\u007fc\td')).toBe('abc d');
  });
});
