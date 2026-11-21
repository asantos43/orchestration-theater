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
      runtime: { maxSemiSpaceMB: 2, maxOldSpaceMB: undefined, exitGraceMs: 2000 },
      keymap: { preset: 'agents', environment: 'auto', overrides: {} },
      tuiLayout: {
        sidebarWidth: 30,
        railWidth: 5,
        minChatWidth: 30,
        minPanelWidth: 30,
        chatStep: 2,
        scrollStep: 'half',
      },
      trajectories: { open: 'last', keep: 5000, diffLines: 200, follow: 'latest' },
      chat: { queue: 'daemon', suggestions: 6, decisionFocus: 'auto', esc: 'stop', history: 40 },
      input: DEFAULT_UI_SETTINGS.input,
      overview: { confirm: 'always', recentEvents: 8, hiddenEvents: ['session.update'] },
      usage: { groupBy: 'profile', refreshSeconds: 30 },
      mouse: 'full',
      clipboardCopy: 'osc52',
      tuiMouse: { wheelLines: 3, copyMaxBytes: 100_000 },
      setup: { open: 'auto', readTimeoutMs: 5000 },
    });
  });

  it('reads ui.trajectories (snake_case keys, as the daemon writes them) and falls back key by key', () => {
    expect(
      parseUiSettings({ trajectories: { open: 'all', keep: 1000, diff_lines: 50 } }).trajectories,
    ).toEqual({ open: 'all', keep: 1000, diffLines: 50, follow: 'latest' });
    expect(parseUiSettings({ trajectories: { follow: 'direct' } }).trajectories.follow).toBe(
      'direct',
    );
    expect(
      parseUiSettings({ trajectories: { open: 'some', keep: 5, diff_lines: 50 } }).trajectories,
    ).toEqual({ open: 'last', keep: 5000, diffLines: 50, follow: 'latest' });
  });

  it('reads ui.chat and ui.input, and falls back for what is not valid (P12)', () => {
    const settings = parseUiSettings({
      chat: { queue: 'hold', suggestions: 0, decisionFocus: 'sometimes', esc: 'off', history: 12 },
      input: { maxVisibleLines: 3 },
    });
    expect(settings.chat).toEqual({
      queue: 'hold',
      suggestions: 0,
      decisionFocus: 'auto',
      esc: 'off',
      history: 12,
    });
    expect(parseUiSettings({ chat: { history: 500 } }).chat.history).toBe(40);
    expect(parseUiSettings({ chat: { history: 0 } }).chat.history).toBe(0);
    expect(settings.input.maxVisibleLines).toBe(3);
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
      runtime: { maxSemiSpaceMB: 4, maxOldSpaceMB: 192, exitGraceMs: 500 },
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
      runtime: { maxSemiSpaceMB: 4, maxOldSpaceMB: 192, exitGraceMs: 500 },
      keymap: DEFAULT_UI_SETTINGS.keymap,
      tuiLayout: DEFAULT_UI_SETTINGS.tuiLayout,
      trajectories: DEFAULT_UI_SETTINGS.trajectories,
      chat: DEFAULT_UI_SETTINGS.chat,
      input: DEFAULT_UI_SETTINGS.input,
      overview: DEFAULT_UI_SETTINGS.overview,
      usage: DEFAULT_UI_SETTINGS.usage,
      mouse: DEFAULT_UI_SETTINGS.mouse,
      clipboardCopy: DEFAULT_UI_SETTINGS.clipboardCopy,
      tuiMouse: DEFAULT_UI_SETTINGS.tuiMouse,
      setup: DEFAULT_UI_SETTINGS.setup,
    });
  });

  it('reads the mouse keys of P11 and falls back key by key', () => {
    expect(parseUiSettings({}).mouse).toBe('full');
    expect(parseUiSettings({}).clipboardCopy).toBe('osc52');
    expect(parseUiSettings({}).tuiMouse).toEqual({ wheelLines: 3, copyMaxBytes: 100_000 });
    const set = parseUiSettings({
      mouse: 'wheel',
      clipboard: { copy: 'auto' },
      tuiMouse: { wheelLines: 5, copyMaxBytes: 'x' },
    });
    expect(set.mouse).toBe('wheel');
    expect(set.clipboardCopy).toBe('auto');
    expect(set.tuiMouse).toEqual({ wheelLines: 5, copyMaxBytes: 100_000 });
    const bad = parseUiSettings({ mouse: 'some', clipboard: { copy: 'paste' }, tuiMouse: 4 });
    expect(bad.mouse).toBe('full');
    expect(bad.clipboardCopy).toBe('osc52');
    expect(bad.tuiMouse).toEqual(DEFAULT_UI_SETTINGS.tuiMouse);
  });

  it('reads ui.setup of P17 and falls back key by key', () => {
    expect(parseUiSettings({}).setup).toEqual({ open: 'auto', readTimeoutMs: 5000 });
    expect(parseUiSettings({ setup: { open: 'never', readTimeoutMs: 900 } }).setup).toEqual({
      open: 'never',
      readTimeoutMs: 900,
    });
    expect(parseUiSettings({ setup: { open: 'always', readTimeoutMs: 5 } }).setup).toEqual(
      DEFAULT_UI_SETTINGS.setup,
    );
    expect(parseUiSettings({ setup: 3 }).setup).toEqual(DEFAULT_UI_SETTINGS.setup);
  });

  it('falls back key by key: a bad value does not spoil the good ones', () => {
    const settings = parseUiSettings({
      locale: 'fr',
      render: { keyRender: 'sometimes', maxFps: 0, memo: 'yes', historyWindow: -1, coalesceMs: 5 },
      runtime: { maxSemiSpaceMB: 1.5, maxOldSpaceMB: 'big', exitGraceMs: -5 },
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
