// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_REGISTRY,
  detectKeymapEnvironment,
  matchKey,
  resolveKeymap,
  resolveKeymapFromConfig,
  resolveKeymapOrPreset,
  type KeymapEnvironment,
} from './index.js';

const registry = DEFAULT_UI_REGISTRY;

function bindings(env: KeymapEnvironment | undefined, overrides = {}, preset = 'agents') {
  const result = resolveKeymap(registry, { preset, overrides, environment: env });
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result;
}

/** The table of 5.13 that every environment shares. */
const DEFAULTS: Record<string, string[]> = {
  'layout.toggleSidebar': ['Alt+S'],
  'layout.togglePanel': ['Alt+J'],
  'layout.narrowChat': ['Ctrl+Shift+Left'],
  'layout.widenChat': ['Ctrl+Shift+Right'],
  'tabs.add': ['Alt+A'],
  'tabs.close': ['Alt+W'],
  'palette.open': ['Alt+K', 'F1'],
  'tabs.open.settings': ['F5'],
  'app.quit': ['Ctrl+Q'],
  'decision.answer': ['Up', 'Down', 'Space', 'Enter'],
};

describe('environment detection', () => {
  it('reads the platform, TMUX and TERM_PROGRAM from what it is given', () => {
    expect(detectKeymapEnvironment({}, 'linux')).toEqual({
      platform: 'other',
      tmux: false,
      vscode: false,
    });
    expect(detectKeymapEnvironment({}, 'win32').platform).toBe('other');
    expect(detectKeymapEnvironment({}, 'darwin').platform).toBe('mac');
    expect(detectKeymapEnvironment({ TMUX: '/tmp/tmux-1000/default,1,0' }, 'linux').tmux).toBe(
      true,
    );
    expect(detectKeymapEnvironment({ TMUX: '' }, 'linux').tmux).toBe(false);
    expect(detectKeymapEnvironment({ TERM_PROGRAM: 'vscode' }, 'linux').vscode).toBe(true);
    expect(detectKeymapEnvironment({ TERM_PROGRAM: 'iTerm.app' }, 'darwin').vscode).toBe(false);
  });
});

describe('the keymap in three simulated environments', () => {
  const linux = detectKeymapEnvironment({}, 'linux');
  const mac = detectKeymapEnvironment({}, 'darwin');
  const tmuxVscode = detectKeymapEnvironment({ TMUX: '1', TERM_PROGRAM: 'vscode' }, 'linux');

  for (const [name, env] of [
    ['linux', linux],
    ['macOS', mac],
    ['tmux inside VS Code', tmuxVscode],
  ] as const) {
    it(`gives the 5.13 table of the preset agents on ${name}`, () => {
      const { keymap } = bindings(env);
      for (const [id, combos] of Object.entries(DEFAULTS))
        expect([...(keymap.bindings.get(id) ?? [])].sort(), id).toEqual([...combos].sort());
    });
  }

  it('warns on macOS that the Alt keys are the Option and that F keys may need Fn', () => {
    const codes = bindings(mac).warnings.map((notice) => notice.code);
    expect(codes).toContain('mac_option');
    expect(codes).toContain('mac_fn');
    expect(bindings(linux).warnings).toEqual([]);
  });

  it('warns about the keys VS Code may take, and puts the ones that reach the TUI first', () => {
    const { keymap, warnings } = bindings(tmuxVscode);
    expect(warnings.some((notice) => notice.code === 'vscode_capture')).toBe(true);
    // F1 is the palette of VS Code: the first key of the palette is the one the TUI receives.
    expect(keymap.bindings.get('palette.open')?.[0]).toBe('Alt+K');
  });

  it('warns that Ctrl+B is the prefix of tmux when the classic preset runs inside it', () => {
    const { warnings } = bindings(tmuxVscode, {}, 'classic');
    expect(
      warnings.some((notice) => notice.code === 'tmux_prefix' && notice.combo === 'Ctrl+B'),
    ).toBe(true);
    expect(bindings(linux, {}, 'classic').warnings).toEqual([]);
  });

  it('has the Ctrl keys of v0.7 in the classic preset', () => {
    const { keymap } = bindings(linux, {}, 'classic');
    expect(keymap.bindings.get('layout.toggleSidebar')).toEqual(['Ctrl+B']);
    expect(keymap.bindings.get('tabs.add')).toEqual(['Ctrl+T']);
    expect(keymap.bindings.get('tabs.close')).toEqual(['Ctrl+W']);
  });

  it('finds the action of a key press by the contexts alive', () => {
    const { keymap } = bindings(linux);
    expect(matchKey(keymap, registry, 'alt+s')).toBe('layout.toggleSidebar');
    expect(matchKey(keymap, registry, 'Enter')).toBeUndefined();
    expect(matchKey(keymap, registry, 'Enter', ['global', 'decision'])).toBe('decision.answer');
    expect(matchKey(keymap, registry, 'Alt+Z')).toBeUndefined();
  });
});

