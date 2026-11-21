// SPDX-License-Identifier: MPL-2.0
import type { UiTuiLayoutSettings } from '../settings.js';

/**
 * Where each area of the screen goes (architecture 5.13, mockup `tui.html`). Pure: the screen is
 * `columns x rows`, the header takes the first row and the bar of shortcuts the last, and the body
 * between them is the side bar (or its rail), the chat and the panel of tabs, left to right.
 */

/** The `ui.tuiLayout` keys the geometry reads. */
export type LayoutTuning = Pick<
  UiTuiLayoutSettings,
  'sidebarWidth' | 'railWidth' | 'minChatWidth' | 'minPanelWidth' | 'chatStep'
>;

export interface GeometryInput {
  readonly columns: number;
  readonly rows: number;
  readonly sidebarCollapsed: boolean;
  readonly panelOpen: boolean;
  /** The width the person chose for the chat (what the store keeps). */
  readonly chatWidth: number;
  readonly tuning: LayoutTuning;
}

/** How the side bar is drawn: whole, as a rail of 3 cells, or not at all (a terminal too narrow). */
export type SidebarMode = 'expanded' | 'rail' | 'hidden';

/** Why there is no panel: the person closed it, or the screen is too narrow for it. */
export type PanelAbsence = 'closed' | 'narrow';

export interface Geometry {
  readonly columns: number;
  readonly rows: number;
  /** Rows of the body (between the header and the bar). */
  readonly bodyHeight: number;
  readonly sidebar: { readonly mode: SidebarMode; readonly width: number };
  readonly chat: { readonly x: number; readonly width: number };
  /** `undefined` when the panel is not drawn. */
  readonly panel: { readonly x: number; readonly width: number } | undefined;
  readonly panelAbsence: PanelAbsence | undefined;
  /** The bounds the width of the chat can take now (equal when it cannot move). */
  readonly chatRange: { readonly min: number; readonly max: number };
}

export function computeGeometry(input: GeometryInput): Geometry {
  const { tuning } = input;
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(3, Math.floor(input.rows));
  let mode: SidebarMode = input.sidebarCollapsed ? 'rail' : 'expanded';
  let sidebarWidth = mode === 'rail' ? tuning.railWidth : tuning.sidebarWidth;
  // A screen too narrow for the chat beside the side bar gives the room back: whole, then rail, then nothing.
  if (mode === 'expanded' && columns - sidebarWidth < tuning.minChatWidth) {
    mode = 'rail';
    sidebarWidth = tuning.railWidth;
  }
  if (mode === 'rail' && columns - sidebarWidth < tuning.minChatWidth) {
    mode = 'hidden';
    sidebarWidth = 0;
  }
  const available = columns - sidebarWidth;
  const panelFits = available >= tuning.minChatWidth + tuning.minPanelWidth;
  const showPanel = input.panelOpen && panelFits;
  const maxChat = showPanel ? available - tuning.minPanelWidth : available;
  const minChat = Math.min(tuning.minChatWidth, maxChat);
  const chatWidth = showPanel
    ? Math.min(maxChat, Math.max(minChat, Math.round(input.chatWidth)))
    : available;
  return {
    columns,
    rows,
    bodyHeight: rows - 2,
    sidebar: { mode, width: sidebarWidth },
    chat: { x: sidebarWidth, width: chatWidth },
    panel: showPanel ? { x: sidebarWidth + chatWidth, width: available - chatWidth } : undefined,
    panelAbsence: showPanel ? undefined : input.panelOpen ? 'narrow' : 'closed',
    chatRange: { min: minChat, max: maxChat },
  };
}

/**
 * The width the chat takes after `delta` cells more (negative: fewer), inside the bounds of this
 * geometry. With no panel the chat takes the whole row and there is nothing to adjust: the result
 * is the width as it is.
 */
export function steppedChatWidth(
  geometry: Geometry,
  delta: number,
  from: number = geometry.chat.width,
): number {
  if (geometry.panel === undefined) return geometry.chat.width;
  const { min, max } = geometry.chatRange;
  const start = Math.min(max, Math.max(min, from));
  return Math.min(max, Math.max(min, start + delta));
}
