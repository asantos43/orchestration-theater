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
 * The actions of the tab Settings (P16 of docs/18): the keys of its items, in the context `settings`
 * (alive with `panel`, so the arrows and Enter keep walking and folding the sections; the tab
 * Directives may take the same letters). [proposta] The letters are bare
 * because the tab has no text field open while they act; with a field open the shell hands every
 * key to it. They are not commands of the palette: they act on the item under the cursor.
 */
const SETTINGS_KEYS: readonly (readonly [
  name: string,
  keys: readonly string[],
  bar?: readonly [textKey: string, order: number],
])[] = [
  ['itemPrev', ['K']],
  ['itemNext', ['J']],
  ['moveUp', ['Shift+Up']],
  ['moveDown', ['Shift+Down']],
  // In the bar (N324, the owner's test on Windows: "L" did nothing on an empty list and no key
  // said how to add an account). [proposta] Which keys go to the bar, and their order.
  ['login', ['L'], ['bar.settings.login', 17]],
  ['add', ['A'], ['bar.settings.add', 16]],
  ['remove', ['X']],
  ['edit', ['E']],
  ['unset', ['U']],
  ['scope', ['S']],
  // The setup assistant (P17), opened from the tab: add an account, change the preset, or resume
  // (or redo) the first run. [proposta] `W` for the wizard; no tab key takes it.
  ['assistantAccount', ['W'], ['bar.settings.assistant', 18]],
  ['assistantPreset', ['P']],
  ['assistantFirstRun', ['Shift+W']],
];

function settingsActions(): NonNullable<UiRegistryDefinition['actions']> {
  return SETTINGS_KEYS.map(([name, keys, bar]) => ({
    id: `settings.${name}`,
    textKey: `actions.settings.${name}`,
    group: 'settings',
    context: 'settings' as const,
    surfaces: ['tui' as const],
    palette: false,
    keys: terminalKeys(keys),
    ...(bar === undefined ? {} : { bar: { textKey: bar[0], order: bar[1] } }),
  }));
}

/**
 * The actions of the tab Plugins (P11 of Phase 9), in the context `plugins`: alive with `panel`, so
 * the arrows and Enter keep walking and folding the sections. [proposta] Bare letters, like the
 * tab Settings: the tab has no text field (the secrets are set with `ot plugin secret set`, there
 * is no route to write one), and the confirmation of a command takes the keyboard while it is
 * open. They are not commands of the palette: they act on the plugin under the cursor.
 */
const PLUGINS_KEYS: readonly (readonly [name: string, keys: readonly string[]])[] = [
  ['itemPrev', ['K']],
  ['itemNext', ['J']],
  ['enable', ['E']],
  ['disable', ['D']],
  // Picks the next action block of the panel (it wraps), and runs the one picked.
  ['actionNext', ['N']],
  ['action', ['A']],
  ['reload', ['R']],
];

function pluginsActions(): NonNullable<UiRegistryDefinition['actions']> {
  return PLUGINS_KEYS.map(([name, keys]) => ({
    id: `plugins.${name}`,
    textKey: `actions.plugins.${name}`,
    group: 'plugins',
    context: 'plugins' as const,
    surfaces: ['tui' as const],
    palette: false,
    keys: terminalKeys(keys),
  }));
}

/**
 * The actions of the setup assistant (P17 of docs/18), in the context `setup`: the screen of the
 * assistant is not an area of the layout, so these keys are alive only while it is open. [proposta]
 * The letters are bare because a field is read by the screen itself, which takes every key while a
 * line is being typed. They are not commands of the palette: they act on the step on screen.
 * `advance` is Enter on every step (answer the step, or confirm at the review); `back` is Esc (go
 * back one step, or leave the assistant at the first one, keeping the run to resume).
 */
const SETUP_KEYS: readonly (readonly [
  name: string,
  keys: readonly string[],
  bar?: readonly [textKey: string, order: number],
])[] = [
  ['advance', ['Enter'], ['bar.setup.advance', 10]],
  ['back', ['Esc'], ['bar.setup.back', 12]],
  ['itemPrev', ['Up', 'K']],
  ['itemNext', ['Down', 'J']],
  ['toggle', ['Space'], ['bar.setup.toggle', 14]],
  ['moveUp', ['Shift+Up']],
  ['moveDown', ['Shift+Down']],
  ['add', ['A'], ['bar.setup.add', 16]],
  ['edit', ['E'], ['bar.setup.edit', 18]],
  ['remove', ['X']],
  ['install', ['I'], ['bar.setup.install', 17]],
  ['reload', ['R']],
  ['cancel', ['C'], ['bar.setup.cancel', 20]],
];

