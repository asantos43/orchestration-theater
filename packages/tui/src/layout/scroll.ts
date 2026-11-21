// SPDX-License-Identifier: MPL-2.0

/**
 * The window of a long list that fits a screen. Only the items that touch the window are looked at,
 * so a list of 5,000 messages costs what the screen holds, not what the list does. The list is
 * measured in lines: an item is `heightOf(index)` lines tall (at least 1), and the window is
 * `height` lines.
 */

export type ScrollAnchor = 'top' | 'bottom';

export interface ScrollInput {
  readonly count: number;
  /** Lines the window shows. */
  readonly height: number;
  /** Lines scrolled away from the anchor: `0` shows the end (anchor `bottom`) or the start (`top`). */
  readonly offset: number;
  readonly anchor: ScrollAnchor;
  readonly heightOf: (index: number) => number;
}

/** A piece of an item inside the window: lines `skip` to `skip + take` of item `index`. */
export interface ScrollSlice {
  readonly index: number;
  readonly skip: number;
  readonly take: number;
}

export interface ScrollWindow {
  /** Top to bottom. */
  readonly slices: readonly ScrollSlice[];
  /** The offset after the clamp (a list that got shorter pulls it back). */
  readonly offset: number;
  /** There is more beyond each edge of the window. */
  readonly more: { readonly above: boolean; readonly below: boolean };
  /** Items whose height was asked for: the cost of this window. */
  readonly touched: number;
}

const EMPTY: ScrollWindow = {
  slices: [],
  offset: 0,
  more: { above: false, below: false },
  touched: 0,
};

/** Lines of the whole list: the walk this avoids, so only a window pulled back pays for it. */
function totalLines(count: number, heightOf: (index: number) => number): number {
  let total = 0;
  for (let index = 0; index < count; index += 1) total += heightOf(index);
  return total;
}

export function scrollWindow(input: ScrollInput): ScrollWindow {
  const height = Math.max(0, Math.floor(input.height));
  if (input.count <= 0 || height === 0) return EMPTY;
  const heightOf = (index: number): number => Math.max(1, Math.floor(input.heightOf(index)));
  const bottom = input.anchor === 'bottom';
  const step = bottom ? -1 : 1;
  const wanted = Math.max(0, Math.floor(input.offset));
  let touched = 0;
  let skipped = 0;
  let collected = 0;
  let hidden = 0;
  let index = bottom ? input.count - 1 : 0;
  const slices: ScrollSlice[] = [];
  // From the anchor: past `wanted` lines, then `height` lines.
  while (index >= 0 && index < input.count && collected < height) {
    const lines = heightOf(index);
    touched += 1;
    const drop = Math.min(lines, wanted - skipped);
    skipped += drop;
    const remaining = lines - drop;
    if (remaining > 0) {
      const take = Math.min(remaining, height - collected);
      slices.push({ index, skip: bottom ? remaining - take : drop, take });
      collected += take;
      hidden = remaining - take;
    }
    index += step;
  }
  if (skipped < wanted || (collected < height && wanted > 0)) {
    // The offset is past what the list has: pull it back so the window is full.
    const pulled = Math.max(0, totalLines(input.count, heightOf) - height);
    return scrollWindow({ ...input, offset: Math.min(wanted, pulled) });
  }
  if (bottom) slices.reverse();
  const far = (index >= 0 && index < input.count) || hidden > 0;
  return {
    slices,
    offset: wanted,
    more: bottom ? { above: far, below: wanted > 0 } : { above: wanted > 0, below: far },
    touched,
  };
}

/** The lines one page, half a page or one line moves (`ui.tuiLayout.scrollStep`). */
export function scrollStepLines(step: 'page' | 'half' | 'line', height: number): number {
  switch (step) {
    case 'line':
      return 1;
    case 'half':
      return Math.max(1, Math.floor(height / 2));
    case 'page':
      return Math.max(1, height - 1);
  }
}