describe('ui.keymap.overrides', () => {
  const env = detectKeymapEnvironment({}, 'linux');

  it('replaces the preset keys of an action, takes one away with [], and takes a list', () => {
    const { keymap } = bindings(env, {
      'layout.toggleSidebar': 'Alt+Z',
      'layout.togglePanel': [],
      'tabs.add': ['Alt+T', 'F7'],
    });
    expect(keymap.bindings.get('layout.toggleSidebar')).toEqual(['Alt+Z']);
    expect(keymap.bindings.get('layout.togglePanel')).toEqual([]);
    expect(keymap.bindings.get('tabs.add')).toEqual(['Alt+T', 'F7']);
  });

  it('refuses a shortcut that another action already has', () => {
    const result = resolveKeymap(registry, {
      preset: 'agents',
      overrides: { 'tabs.add': 'Alt+S' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('duplicate');
    expect(result.errors[0]?.message).toMatch(/Alt\+S/);
    expect(result.errors[0]?.text.key).toBe('keymap.errors.duplicate');
  });

  it('refuses the same shortcut written twice for one action', () => {
    const result = resolveKeymap(registry, {
      preset: 'agents',
      overrides: { 'tabs.add': ['Alt+Q', 'alt+q'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.text.key).toBe('keymap.errors.repeated');
  });

  it('refuses an unknown action, an invalid combination and one a terminal cannot send', () => {
    const codes = (overrides: Record<string, string>) => {
      const result = resolveKeymap(registry, { preset: 'agents', overrides });
      return result.ok ? [] : result.errors.map((error) => error.code);
    };
    expect(codes({ 'nope.nothing': 'Alt+Q' })).toEqual(['unknown_action']);
    expect(codes({ 'tabs.add': 'Alt+Foo' })).toEqual(['invalid_combo']);
    expect(codes({ 'tabs.add': 'Cmd+T' })).toEqual(['terminal_unsupported']);
    expect(codes({ 'tabs.add': 'Ctrl+Shift+T' })).toEqual(['terminal_unsupported']);
    expect(codes({ 'tabs.add': 'T' })).toEqual(['terminal_unsupported']);
  });

  it('warns about a shortcut on the list of collisions of 5.13, but does not refuse it', () => {
    const { warnings } = bindings(env, { 'tabs.add': 'Ctrl+A', 'tabs.close': 'Ctrl+Left' });
    const collisions = warnings.filter((notice) => notice.code === 'collision');
    expect(collisions.map((notice) => notice.combo).sort()).toEqual(['Ctrl+A', 'Ctrl+Left']);
    expect(collisions[0]?.text.key).toBe('keymap.notices.collision');
    expect(bindings(env, { 'tabs.add': 'Alt+Q' }).warnings).toEqual([]);
  });

  it('falls back to the plain preset with the errors when the overrides are refused', () => {
    const result = resolveKeymapOrPreset(registry, {
      preset: 'agents',
      overrides: { 'tabs.add': 'Alt+S' },
    });
    expect(result.errors).toHaveLength(1);
    expect(result.keymap.bindings.get('tabs.add')).toEqual(['Alt+A']);
  });

  it('ignores the environment with ui.keymap.environment: none', () => {
    const result = resolveKeymapFromConfig(
      registry,
      { preset: 'agents', environment: 'none', overrides: {} },
      detectKeymapEnvironment({ TERM_PROGRAM: 'vscode' }, 'darwin'),
    );
    expect(result.warnings).toEqual([]);
    expect(result.keymap.platform).toBe('other');
  });
});
