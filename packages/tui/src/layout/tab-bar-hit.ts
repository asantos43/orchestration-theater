// SPDX-License-Identifier: MPL-2.0
import { layoutTabBar, type TabLabel } from './tab-bar.js';
import { cellWidth } from './text.js';

/**
 * What a click on the tab bar of the panel lands on (N34): a tab, the `✕` of a tab, the `+` that
 * adds one, or the `⟩` that hides the panel. Pure and cell-based, over the same layout the panel
 * draws (`layoutTabBar` and the right part), so the two cannot disagree.
 */

export type TabBarHit =
  | { readonly kind: 'tab'; readonly id: string }
  | { readonly kind: 'close'; readonly id: string }
  | { readonly kind: 'add' }
  | { readonly kind: 'toggle' };

export interface PanelBarKeys {
  readonly add: string | undefined;
  readonly toggle: string | undefined;
}

/** The right part of the bar: `+ key  ⟩ key `. */
export function panelBarRight(keys: PanelBarKeys): string {
  return `+${keys.add === undefined ? '' : ` ${keys.add}`}  ⟩${keys.toggle === undefined ? '' : ` ${keys.toggle}`} `;
}

/** The click on cell `x` of the bar (0 is the first cell inside the frame); `inner` is the width the bar has. */
export function tabBarHit(
  tabs: readonly TabLabel[],
  active: string | undefined,
  keys: PanelBarKeys,
  inner: number,
  x: number,
): TabBarHit | undefined {
  const right = panelBarRight(keys);
  const rightWidth = cellWidth(right);
  const rightStart = Math.max(0, inner - rightWidth);
  if (x >= rightStart) {
    const at = x - rightStart;
    const addWidth = cellWidth(`+${keys.add === undefined ? '' : ` ${keys.add}`}`);
    if (at < addWidth) return { kind: 'add' };
    if (at >= addWidth + 2) return { kind: 'toggle' };
    return undefined;
  }
  const bar = layoutTabBar(tabs, active, rightStart);
  let from = 0;
  for (const segment of bar.segments) {
    const size = cellWidth(segment.text);
    if (x >= from && x < from + size) {
      if (segment.id.startsWith('sep-')) return undefined;
      // ` label ✕ `: the three cells at the end are the close mark and the blanks around it.
      return x >= from + size - 3
        ? { kind: 'close', id: segment.id }
        : { kind: 'tab', id: segment.id };
    }
    from += size;
  }
  return undefined;
}
