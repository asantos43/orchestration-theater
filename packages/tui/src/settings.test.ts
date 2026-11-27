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
      keyboard: { protocol: 'auto' },
      keymap: { preset: 'agents', environment: 'auto', overrides: {} },
      tuiLayout: {
        sidebarWidth: 30,
        railWidth: 5,
        minChatWidth: 30,
        minPanelWidth: 30,
        chatStep: 2,
        scrollStep: 'half',
        density: 'comfortable',
        sidebarEdge: 'tab',
      },
      trajectories: { open: 'last', keep: 5000, diffLines: 200, follow: 'latest' },
      chat: {
        queue: 'daemon',
        suggestions: 6,
        decisionFocus: 'auto',
        decisionClick: 'answer',
        esc: 'stop',
        directorFooter: 'on',
        history: 40,
        noScenario: 'open',
      },
      input: DEFAULT_UI_SETTINGS.input,
      overview: { confirm: 'always', recentEvents: 8, hiddenEvents: ['session.update'] },
      usage: {
        groupBy: 'profile',
        refreshSeconds: 30,
        sections: ['totals', 'groups', 'budget', 'trend', 'bottlenecks', 'play', 'telemetry'],
        trendDays: 14,
        spanRows: 40,
      },
      mouse: 'full',
      theme: 'otheater',
      clipboardCopy: 'osc52',
      tuiMouse: { wheelLines: 3, copyMaxBytes: 100_000 },
      setup: {
        open: 'auto',
        readTimeoutMs: 5000,
        reviewNotes: 'grouped',
        modelPick: 'preset',
        executorsInput: 'list',
        executorsLayout: 'table',
      },
      newProject: { repo: 'cwd', type: 'chat', picker: 'browser', hidden: 'hide', favorites: [] },
      sidebar: { finishedPlays: 'collapsed', finishedLimit: 20 },
      login: { browser: 'auto' },
      settingsTab: { limits: 'folded', roles: 'line', modelsAfterLogin: 'empty' },
      quota: { show: 'remaining' },
      security: { banner: 'on' },
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
      chat: {
        queue: 'hold',
        suggestions: 0,
        decisionFocus: 'sometimes',
        decisionClick: 'select',
        esc: 'off',
        history: 12,
        noScenario: 'notice',
      },
      input: { maxVisibleLines: 3 },
    });
    expect(settings.chat).toEqual({
      queue: 'hold',
      suggestions: 0,
      decisionFocus: 'auto',
      decisionClick: 'select',
      esc: 'off',
      directorFooter: 'on',
      history: 12,
      noScenario: 'notice',
    });
    expect(parseUiSettings({ chat: { directorFooter: 'off' } }).chat.directorFooter).toBe('off');
    expect(parseUiSettings({ chat: { directorFooter: 'maybe' } }).chat.directorFooter).toBe('on');
    expect(parseUiSettings({ chat: { decisionClick: 'double' } }).chat.decisionClick).toBe(
      'answer',
    );
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

  it('reads ui.tuiLayout.density and falls back to comfortable', () => {
    expect(parseUiSettings({}).tuiLayout.density).toBe('comfortable');
    expect(parseUiSettings({ tuiLayout: { density: 'compact' } }).tuiLayout.density).toBe(
      'compact',
    );
    expect(parseUiSettings({ tuiLayout: { density: 'tight' } }).tuiLayout.density).toBe(
      'comfortable',
    );
    expect(parseUiSettings({ tuiLayout: { density: 4 } }).tuiLayout.density).toBe('comfortable');
  });

  it('reads ui.tuiLayout.sidebarEdge and falls back to tab', () => {
    expect(parseUiSettings({}).tuiLayout.sidebarEdge).toBe('tab');
    for (const mode of ['tab', 'mouse', 'off'] as const) {
      expect(parseUiSettings({ tuiLayout: { sidebarEdge: mode } }).tuiLayout.sidebarEdge).toBe(
        mode,
      );
    }
    expect(parseUiSettings({ tuiLayout: { sidebarEdge: 'drag' } }).tuiLayout.sidebarEdge).toBe(
      'tab',
    );
    expect(parseUiSettings({ tuiLayout: { sidebarEdge: 1 } }).tuiLayout.sidebarEdge).toBe('tab');
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
      keyboard: DEFAULT_UI_SETTINGS.keyboard,
      keymap: DEFAULT_UI_SETTINGS.keymap,
      tuiLayout: DEFAULT_UI_SETTINGS.tuiLayout,
      trajectories: DEFAULT_UI_SETTINGS.trajectories,
      chat: DEFAULT_UI_SETTINGS.chat,
      input: DEFAULT_UI_SETTINGS.input,
      overview: DEFAULT_UI_SETTINGS.overview,
      usage: DEFAULT_UI_SETTINGS.usage,
      mouse: DEFAULT_UI_SETTINGS.mouse,
      theme: DEFAULT_UI_SETTINGS.theme,
      clipboardCopy: DEFAULT_UI_SETTINGS.clipboardCopy,
      tuiMouse: DEFAULT_UI_SETTINGS.tuiMouse,
      setup: DEFAULT_UI_SETTINGS.setup,
      newProject: DEFAULT_UI_SETTINGS.newProject,
      sidebar: DEFAULT_UI_SETTINGS.sidebar,
      login: DEFAULT_UI_SETTINGS.login,
      settingsTab: DEFAULT_UI_SETTINGS.settingsTab,
      quota: DEFAULT_UI_SETTINGS.quota,
      security: DEFAULT_UI_SETTINGS.security,
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
    expect(parseUiSettings({}).setup).toEqual({
      open: 'auto',
      readTimeoutMs: 5000,
      reviewNotes: 'grouped',
      modelPick: 'preset',
      executorsInput: 'list',
      executorsLayout: 'table',
    });
    expect(
      parseUiSettings({
        setup: {
          open: 'never',
          readTimeoutMs: 900,
          reviewNotes: 'all',
          modelPick: 'none',
          executorsInput: 'prompt',
          executorsLayout: 'list',
        },
      }).setup,
    ).toEqual({
      open: 'never',
      readTimeoutMs: 900,
      reviewNotes: 'all',
      modelPick: 'none',
      executorsInput: 'prompt',
      executorsLayout: 'list',
    });
    // N335: a layout the TUI does not know falls back to table.
    expect(parseUiSettings({ setup: { executorsLayout: 'grid' } }).setup.executorsLayout).toBe(
      'table',
    );
    // N333: a mode of executorsInput the TUI does not know falls back to list.
    expect(parseUiSettings({ setup: { executorsInput: 'some' } }).setup.executorsInput).toBe(
      'list',
    );
    // N324: a mode of modelPick the TUI does not know falls back to preset.
    expect(parseUiSettings({ setup: { modelPick: 'some' } }).setup.modelPick).toBe('preset');
    // N324: a mode the TUI does not know falls back to grouped.
    expect(parseUiSettings({ setup: { reviewNotes: 'some' } }).setup.reviewNotes).toBe('grouped');
    expect(parseUiSettings({ setup: { open: 'always', readTimeoutMs: 5 } }).setup).toEqual(
      DEFAULT_UI_SETTINGS.setup,
    );
    expect(parseUiSettings({ setup: 3 }).setup).toEqual(DEFAULT_UI_SETTINGS.setup);
  });

  it('reads ui.newProject of P22 and falls back key by key', () => {
    expect(parseUiSettings({}).newProject).toEqual({
      repo: 'cwd',
      type: 'chat',
      picker: 'browser',
      hidden: 'hide',
      favorites: [],
    });
    expect(parseUiSettings({ newProject: { repo: 'git_root' } }).newProject.repo).toBe('git_root');
    expect(parseUiSettings({ newProject: { repo: 'empty' } }).newProject.repo).toBe('empty');
    expect(parseUiSettings({ newProject: { repo: 'home' } }).newProject).toEqual(
      DEFAULT_UI_SETTINGS.newProject,
    );
    expect(parseUiSettings({ newProject: 3 }).newProject).toEqual(DEFAULT_UI_SETTINGS.newProject);
  });

  it('reads ui.newProject of N332 (picker, hidden, favorites) and falls back key by key', () => {
    expect(parseUiSettings({ newProject: { picker: 'path' } }).newProject.picker).toBe('path');
    expect(parseUiSettings({ newProject: { picker: 'tree' } }).newProject.picker).toBe('browser');
    expect(parseUiSettings({ newProject: { hidden: 'show' } }).newProject.hidden).toBe('show');
    expect(parseUiSettings({ newProject: { hidden: 'all' } }).newProject.hidden).toBe('hide');
    expect(
      parseUiSettings({ newProject: { favorites: ['/a', 3, '', '/b'] } }).newProject.favorites,
    ).toEqual(['/a', '/b']);
    expect(parseUiSettings({ newProject: { favorites: '/a' } }).newProject.favorites).toEqual([]);
  });

  it('reads ui.sidebar of P11 and falls back key by key', () => {
    expect(parseUiSettings({}).sidebar).toEqual({ finishedPlays: 'collapsed', finishedLimit: 20 });
    expect(
      parseUiSettings({ sidebar: { finishedPlays: 'expanded', finishedLimit: 5 } }).sidebar,
    ).toEqual({ finishedPlays: 'expanded', finishedLimit: 5 });
    expect(parseUiSettings({ sidebar: { finishedPlays: 'hidden' } }).sidebar.finishedPlays).toBe(
      'hidden',
    );
    expect(
      parseUiSettings({ sidebar: { finishedPlays: 'always', finishedLimit: 0 } }).sidebar,
    ).toEqual(DEFAULT_UI_SETTINGS.sidebar);
    expect(parseUiSettings({ sidebar: 3 }).sidebar).toEqual(DEFAULT_UI_SETTINGS.sidebar);
  });

  it('reads ui.theme and falls back to otheater', () => {
    expect(parseUiSettings({}).theme).toBe('otheater');
    expect(parseUiSettings({ theme: 'terminal' }).theme).toBe('terminal');
    expect(parseUiSettings({ theme: 'otheater' }).theme).toBe('otheater');
    expect(parseUiSettings({ theme: 'solarized' }).theme).toBe('otheater');
    expect(parseUiSettings({ theme: 3 }).theme).toBe('otheater');
  });

  it('reads ui.settingsTab and falls back key by key', () => {
    expect(
      parseUiSettings({
        settingsTab: { limits: 'open', roles: 'list', modelsAfterLogin: 'always' },
      }).settingsTab,
    ).toEqual({ limits: 'open', roles: 'list', modelsAfterLogin: 'always' });
    expect(
      parseUiSettings({ settingsTab: { limits: 'shut', modelsAfterLogin: 'never' } }).settingsTab,
    ).toEqual({ limits: 'folded', roles: 'line', modelsAfterLogin: 'empty' });
  });

  it('reads ui.quota and falls back to remaining (N330, [proposta])', () => {
    expect(parseUiSettings({}).quota).toEqual({ show: 'remaining' });
    expect(parseUiSettings({ quota: { show: 'used' } }).quota.show).toBe('used');
    expect(parseUiSettings({ quota: { show: 'left' } }).quota.show).toBe('remaining');
    expect(parseUiSettings({ quota: 3 }).quota.show).toBe('remaining');
  });

  it('reads ui.security.banner and falls back to on (N334, [proposta])', () => {
    expect(parseUiSettings({}).security).toEqual({ banner: 'on' });
    expect(parseUiSettings({ security: { banner: 'off' } }).security.banner).toBe('off');
    expect(parseUiSettings({ security: { banner: 'hide' } }).security.banner).toBe('on');
    expect(parseUiSettings({ security: 3 }).security.banner).toBe('on');
  });

  it('reads ui.login and falls back to auto', () => {
    expect(parseUiSettings({}).login).toEqual({ browser: 'auto' });
    expect(parseUiSettings({ login: { browser: 'key' } }).login.browser).toBe('key');
    expect(parseUiSettings({ login: { browser: 'off' } }).login.browser).toBe('off');
    expect(parseUiSettings({ login: { browser: 'always' } }).login).toEqual(
      DEFAULT_UI_SETTINGS.login,
    );
    expect(parseUiSettings({ login: 3 }).login).toEqual(DEFAULT_UI_SETTINGS.login);
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

  it('ui.keyboard.protocol is auto by default, takes the other modes and falls back on the rest', () => {
    expect(DEFAULT_UI_SETTINGS.keyboard).toEqual({ protocol: 'auto' });
    expect(parseUiSettings({}).keyboard).toEqual({ protocol: 'auto' });
    expect(parseUiSettings({ keyboard: { protocol: 'kitty' } }).keyboard.protocol).toBe('kitty');
    expect(parseUiSettings({ keyboard: { protocol: 'off' } }).keyboard.protocol).toBe('off');
    expect(parseUiSettings({ keyboard: { protocol: 'legacy' } }).keyboard.protocol).toBe('auto');
    expect(parseUiSettings({ keyboard: 'kitty' }).keyboard).toEqual({ protocol: 'auto' });
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
