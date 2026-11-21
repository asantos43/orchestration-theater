// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_SETTINGS, parseUiSettings } from './settings.js';

describe('parseUiSettings', () => {
  it('gives the documented defaults for anything that is not an object', () => {
    for (const value of [undefined, null, 'tui', 7, [], [1]]) {
      expect(parseUiSettings(value)).toEqual(DEFAULT_UI_SETTINGS);
    }
    expect(DEFAULT_UI_SETTINGS).toEqual({
      locale: 'auto',
      render: {
        keyRender: 'flush',
        maxFps: 30,
        coalesceMs: 16,
        memo: true,
        inkPatches: ['cache', 'grid'],
        historyWindow: 0,
      },
      runtime: { maxSemiSpaceMB: 2, maxOldSpaceMB: undefined },
      keymap: { preset: 'agents', environment: 'auto', overrides: {} },
      tuiLayout: {
        sidebarWidth: 30,
        railWidth: 5,
        minChatWidth: 30,
        minPanelWidth: 30,
        chatStep: 2,
        scrollStep: 'half',
      },
      overview: { confirm: 'always', recentEvents: 8, hiddenEvents: ['session.update'] },
      usage: { groupBy: 'profile' },
    });
  });

  it('reads ui.keymap and ui.tuiLayout, and falls back for what is not valid', () => {
    const settings = parseUiSettings({
      keymap: {
        preset: 'classic',
        environment: 'none',
        overrides: { 'app.quit': ['Ctrl+X'], bad: 3 },
      },
      tuiLayout: { sidebarWidth: 40, railWidth: 99, chatStep: 4, scrollStep: 'line' },
    });
    expect(settings.keymap).toEqual({
      preset: 'classic',
      environment: 'none',
      overrides: { 'app.quit': ['Ctrl+X'] },
    });
    expect(settings.tuiLayout).toMatchObject({
      sidebarWidth: 40,
      railWidth: 5,
      chatStep: 4,
      scrollStep: 'line',
    });
    expect(parseUiSettings({ keymap: { preset: 'vim' } }).keymap.preset).toBe('agents');
  });

  it('reads valid values', () => {
    const settings = parseUiSettings({
      locale: 'pt-BR',
      render: {
        keyRender: 'throttle',
        maxFps: 60,
        coalesceMs: 0,
        memo: false,
        inkPatches: ['grid'],
        historyWindow: 500,
      },
      runtime: { maxSemiSpaceMB: 4, maxOldSpaceMB: 192 },
    });
    expect(settings).toEqual({
      locale: 'pt-BR',
      render: {
        keyRender: 'throttle',
        maxFps: 60,
        coalesceMs: 0,
        memo: false,
        inkPatches: ['grid'],
        historyWindow: 500,
      },
      runtime: { maxSemiSpaceMB: 4, maxOldSpaceMB: 192 },
      keymap: DEFAULT_UI_SETTINGS.keymap,
      tuiLayout: DEFAULT_UI_SETTINGS.tuiLayout,
      overview: DEFAULT_UI_SETTINGS.overview,
      usage: DEFAULT_UI_SETTINGS.usage,
    });
  });

  it('falls back key by key: a bad value does not spoil the good ones', () => {
    const settings = parseUiSettings({
      locale: 'fr',
      render: { keyRender: 'sometimes', maxFps: 0, memo: 'yes', historyWindow: -1, coalesceMs: 5 },
      runtime: { maxSemiSpaceMB: 1.5, maxOldSpaceMB: 'big' },
      unknown: true,
    });
    expect(settings.locale).toBe('auto');
    expect(settings.render).toEqual({ ...DEFAULT_UI_SETTINGS.render, coalesceMs: 5 });
    expect(settings.runtime).toEqual(DEFAULT_UI_SETTINGS.runtime);
  });

  it('inkPatches: [] turns the patches off; unknown names are dropped; repeats are merged', () => {
    expect(parseUiSettings({ render: { inkPatches: [] } }).render.inkPatches).toEqual([]);
    expect(
      parseUiSettings({ render: { inkPatches: ['cache', 'bogus', 'cache'] } }).render.inkPatches,
    ).toEqual(['cache']);
    expect(parseUiSettings({ render: { inkPatches: 'cache' } }).render.inkPatches).toEqual([
      'cache',
      'grid',
    ]);
  });

  it('keeps maxOldSpaceMB unset (V8 default) unless it is a sane number', () => {
    for (const value of [0, 8, -4, 1e9, 'x', null]) {
      expect(parseUiSettings({ runtime: { maxOldSpaceMB: value } }).runtime.maxOldSpaceMB).toBe(
        undefined,
      );
    }
    expect(parseUiSettings({ runtime: { maxOldSpaceMB: 16 } }).runtime.maxOldSpaceMB).toBe(16);
  });
});
