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

/** The text box actions: id, keys in `agents` and keys in `classic`. */
type TextBoxRow = readonly [name: string, agents: readonly string[], classic?: readonly string[]];
const TEXT_BOX_KEYS: readonly TextBoxRow[] = [
  ['submit', ['Enter']],
  ['newline', ['Ctrl+J', 'Shift+Enter', 'Alt+Enter'], ['Shift+Enter', 'Alt+Enter']],
  ['left', ['Left', 'Ctrl+B'], ['Left']],
  ['right', ['Right', 'Ctrl+F'], ['Right']],
  ['wordLeft', ['Ctrl+Left', 'Alt+B'], ['Alt+B']],
  ['wordRight', ['Ctrl+Right', 'Alt+F'], ['Alt+F']],
  ['lineStart', ['Home', 'Ctrl+A']],
  ['lineEnd', ['End', 'Ctrl+E']],
  ['up', ['Up']],
  ['down', ['Down']],
  ['backspace', ['Backspace']],
  ['delete', ['Delete']],
  ['killToEnd', ['Ctrl+K'], []],
  ['killToStart', ['Ctrl+U']],
  ['killWordBack', ['Ctrl+W', 'Alt+Backspace'], ['Alt+Backspace']],
  ['killWordForward', ['Alt+D']],
  ['yank', ['Ctrl+Y']],
  ['historySearch', ['Ctrl+R']],
  ['externalEditor', ['Ctrl+G']],
  ['pasteImage', ['Ctrl+V']],
  ['cancel', ['Esc']],
];

