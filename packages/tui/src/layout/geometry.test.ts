// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_TUI_LAYOUT } from '../settings.js';
import {
  computeGeometry,
  steppedChatWidth,
  steppedSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type GeometryInput,
} from './geometry.js';

const base: GeometryInput = {
  columns: 140,
  rows: 42,
  sidebarCollapsed: false,
  panelOpen: true,
  chatWidth: 56,
  tuning: DEFAULT_TUI_LAYOUT,
};

describe('computeGeometry: the four screens of the mockup (140x42)', () => {
  it('main: side bar 30, chat 56, panel 54', () => {
    const g = computeGeometry(base);
    expect(g.bodyHeight).toBe(40);
    expect(g.sidebar).toEqual({ mode: 'expanded', width: 30 });
    expect(g.chat).toEqual({ x: 30, width: 56 });
    expect(g.panel).toEqual({ x: 86, width: 54 });
  });

  it('trajectories: rail 5, chat 50, panel 85', () => {
    const g = computeGeometry({ ...base, sidebarCollapsed: true, chatWidth: 50 });
    expect(g.sidebar).toEqual({ mode: 'rail', width: 5 });
    expect(g.chat).toEqual({ x: 5, width: 50 });
    expect(g.panel).toEqual({ x: 55, width: 85 });
  });

  it('settings: side bar 30, chat 46, panel 64', () => {
    const g = computeGeometry({ ...base, chatWidth: 46 });
    expect(g.chat.width).toBe(46);
    expect(g.panel).toEqual({ x: 76, width: 64 });
  });

  it('focus: rail 5 and a chat of 135 with the panel closed', () => {
    const g = computeGeometry({ ...base, sidebarCollapsed: true, panelOpen: false });
    expect(g.chat).toEqual({ x: 5, width: 135 });
    expect(g.panel).toBeUndefined();
    expect(g.panelAbsence).toBe('closed');
  });
});

describe('computeGeometry: small screens and bounds', () => {
  it('keeps the chat inside the bounds when the stored width does not fit', () => {
    expect(computeGeometry({ ...base, chatWidth: 500 }).chat.width).toBe(80);
    expect(computeGeometry({ ...base, chatWidth: 3 }).chat.width).toBe(30);
  });

  it('hides the panel when there is no room for both, and says it is the screen', () => {
    const g = computeGeometry({ ...base, columns: 100, rows: 30 });
    expect(g.chat.width).toBe(40);
    expect(g.panel?.width).toBe(30);
    const narrow = computeGeometry({ ...base, columns: 60, sidebarCollapsed: true });
    expect(narrow.panel).toBeUndefined();
    expect(narrow.panelAbsence).toBe('narrow');
    expect(narrow.chat.width).toBe(55);
  });

  it('gives the side bar back before the chat gets narrower than the minimum', () => {
    expect(computeGeometry({ ...base, columns: 50, panelOpen: false }).sidebar.mode).toBe('rail');
    expect(computeGeometry({ ...base, columns: 33, panelOpen: false }).sidebar.mode).toBe('hidden');
  });

  it('steps the chat width inside the range, and not at all without the panel', () => {
    const g = computeGeometry(base);
    expect(steppedChatWidth(g, 2)).toBe(58);
    expect(steppedChatWidth(g, -100)).toBe(30);
    expect(steppedChatWidth(g, 100)).toBe(80);
    const closed = computeGeometry({ ...base, panelOpen: false });
    expect(steppedChatWidth(closed, 2)).toBe(110);
  });
});

describe('computeGeometry: the width of the side bar (N277)', () => {
  it('starts from ui.tuiLayout.sidebarWidth and uses the saved width when there is one', () => {
    expect(computeGeometry(base).sidebar).toEqual({ mode: 'expanded', width: 30 });
    const saved = computeGeometry({ ...base, sidebarWidth: 44 });
    expect(saved.sidebar).toEqual({ mode: 'expanded', width: 44 });
    expect(saved.chat.x).toBe(44);
  });

  it('keeps the width between 16 and 80 columns', () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(16);
    expect(SIDEBAR_MAX_WIDTH).toBe(80);
    expect(computeGeometry({ ...base, sidebarWidth: 3 }).sidebar.width).toBe(16);
    expect(computeGeometry({ ...base, sidebarWidth: 500, panelOpen: false }).sidebar.width).toBe(
      80,
    );
  });

  it('bounds the drag so the chat and the panel on the screen keep their minimum', () => {
    // 140 columns, panel open: 140 - 30 (chat) - 30 (panel) = 80.
    expect(computeGeometry(base).sidebarRange).toEqual({ min: 16, max: 80 });
    // 100 columns: 100 - 60 = 40 with the panel; without it, 100 - 30 = 70.
    expect(computeGeometry({ ...base, columns: 100 }).sidebarRange).toEqual({ min: 16, max: 40 });
    expect(computeGeometry({ ...base, columns: 100, panelOpen: false }).sidebarRange).toEqual({
      min: 16,
      max: 70,
    });
  });

  it('never takes the minimum of the chat: a width too large for the screen gives way to the rail', () => {
    const g = computeGeometry({ ...base, columns: 60, panelOpen: false, sidebarWidth: 40 });
    expect(g.sidebar.mode).toBe('rail');
    expect(g.chat.width).toBeGreaterThanOrEqual(DEFAULT_TUI_LAYOUT.minChatWidth);
    expect(g.sidebarRange.min).toBe(g.sidebarRange.max);
  });

  it('keeps the width chosen and lets the panel give way, as it always did', () => {
    const g = computeGeometry({ ...base, columns: 80 });
    expect(g.sidebar.width).toBe(30);
    expect(g.panel).toBeUndefined();
    expect(g.panelAbsence).toBe('narrow');
    expect(g.sidebarRange.max).toBe(50);
  });

  it('has nothing to adjust on a rail or without a side bar', () => {
    const rail = computeGeometry({ ...base, sidebarCollapsed: true });
    expect(rail.sidebarRange).toEqual({ min: 5, max: 5 });
    expect(steppedSidebarWidth(rail, 4)).toBe(5);
    const hidden = computeGeometry({ ...base, columns: 33, panelOpen: false });
    expect(hidden.sidebarRange).toEqual({ min: 0, max: 0 });
    expect(steppedSidebarWidth(hidden, 4)).toBe(0);
  });

  it('steps the width inside the range', () => {
    const g = computeGeometry(base);
    expect(steppedSidebarWidth(g, 2)).toBe(32);
    expect(steppedSidebarWidth(g, -100)).toBe(16);
    expect(steppedSidebarWidth(g, 100)).toBe(80);
    expect(steppedSidebarWidth(g, 3, 50)).toBe(53);
  });
});
