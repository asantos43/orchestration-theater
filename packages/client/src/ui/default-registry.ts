// SPDX-License-Identifier: MPL-2.0
import { createUiRegistry, type UiRegistryDefinition } from './registry.js';

/**
 * The keys of the terminal in the two presets of 5.13 (N35): `agents`, the default, where the
 * text box keeps the editing keys and the layout uses Alt with a free letter, and `classic`, the
 * Ctrl keys of v0.7. When one list is given, both presets share it. The table of 5.13 has no
 * separate macOS column (the Alt is the Option), so `mac` stays free for a future difference.
 */
function terminalKeys(agents: readonly string[], classic: readonly string[] = agents) {
  return {
    tui: { agents: { default: [...agents] }, classic: { default: [...classic] } },
  };
}

/**
 * The entries of the registry for the terminal, from the table of 5.13 ("Mapa de teclas") and the
 * tabs of the work panel. The tab Agenda (Phase 9b) and the tab Plugins (Phase 9) are not here
 * yet: each one enters with a line of `tabs`, and the catalog `tui` gets its name.
 */
export const DEFAULT_UI_REGISTRY_DEFINITION: UiRegistryDefinition = {
  groups: [
    { id: 'layout', textKey: 'groups.layout', order: 10 },
    { id: 'tabs', textKey: 'groups.tabs', order: 20 },
    { id: 'decision', textKey: 'groups.decision', order: 30 },
    { id: 'general', textKey: 'groups.general', order: 40 },
  ],
  tabs: [
    { id: 'overview', textKey: 'tabs.overview', order: 10, keys: {} },
    { id: 'trajectories', textKey: 'tabs.trajectories', order: 20, keys: {} },
    { id: 'usage', textKey: 'tabs.usage', order: 30, keys: {} },
    { id: 'directives', textKey: 'tabs.directives', order: 50, keys: {} },
    { id: 'settings', textKey: 'tabs.settings', order: 60, keys: terminalKeys(['F5']) },
  ],
  actions: [
    {
      id: 'layout.toggleSidebar',
      textKey: 'actions.layout.toggleSidebar',
      group: 'layout',
      keys: terminalKeys(['Alt+S'], ['Ctrl+B']),
      bar: { textKey: 'bar.layout.toggleSidebar', order: 10 },
    },
    {
      id: 'layout.togglePanel',
      textKey: 'actions.layout.togglePanel',
      group: 'layout',
      keys: terminalKeys(['Alt+J'], ['Ctrl+J']),
      bar: { textKey: 'bar.layout.togglePanel', order: 20 },
    },
    {
      id: 'layout.narrowChat',
      textKey: 'actions.layout.narrowChat',
      group: 'layout',
      keys: terminalKeys(['Ctrl+Shift+Left'], ['Ctrl+Left']),
    },
    {
      id: 'layout.widenChat',
      textKey: 'actions.layout.widenChat',
      group: 'layout',
      keys: terminalKeys(['Ctrl+Shift+Right'], ['Ctrl+Right']),
    },
    {
      // Tab moves the focus between the chat, its edge, the work panel and the side bar; P9.
      id: 'layout.focusNext',
      textKey: 'actions.layout.focusNext',
      group: 'layout',
      keys: terminalKeys(['Tab']),
      bar: { textKey: 'bar.layout.focusNext', order: 25 },
    },
    {
      id: 'layout.focusPrev',
      textKey: 'actions.layout.focusPrev',
      group: 'layout',
      keys: terminalKeys(['Shift+Tab']),
    },
    {
      id: 'tabs.add',
      textKey: 'actions.tabs.add',
      group: 'tabs',
      keys: terminalKeys(['Alt+A'], ['Ctrl+T']),
      bar: { textKey: 'bar.tabs.add', order: 22 },
    },
    {
      id: 'tabs.close',
      textKey: 'actions.tabs.close',
      group: 'tabs',
      keys: terminalKeys(['Alt+W'], ['Ctrl+W']),
      bar: { textKey: 'bar.tabs.close', order: 24 },
    },
    {
      id: 'decision.answer',
      textKey: 'actions.decision.answer',
      group: 'decision',
      context: 'decision',
      keys: terminalKeys(['Up', 'Down', 'Space', 'Enter']),
      bar: { textKey: 'bar.decision.answer', order: 15 },
    },
    {
      id: 'palette.open',
      textKey: 'actions.palette.open',
      group: 'general',
      keys: terminalKeys(['Alt+K', 'F1'], ['Ctrl+K', 'F1']),
      bar: { textKey: 'bar.palette.open', order: 30 },
    },
    {
      // The help is the palette's own screen of shortcuts; it has no key of its own.
      id: 'help.show',
      textKey: 'actions.help.show',
      group: 'general',
    },
    {
      id: 'app.quit',
      textKey: 'actions.app.quit',
      group: 'general',
      keys: terminalKeys(['Ctrl+Q']),
      bar: { textKey: 'bar.app.quit', order: 40 },
    },
  ],
};

/** The registry of the OTheater, built when the module loads (a mistake fails at the start-up). */
export const DEFAULT_UI_REGISTRY = createUiRegistry(DEFAULT_UI_REGISTRY_DEFINITION);