function setupActions(): NonNullable<UiRegistryDefinition['actions']> {
  return SETUP_KEYS.map(([name, keys, bar]) => ({
    id: `setup.${name}`,
    textKey: `actions.setup.${name}`,
    group: 'setup',
    context: 'setup' as const,
    surfaces: ['tui' as const],
    palette: false,
    keys: terminalKeys(keys),
    ...(bar === undefined ? {} : { bar: { textKey: bar[0], order: bar[1] } }),
  }));
}

/**
 * The entries of the registry for the terminal, from the table of 5.13 ("Mapa de teclas") and the
 * tabs of the work panel. The tab Agenda (Phase 9b) is not here yet: it enters with a line of
 * `tabs`, and the catalog `tui` gets its name.
 */
export const DEFAULT_UI_REGISTRY_DEFINITION: UiRegistryDefinition = {
  groups: [
    { id: 'layout', textKey: 'groups.layout', order: 10 },
    { id: 'tabs', textKey: 'groups.tabs', order: 20 },
    { id: 'navigation', textKey: 'groups.navigation', order: 25 },
    { id: 'decision', textKey: 'groups.decision', order: 30 },
    { id: 'input', textKey: 'groups.input', order: 35 },
    { id: 'settings', textKey: 'groups.settings', order: 37 },
    { id: 'plugins', textKey: 'groups.plugins', order: 39 },
    { id: 'setup', textKey: 'groups.setup', order: 38 },
    { id: 'general', textKey: 'groups.general', order: 40 },
  ],
  tabs: [
    { id: 'overview', textKey: 'tabs.overview', order: 10, keys: {} },
    { id: 'trajectories', textKey: 'tabs.trajectories', order: 20, keys: {} },
    { id: 'usage', textKey: 'tabs.usage', order: 30, keys: {} },
    { id: 'direct', textKey: 'tabs.direct', order: 40, keys: {} },
    { id: 'directives', textKey: 'tabs.directives', order: 50, keys: {} },
    { id: 'settings', textKey: 'tabs.settings', order: 60, keys: terminalKeys(['F5']) },
    { id: 'plugins', textKey: 'tabs.plugins', order: 70, keys: terminalKeys(['F6']) },
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
      // Tab moves the focus between the chat, its edge, the work panel, the side bar and the edge of the side bar (N277); P9.
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
      // [proposta] The border between the side bar and the chat (N277): the same keys as the one of
      // the chat, in a context of its own so each border has its own bar of shortcuts.
      id: 'sidebarEdge.narrow',
      textKey: 'actions.sidebarEdge.narrow',
      group: 'navigation',
      context: 'sidebarEdge',
      palette: false,
      keys: terminalKeys(['Left']),
      bar: { textKey: 'bar.sidebarEdge.resize', order: 12 },
    },
    {
      id: 'sidebarEdge.widen',
      textKey: 'actions.sidebarEdge.widen',
      group: 'navigation',
      context: 'sidebarEdge',
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
      // [proposta] `N` in the side bar; the palette reaches it from any area (P22 of docs/18).
      id: 'sidebar.newProject',
      textKey: 'actions.sidebar.newProject',
      group: 'navigation',
      context: 'sidebar',
      keys: terminalKeys(['N']),
      bar: { textKey: 'bar.sidebar.newProject', order: 14 },
    },
    {
      // [proposta] `F` in the side bar opens and closes the "Terminadas" section (P11 of docs/19).
      id: 'sidebar.toggleFinished',
      textKey: 'actions.sidebar.toggleFinished',
      group: 'navigation',
      context: 'sidebar',
      keys: terminalKeys(['F']),
      bar: { textKey: 'bar.sidebar.toggleFinished', order: 15 },
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
    // The tab Direct session (P19 of docs/18, 5.20): the panel is focused and the tab is the open one
    // (the context `direct`). Bare letters, like the tab Directives; the text of the conversation is
    // typed after `direct.talk`, which takes the keyboard. [proposta]
    {
      id: 'direct.new',
      textKey: 'actions.direct.new',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['N']),
    },
    {
      id: 'direct.talk',
      textKey: 'actions.direct.talk',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['T']),
    },
    {
      id: 'direct.cancel',
      textKey: 'actions.direct.cancel',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['C']),
    },
    {
      id: 'direct.close',
      textKey: 'actions.direct.close',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['X']),
    },
    {
      id: 'direct.promoteDemand',
      textKey: 'actions.direct.promoteDemand',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['D']),
    },
    {
      id: 'direct.promotePiece',
      textKey: 'actions.direct.promotePiece',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['P']),
    },
    {
      id: 'direct.previous',
      textKey: 'actions.direct.previous',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['Shift+Up', 'K']),
    },
    {
      id: 'direct.next',
      textKey: 'actions.direct.next',
      group: 'navigation',
      context: 'direct',
      palette: false,
      keys: terminalKeys(['Shift+Down', 'J']),
    },
    // The tab Directives (P15 of docs/18, 5.17): the panel is focused and the tab is the open one
    // (the context `directives`). The keys are bare letters, which a tab context allows (the text box
    // is not in focus); another tab may take the same letters.
    // They are not commands of the palette: each one acts on the order the tab has selected.
    {
      id: 'directives.new',
      textKey: 'actions.directives.new',
      group: 'navigation',
      context: 'directives',
      palette: false,
      keys: terminalKeys(['N']),
    },
    {
      id: 'directives.extend',
      textKey: 'actions.directives.extend',
      group: 'navigation',
      context: 'directives',
      palette: false,
      keys: terminalKeys(['E']),
    },
    {
      id: 'directives.suspend',
      textKey: 'actions.directives.suspend',
      group: 'navigation',
      context: 'directives',
      palette: false,
      keys: terminalKeys(['S']),
    },
    {
      id: 'directives.revoke',
      textKey: 'actions.directives.revoke',
      group: 'navigation',
      context: 'directives',
      palette: false,
      keys: terminalKeys(['R']),
    },
    {
      id: 'directives.previous',
      textKey: 'actions.directives.previous',
      group: 'navigation',
      context: 'directives',
      palette: false,
      keys: terminalKeys(['Shift+Up', 'K']),
    },
    {
      id: 'directives.next',
      textKey: 'actions.directives.next',
      group: 'navigation',
      context: 'directives',
      palette: false,
      keys: terminalKeys(['Shift+Down', 'J']),
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
      keys: terminalKeys(['Enter']),
      bar: { textKey: 'bar.decision.answer', order: 15 },
    },
    // The other keys of the decision card (P26 of docs/18, N203): the card reads them from the keymap,
    // so `ui.keymap.overrides` reaches them. The number of an option stays the digit itself.
    {
      id: 'decision.up',
      textKey: 'actions.decision.up',
      group: 'decision',
      context: 'decision',
      palette: false,
      keys: terminalKeys(['Up']),
    },
    {
      id: 'decision.down',
      textKey: 'actions.decision.down',
      group: 'decision',
      context: 'decision',
      palette: false,
      keys: terminalKeys(['Down']),
    },
    {
      id: 'decision.mark',
      textKey: 'actions.decision.mark',
      group: 'decision',
      context: 'decision',
      palette: false,
      keys: terminalKeys(['Space']),
    },
    // The chat of the Producer (P12 of docs/18): the Director's decision card, the / suggestions and
    // the stop of the Director's reply.
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
    // The picker of the Director of the scenario (P14 of Phase 9, N242): the footer under the text box
    // shows it and a click opens it too. [proposta] `Alt+M` (M of model) in both presets: no other
    // action of the chat, the text box or the layout takes it.
    {
      id: 'chat.director',
      textKey: 'actions.chat.director',
      group: 'navigation',
      context: 'chat',
      keys: terminalKeys(['Alt+M']),
    },
    // The Overview and Usage tabs (P13 of docs/18), each in the context of its tab. None shows in the
    // palette: the tab draws the keys it offers. Each can be rebound in `ui.keymap.overrides`.
    {
      id: 'overview.pausePlay',
      textKey: 'actions.overview.pausePlay',
      group: 'general',
      context: 'overview',
      palette: false,
      keys: terminalKeys(['Shift+P']),
    },
    {
      id: 'overview.resumePlay',
      textKey: 'actions.overview.resumePlay',
      group: 'general',
      context: 'overview',
      palette: false,
      keys: terminalKeys(['Shift+R']),
    },
    {
      id: 'overview.nextActor',
      textKey: 'actions.overview.nextActor',
      group: 'general',
      context: 'overview',
      palette: false,
      keys: terminalKeys(['Shift+N']),
    },
    {
      id: 'overview.pauseActor',
      textKey: 'actions.overview.pauseActor',
      group: 'general',
      context: 'overview',
      palette: false,
      keys: terminalKeys(['Shift+A']),
    },
    {
      id: 'overview.resumeActor',
      textKey: 'actions.overview.resumeActor',
      group: 'general',
      context: 'overview',
      palette: false,
      keys: terminalKeys(['Shift+U']),
    },
    {
      id: 'usage.refresh',
      textKey: 'actions.usage.refresh',
      group: 'general',
      context: 'usage',
      palette: false,
      keys: terminalKeys(['Shift+L']),
    },
    // The text box of the Producer (N35, P10 of docs/18). In `agents` it has the editing keys of the
    // coding agents and of the readline; in `classic` the Ctrl keys the layout used in v0.7 stay with
    // the layout (Ctrl+B, J, K, T, W and Ctrl+←/→), so the box gives those up.
    ...textBoxActions(),
    ...settingsActions(),
    ...pluginsActions(),
    ...setupActions(),
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
