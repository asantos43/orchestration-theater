// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_REGISTRY,
  derivePalette,
  deriveHelp,
  deriveShortcutBar,
  detectKeymapEnvironment,
  filterPalette,
  formatKeyLabel,
  resolveKeymap,
  type UiTranslate,
} from './index.js';

function keymapOf(platform: string, overrides = {}, preset = 'agents') {
  const result = resolveKeymap(DEFAULT_UI_REGISTRY, {
    preset,
    overrides,
    environment: detectKeymapEnvironment({}, platform),
  });
  if (!result.ok) throw new Error('keymap refused');
  return result.keymap;
}

/** A translator that shows the key and the parameters, enough to compare. */
const echo: UiTranslate = (key, params) =>
  params === undefined || Object.keys(params).length === 0
    ? key
    : `${key}(${Object.values(params).join(',')})`;

describe('labels', () => {
  it('writes the arrows as arrows and the Alt as Option on macOS', () => {
    expect(formatKeyLabel('Ctrl+Shift+Left', 'other')).toBe('Ctrl+Shift+←');
    expect(formatKeyLabel('Alt+S', 'other')).toBe('Alt+S');
    expect(formatKeyLabel('Alt+S', 'mac')).toBe('Option+S');
    expect(formatKeyLabel('F1', 'mac')).toBe('F1');
    expect(formatKeyLabel('not a key', 'other')).toBe('not a key');
  });
});

describe('palette, help and bar are derived from the registry and the keymap', () => {
  it('lists every entry of the palette with the keys that are active', () => {
    const rows = derivePalette(DEFAULT_UI_REGISTRY, keymapOf('linux', { 'tabs.add': 'Alt+T' }));
    const add = rows.find((row) => row.id === 'tabs.add');
    expect(add?.keys).toEqual(['Alt+T']);
    expect(add?.labels).toEqual(['Alt+T']);
    expect(rows.find((row) => row.id === 'tabs.open.settings')?.labels).toEqual(['F5']);
    expect(rows.map((row) => row.id)).toContain('help.show');
  });

  it('shows the keys of macOS with Option', () => {
    const rows = derivePalette(DEFAULT_UI_REGISTRY, keymapOf('darwin'));
    expect(rows.find((row) => row.id === 'layout.toggleSidebar')?.labels).toEqual(['Option+S']);
  });

  it('groups the help by the order of the groups and keeps the entries with no key', () => {
    const help = deriveHelp(DEFAULT_UI_REGISTRY, keymapOf('linux', { 'layout.togglePanel': [] }));
    expect(help.map((group) => group.id)).toEqual([
      'layout',
      'tabs',
      'navigation',
      'decision',
      'general',
    ]);
    const layout = help.find((group) => group.id === 'layout');
    expect(layout?.rows.find((row) => row.id === 'layout.togglePanel')?.keys).toEqual([]);
    expect(help.find((group) => group.id === 'tabs')?.rows.map((row) => row.id)).toContain(
      'tabs.open.overview',
    );
  });

  it('builds the bar from the first key, by the order the entries ask for, and by context', () => {
    const keymap = keymapOf('linux');
    const global = deriveShortcutBar(DEFAULT_UI_REGISTRY, keymap);
    expect(global.map((item) => item.id)).toEqual([
      'layout.toggleSidebar',
      'layout.togglePanel',
      'tabs.add',
      'tabs.close',
      'layout.focusNext',
      'palette.open',
      'app.quit',
    ]);
    expect(global[5]?.label).toBe('Alt+K');
    const decision = deriveShortcutBar(DEFAULT_UI_REGISTRY, keymap, ['global', 'decision']);
    expect(decision.map((item) => item.id)).toContain('decision.answer');
    // the keys of the area that has the focus join the bar, and only while it has it
    const sidebar = deriveShortcutBar(DEFAULT_UI_REGISTRY, keymap, ['global', 'sidebar']);
    expect(sidebar.map((item) => item.id)).toContain('sidebar.activate');
    expect(global.map((item) => item.id)).not.toContain('sidebar.activate');
    // an action with its shortcut taken away leaves the bar
    const without = deriveShortcutBar(DEFAULT_UI_REGISTRY, keymapOf('linux', { 'app.quit': [] }));
    expect(without.map((item) => item.id)).not.toContain('app.quit');
  });

  it('filters the palette by title and id, without case or accents', () => {
    const rows = derivePalette(DEFAULT_UI_REGISTRY, keymapOf('linux'));
    const t: UiTranslate = (key, params) =>
      key === 'actions.tabs.add'
        ? 'Abrir uma aba'
        : key === 'actions.app.quit'
          ? 'Sair'
          : echo(key, params);
    expect(filterPalette(rows, '', t)).toHaveLength(rows.length);
    expect(filterPalette(rows, 'ABRIR aba', t).map((row) => row.id)).toEqual(['tabs.add']);
    expect(filterPalette(rows, 'sáir', t).map((row) => row.id)).toEqual(['app.quit']);
    expect(filterPalette(rows, 'layout.toggle', t).map((row) => row.id)).toEqual([
      'layout.toggleSidebar',
      'layout.togglePanel',
    ]);
    expect(filterPalette(rows, 'zzzz', t)).toEqual([]);
  });
});