function textBoxActions(): NonNullable<UiRegistryDefinition['actions']> {
  return TEXT_BOX_KEYS.map(([name, agents, classic]) => ({
    id: `input.${name}`,
    textKey: `actions.input.${name}`,
    group: 'input',
    context: 'textBox' as const,
    surfaces: ['tui' as const],
    // The editing keys are not commands of the palette: they act on the text the cursor is in.
    palette: false,
    keys: terminalKeys(agents, classic),
  }));
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
    { id: 'navigation', textKey: 'groups.navigation', order: 25 },
    { id: 'decision', textKey: 'groups.decision', order: 30 },
    { id: 'input', textKey: 'groups.input', order: 35 },
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
      id: 'chat.scrollUp',
      textKey: 'actions.chat.scrollUp',
      group: 'navigation',
      context: 'chat',
      palette: false,
      keys: terminalKeys(['PageUp']),
      bar: { textKey: 'bar.chat.scroll', order: 12 },
    },
    {
      id: 'chat.scrollDown',
      textKey: 'actions.chat.scrollDown',
      group: 'navigation',
      context: 'chat',
      palette: false,
      keys: terminalKeys(['PageDown']),
    },
    {
      id: 'chat.scrollTop',
      textKey: 'actions.chat.scrollTop',
      group: 'navigation',
      context: 'chat',
      palette: false,
      keys: terminalKeys(['Ctrl+Home']),
    },
    {
      id: 'chat.scrollBottom',
      textKey: 'actions.chat.scrollBottom',
      group: 'navigation',
      context: 'chat',
      palette: false,
      keys: terminalKeys(['Ctrl+End']),
    },
    {
      id: 'edge.narrow',
      textKey: 'actions.edge.narrow',
      group: 'navigation',
      context: 'edge',
      palette: false,
      keys: terminalKeys(['Left']),
      bar: { textKey: 'bar.edge.resize', order: 12 },
    },
    {
      id: 'edge.widen',
      textKey: 'actions.edge.widen',
      group: 'navigation',
      context: 'edge',
      palette: false,
      keys: terminalKeys(['Right']),
    },
    {
      id: 'sidebar.up',
      textKey: 'actions.sidebar.up',
      group: 'navigation',
      context: 'sidebar',
      palette: false,
      keys: terminalKeys(['Up']),
    },
    {
      id: 'sidebar.down',
      textKey: 'actions.sidebar.down',
      group: 'navigation',
      context: 'sidebar',
      palette: false,
      keys: terminalKeys(['Down']),
    },
    {
      id: 'sidebar.activate',
      textKey: 'actions.sidebar.activate',
      group: 'navigation',
      context: 'sidebar',
      palette: false,
      keys: terminalKeys(['Enter']),
      bar: { textKey: 'bar.sidebar.activate', order: 12 },
    },
    {
      id: 'panel.prevTab',
      textKey: 'actions.panel.prevTab',
      group: 'navigation',
      context: 'panel',
      palette: false,
      keys: terminalKeys(['Left']),
      bar: { textKey: 'bar.panel.tabs', order: 12 },
    },
    {
      id: 'panel.nextTab',
      textKey: 'actions.panel.nextTab',
      group: 'navigation',
      context: 'panel',
      palette: false,
      keys: terminalKeys(['Right']),
    },
    {
      id: 'panel.up',
      textKey: 'actions.panel.up',
      group: 'navigation',
      context: 'panel',
      palette: false,
      keys: terminalKeys(['Up']),
    },
    {
      id: 'panel.down',
      textKey: 'actions.panel.down',
      group: 'navigation',
      context: 'panel',
      palette: false,
      keys: terminalKeys(['Down']),
    },
    {
      id: 'panel.pageUp',
      textKey: 'actions.panel.pageUp',
      group: 'navigation',
      context: 'panel',
      palette: false,
      keys: terminalKeys(['PageUp']),
    },
    {
      id: 'panel.pageDown',
      textKey: 'actions.panel.pageDown',
      group: 'navigation',
      context: 'panel',
      palette: false,
      keys: terminalKeys(['PageDown']),
    },
    {
      id: 'panel.activate',
      textKey: 'actions.panel.activate',
      group: 'navigation',
      context: 'panel',
      palette: false,
      keys: terminalKeys(['Enter']),
      bar: { textKey: 'bar.panel.activate', order: 14 },
    },
    {
      id: 'overlay.close',
      textKey: 'actions.overlay.close',
      group: 'navigation',
      context: 'overlay',
      palette: false,
      keys: terminalKeys(['Esc']),
      bar: { textKey: 'bar.overlay.close', order: 12 },
    },
    {
      id: 'overlay.pageUp',
      textKey: 'actions.overlay.pageUp',
      group: 'navigation',
      context: 'overlay',
      palette: false,
      keys: terminalKeys(['PageUp']),
    },
    {
      id: 'overlay.pageDown',
      textKey: 'actions.overlay.pageDown',
      group: 'navigation',
      context: 'overlay',
      palette: false,
      keys: terminalKeys(['PageDown']),
    },
    {
      id: 'decision.answer',
      textKey: 'actions.decision.answer',
      group: 'decision',
      context: 'decision',
      keys: terminalKeys(['Up', 'Down', 'Space', 'Enter']),
      bar: { textKey: 'bar.decision.answer', order: 15 },
    },
    // The chat of the Producer (P12 of docs/18): the Director's decision card, the / suggestions and
    // the stop of the Director's reply. `decision.answer` above stays the card's own keys.
    {
      id: 'decision.aside',
      textKey: 'actions.decision.aside',
      group: 'decision',
      context: 'decision',
      palette: false,
      keys: terminalKeys(['Esc']),
      bar: { textKey: 'bar.decision.aside', order: 16 },
    },
    {
      id: 'decision.open',
      textKey: 'actions.decision.open',
      group: 'decision',
      context: 'chat',
      keys: terminalKeys(['Ctrl+O']),
    },
    {
      id: 'chat.suggestNext',
      textKey: 'actions.chat.suggestNext',
      group: 'navigation',
      context: 'chat',
      palette: false,
      keys: terminalKeys(['Ctrl+N']),
    },
    {
      id: 'chat.suggestPrev',
      textKey: 'actions.chat.suggestPrev',
      group: 'navigation',
      context: 'chat',
      palette: false,
      keys: terminalKeys(['Ctrl+P']),
    },
    {
      id: 'chat.stop',
      textKey: 'actions.chat.stop',
      group: 'navigation',
      context: 'chat',
      keys: terminalKeys(['Esc']),
    },
    // The text box of the Producer (N35, P10 of docs/18). In `agents` it has the editing keys of the
    // coding agents and of the readline; in `classic` the Ctrl keys the layout used in v0.7 stay with
    // the layout (Ctrl+B, J, K, T, W and Ctrl+←/→), so the box gives those up.
    ...textBoxActions(),
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
