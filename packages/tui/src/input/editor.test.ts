// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  atomRanges,
  createEditor,
  deleteBackward,
  deleteForward,
  insert,
  killToLineEnd,
  killToLineStart,
  killWordBackward,
  killWordForward,
  moveDown,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveUp,
  moveWordLeft,
  moveWordRight,
  onFirstLine,
  onLastLine,
  yank,
  type EditorState,
} from './editor.js';

function at(text: string, cursor: number): EditorState {
  return { text, cursor, killed: '' };
}

describe('editing of the text box', () => {
  it('inserts at the cursor and keeps the cursor after it', () => {
    const state = insert(at('ab', 1), 'XY');
    expect(state).toMatchObject({ text: 'aXYb', cursor: 3 });
    expect(insert(createEditor('hi'), '!').text).toBe('hi!');
  });

  it('deletes a whole grapheme, not half of an emoji', () => {
    const family = '👨‍👩‍👧';
    expect(deleteBackward(createEditor(`a${family}`)).text).toBe('a');
    expect(deleteForward(at(`${family}b`, 0)).text).toBe('b');
    expect(moveLeft(createEditor('é👍')).cursor).toBe(1);
    expect(moveRight(at('👍x', 0)).cursor).toBe(2);
  });

  it('does nothing at the ends of the text', () => {
    expect(deleteBackward(at('abc', 0)).text).toBe('abc');
    expect(deleteForward(at('abc', 3)).text).toBe('abc');
    expect(moveLeft(at('abc', 0)).cursor).toBe(0);
    expect(moveRight(at('abc', 3)).cursor).toBe(3);
  });

  it('moves to the start and to the end of the line the cursor is on', () => {
    const text = 'one\ntwo\nthree';
    expect(moveToLineStart(at(text, 6)).cursor).toBe(4);
    expect(moveToLineEnd(at(text, 5)).cursor).toBe(7);
    expect(moveToLineEnd(at(text, 9)).cursor).toBe(text.length);
  });

  it('moves up and down in the same column, and says when there is no line to go to', () => {
    const text = 'abcdef\nxy\nlonger line';
    expect(moveUp(at(text, 12)).cursor).toBe(9); // column 2 of "xy" is its end
    expect(moveDown(at(text, 4)).cursor).toBe(9);
    expect(moveDown(at(text, 9)).cursor).toBe(12);
    const top = at(text, 2);
    expect(moveUp(top)).toBe(top);
    expect(onFirstLine(top)).toBe(true);
    expect(onFirstLine(at(text, 8))).toBe(false);
    expect(onLastLine(at(text, text.length))).toBe(true);
    expect(onLastLine(at(text, 2))).toBe(false);
    const bottom = at(text, text.length);
    expect(moveDown(bottom)).toBe(bottom);
  });

  it('jumps by words, skipping the punctuation between them', () => {
    const text = 'foo, bar_baz  qux';
    expect(moveWordRight(at(text, 0)).cursor).toBe(3);
    expect(moveWordRight(at(text, 3)).cursor).toBe(12);
    expect(moveWordLeft(at(text, text.length)).cursor).toBe(14);
    expect(moveWordLeft(at(text, 14)).cursor).toBe(5);
    expect(moveWordLeft(at(text, 2)).cursor).toBe(0);
    expect(moveWordRight(at('çã é', 0)).cursor).toBe(2);
  });

  it('cuts to the end of the line, and takes the newline when the line is over', () => {
    const state = killToLineEnd(at('one\ntwo', 1));
    expect(state).toMatchObject({ text: 'o\ntwo', killed: 'ne', cursor: 1 });
    const joined = killToLineEnd(at('o\ntwo', 1));
    expect(joined).toMatchObject({ text: 'otwo', killed: '\n' });
    expect(killToLineEnd(at('end', 3)).text).toBe('end');
  });

  it('cuts to the start of the line, and takes the newline when the cursor is at the start', () => {
    expect(killToLineStart(at('one\ntwo', 6))).toMatchObject({
      text: 'one\no',
      killed: 'tw',
      cursor: 4,
    });
    expect(killToLineStart(at('one\ntwo', 4))).toMatchObject({ text: 'onetwo', killed: '\n' });
    expect(killToLineStart(at('one', 0)).text).toBe('one');
  });

  it('cuts a word back and forward, and puts the last cut back with yank', () => {
    const back = killWordBackward(at('one two three', 7));
    expect(back).toMatchObject({ text: 'one  three', killed: 'two', cursor: 4 });
    const forward = killWordForward(at('one two three', 4));
    expect(forward).toMatchObject({ text: 'one  three', killed: 'two' });
    expect(yank(back)).toMatchObject({ text: 'one two three', cursor: 7 });
    expect(yank(createEditor('x')).text).toBe('x');
  });

  describe('markers of attachments', () => {
    const marker = '[Pasted text #1]';
    const text = `see ${marker} now`;
    const atoms = atomRanges(text, [marker]);

    it('finds every occurrence of a marker', () => {
      expect(atoms).toEqual([[4, 4 + marker.length]]);
      expect(atomRanges(`${marker}${marker}`, [marker])).toHaveLength(2);
      expect(atomRanges('nothing', [marker, ''])).toEqual([]);
    });

    it('removes the whole marker with one Backspace or one Delete', () => {
      const end = 4 + marker.length;
      expect(deleteBackward(at(text, end), atoms).text).toBe('see  now');
      expect(deleteForward(at(text, 4), atoms).text).toBe('see  now');
    });

    it('moves over the marker as if it were one character', () => {
      expect(moveRight(at(text, 4), atoms).cursor).toBe(4 + marker.length);
      expect(moveLeft(at(text, 4 + marker.length), atoms).cursor).toBe(4);
      expect(moveWordRight(at(text, 0), atoms).cursor).toBe(3);
      expect(moveWordRight(at(text, 3), atoms).cursor).toBe(4 + marker.length);
    });

    it('does not leave the cursor inside a marker when moving between lines', () => {
      const lines = `aaaaaaaaaaaaaaaaaaaaaaaa\nbb ${marker}`;
      const marked = atomRanges(lines, [marker]);
      const moved = moveDown(at(lines, 8), marked);
      expect(lines.indexOf(marker)).toBe(28);
      expect(moved.cursor).toBe(28);
    });
  });
});
