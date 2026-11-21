// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { layoutBox } from './layout.js';

describe('the layout of the box', () => {
  it('shows only the cursor, as a space, in an empty box', () => {
    expect(layoutBox('', 0, [], 8)).toEqual({
      above: 0,
      below: 0,
      lines: [[{ kind: 'cursor', text: ' ' }]],
    });
  });

  it('draws the cursor on the character it stands on, and at the end as a space', () => {
    expect(layoutBox('abc', 1, [], 8).lines[0]).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'cursor', text: 'b' },
      { kind: 'text', text: 'c' },
    ]);
    expect(layoutBox('abc', 3, [], 8).lines[0]).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'cursor', text: ' ' },
    ]);
  });

  it('draws an emoji as one character', () => {
    expect(layoutBox('a👍🏽b', 1, [], 8).lines[0]?.[1]).toEqual({ kind: 'cursor', text: '👍🏽' });
  });

  it('styles the markers, and makes the whole marker the cursor when it stands on one', () => {
    const text = 'see [Image #1] now';
    const atoms = [[4, 14]] as const;
    expect(layoutBox(text, 0, atoms, 8).lines[0]?.[2]).toEqual({
      kind: 'marker',
      text: '[Image #1]',
    });
    expect(layoutBox(text, 4, atoms, 8).lines[0]?.[1]).toEqual({
      kind: 'cursor',
      text: '[Image #1]',
    });
  });

  it('shows a window of lines around the cursor and counts the ones left out', () => {
    const text = Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join('\n');
    const bottom = layoutBox(text, text.length, [], 5);
    expect(bottom.lines).toHaveLength(5);
    expect(bottom).toMatchObject({ above: 15, below: 0 });
    const top = layoutBox(text, 0, [], 5);
    expect(top).toMatchObject({ above: 0, below: 15 });
    const middle = layoutBox(text, text.indexOf('l10'), [], 5);
    expect(middle).toMatchObject({ above: 8, below: 7 });
    expect(middle.lines[2]?.[0]).toMatchObject({ kind: 'cursor' });
  });

  it('keeps an empty line in the middle of the text', () => {
    expect(layoutBox('a\n\nb', 2, [], 8).lines).toHaveLength(3);
  });
});
