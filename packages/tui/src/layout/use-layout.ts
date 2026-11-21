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

export function isPanelOpen(layout: LayoutPreferences): boolean {
  return !layout.collapsedSections.includes(PANEL_CLOSED_MARKER);
}

export function setPanelOpen(store: LayoutStore, open: boolean): boolean {
  return store.setSectionCollapsed(PANEL_CLOSED_MARKER, !open);
}

/** The ids of the sections the person folded, as a set. */
export function foldedSections(layout: LayoutPreferences): ReadonlySet<string> {
  return new Set(layout.collapsedSections.filter((id) => id !== PANEL_CLOSED_MARKER));
}
