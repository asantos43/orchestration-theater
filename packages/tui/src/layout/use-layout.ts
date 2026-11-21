// SPDX-License-Identifier: MPL-2.0
import type { LayoutStore } from '@otheater/client';
import type { LayoutPreferences } from '@otheater/protocol';
import { useSyncExternalStore } from 'react';

/**
 * The preferences of the person are the ones the `LayoutStore` keeps (`openTabs`, `chatWidth`,
 * `sidebarCollapsed`, `collapsedSections`). [proposta] The record has no field for the panel
 * itself, so a panel the person closed (Alt+J) is the marker below among the collapsed
 * sections. It is saved and restored with the rest, and a `layout.changed` from another client
 * carries it too.
 */
export const PANEL_CLOSED_MARKER = 'layout.panelClosed';

/** The layout preferences now, and a re-render when they change. */
export function useLayoutPreferences(store: LayoutStore): LayoutPreferences {
  return useSyncExternalStore(
    (listener) => store.state.subscribe(listener),
    () => store.layout,
  );
}

/**
 * [proposta] The tab the person is on is saved the same way: the marker below, followed by the
 * id of the tab, among the collapsed sections (one at a time). The record has no field for it,
 * and without it the TUI would reopen on the first tab, not on the one it was closed on.
 */
export const ACTIVE_TAB_PREFIX = 'layout.activeTab.';

function isMarker(id: string): boolean {
  return id === PANEL_CLOSED_MARKER || id.startsWith(ACTIVE_TAB_PREFIX);
}

/** The tab saved as the active one, if any (the caller checks that it is still open). */
export function savedActiveTab(layout: LayoutPreferences): string | undefined {
  const marker = layout.collapsedSections.find((id) => id.startsWith(ACTIVE_TAB_PREFIX));
  return marker === undefined ? undefined : marker.slice(ACTIVE_TAB_PREFIX.length);
}

export function saveActiveTab(store: LayoutStore, tab: string | undefined): boolean {
  const others = store.layout.collapsedSections.filter((id) => !id.startsWith(ACTIVE_TAB_PREFIX));
  const next = tab === undefined ? others : [...others, `${ACTIVE_TAB_PREFIX}${tab}`];
  return store.update({ collapsedSections: next });
}

export function isPanelOpen(layout: LayoutPreferences): boolean {
  return !layout.collapsedSections.includes(PANEL_CLOSED_MARKER);
}

export function setPanelOpen(store: LayoutStore, open: boolean): boolean {
  return store.setSectionCollapsed(PANEL_CLOSED_MARKER, !open);
}

/** The ids of the sections the person folded, as a set. */
export function foldedSections(layout: LayoutPreferences): ReadonlySet<string> {
  return new Set(layout.collapsedSections.filter((id) => !isMarker(id)));
}
