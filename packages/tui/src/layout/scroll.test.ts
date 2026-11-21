// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { scrollStepLines, scrollWindow } from './scroll.js';

const heightOf = (index: number): number => (index % 3) + 1;

describe('scrollWindow', () => {
  it('shows the end of the list at offset 0 with the bottom anchor, and only what fits', () => {
    const asked = new Set<number>();
    const window = scrollWindow({
      count: 5000,
      height: 10,
      offset: 0,
      anchor: 'bottom',
      heightOf: (index) => {
        asked.add(index);
        return heightOf(index);
      },
    });
    const lines = window.slices.reduce((sum, slice) => sum + slice.take, 0);
    expect(lines).toBe(10);
    expect(window.slices.at(-1)?.index).toBe(4999);
    expect(asked.size).toBeLessThanOrEqual(10);
    expect(window.touched).toBeLessThanOrEqual(10);
    expect(window.more).toEqual({ above: true, below: false });
  });

  it('scrolls up by lines, cutting the item at the edge', () => {
    // Items 0..3 of heights 1, 2, 3, 1.
    const window = scrollWindow({ count: 4, height: 3, offset: 2, anchor: 'bottom', heightOf });
    // Lines top to bottom: [0] [1a 1b] [2a 2b 2c] [3]; hide the last 2: shows 1b 2a... lines 2..4.
    expect(window.slices).toEqual([
      { index: 1, skip: 1, take: 1 },
      { index: 2, skip: 0, take: 2 },
    ]);
    expect(window.more).toEqual({ above: true, below: true });
  });

  it('pulls an offset past the start back to the first full window', () => {
    const window = scrollWindow({ count: 4, height: 3, offset: 99, anchor: 'bottom', heightOf });
    expect(window.offset).toBe(4);
    expect(window.slices[0]).toEqual({ index: 0, skip: 0, take: 1 });
    expect(window.more.above).toBe(false);
  });

  it('keeps a list shorter than the window whole', () => {
    const window = scrollWindow({ count: 2, height: 10, offset: 0, anchor: 'bottom', heightOf });
    expect(window.slices).toEqual([
      { index: 0, skip: 0, take: 1 },
      { index: 1, skip: 0, take: 2 },
    ]);
    expect(window.more).toEqual({ above: false, below: false });
  });

  it('works from the top for the lists of the panel', () => {
    const top = scrollWindow({ count: 100, height: 5, offset: 0, anchor: 'top', heightOf });
    expect(top.slices[0]).toEqual({ index: 0, skip: 0, take: 1 });
    expect(top.more).toEqual({ above: false, below: true });
    const moved = scrollWindow({ count: 100, height: 5, offset: 2, anchor: 'top', heightOf });
    expect(moved.slices[0]).toEqual({ index: 1, skip: 1, take: 1 });
    expect(moved.more.above).toBe(true);
  });

  it('gives an empty window for an empty list or no room', () => {
    expect(scrollWindow({ count: 0, height: 5, offset: 0, anchor: 'bottom', heightOf }).slices).toEqual([]);
    expect(scrollWindow({ count: 5, height: 0, offset: 0, anchor: 'top', heightOf }).slices).toEqual([]);
  });
});

describe('scrollStepLines', () => {
  it('moves a page, half a page or a line', () => {
    expect(scrollStepLines('page', 20)).toBe(19);
    expect(scrollStepLines('half', 20)).toBe(10);
    expect(scrollStepLines('line', 20)).toBe(1);
    expect(scrollStepLines('half', 1)).toBe(1);
  });
});
