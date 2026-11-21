// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_TUI_LAYOUT } from '../settings.js';
import { computeGeometry, steppedChatWidth, type GeometryInput } from './geometry.js';

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
