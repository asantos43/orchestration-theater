// SPDX-License-Identifier: MPL-2.0
import { cellWidth, fit } from './text.js';

export interface TabLabel {
  readonly id: string;
  readonly label: string;
}

export interface TabBarSegment {
  readonly id: string;
  readonly text: string;
  readonly active: boolean;
}

export interface TabBar {
  readonly segments: readonly TabBarSegment[];
  /** `───━━━━━───` under the tabs, in the width the tabs have. */
  readonly underline: string;
  /** Tabs to the left that do not fit, and to the right. */
  readonly hidden: { readonly before: number; readonly after: number };
}

const SEPARATOR = '│';

function segmentText(label: string): string {
  return ` ${label} ✕ `;
}

/**
 * The tab bar in `width` cells: each tab is ` label ✕ ` and they are separated by `│`. When they do
 * not all fit, the bar keeps the active one and the ones nearest to it. A single tab wider than the
 * room has its label cut.
 */
export function layoutTabBar(
  tabs: readonly TabLabel[],
  active: string | undefined,
  width: number,
): TabBar {
  const room = Math.max(0, width);
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active),
  );
  const widths = tabs.map((tab) => cellWidth(segmentText(tab.label)));
  let from = index;
  let to = index;
  let used = tabs.length === 0 ? 0 : (widths[index] ?? 0);
  const spend = (i: number): number => (widths[i] ?? 0) + 1;
  for (;;) {
    const canLeft = from > 0 && used + spend(from - 1) <= room;
    const canRight = to < tabs.length - 1 && used + spend(to + 1) <= room;
    if (canRight) {
      to += 1;
      used += spend(to);
    } else if (canLeft) {
      from -= 1;
      used += spend(from);
    } else break;
  }
  const segments: TabBarSegment[] = [];
  let underline = '';
  for (let i = from; i <= to && i < tabs.length; i += 1) {
    const tab = tabs[i];
    if (tab === undefined) continue;
    let text = segmentText(tab.label);
    if (cellWidth(text) > room) text = fit(text, room);
    const isActive = i === index && tab.id === active;
    if (i > from) {
      segments.push({ id: `sep-${String(i)}`, text: SEPARATOR, active: false });
      underline += '─';
    }
    segments.push({ id: tab.id, text, active: isActive });
    underline += (isActive ? '━' : '─').repeat(cellWidth(text));
  }
  return {
    segments,
    underline,
    hidden: {
      before: tabs.length === 0 ? 0 : from,
      after: tabs.length === 0 ? 0 : tabs.length - 1 - to,
    },
  };
}
