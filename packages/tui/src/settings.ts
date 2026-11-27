// SPDX-License-Identifier: MPL-2.0

/**
 * The `ui.*` settings the TUI uses (architecture 5.13 N37 and 5.22). The schema of the daemon
 * (`DaemonConfigSchema.ui`) is the source of truth; P7 of the plan adds `ui.render` and `ui.runtime`
 * to it. Until then this module reads them tolerantly: a missing or invalid value falls back to the
 * default here, and nothing throws. This package never imports the daemon, so the defaults are
 * repeated on purpose.
 */
import {
  DEFAULT_INPUT_SETTINGS,
  parseInputSettings,
  type InputSettings,
} from './input/settings.js';
import {
  DEFAULT_OVERVIEW_SETTINGS,
  DEFAULT_USAGE_SETTINGS,
  parseOverviewSettings,
  parseUsageSettings,
  type OverviewSettings,
  type UsageSettings,
} from './tabs/settings.js';

export const KEY_RENDER_MODES = ['flush', 'throttle'] as const;
export type KeyRenderMode = (typeof KEY_RENDER_MODES)[number];

export const INK_PATCHES = ['cache', 'grid'] as const;
export type InkPatchName = (typeof INK_PATCHES)[number];

export const KEYBOARD_PROTOCOLS = ['auto', 'kitty', 'off'] as const;
export type KeyboardProtocol = (typeof KEYBOARD_PROTOCOLS)[number];

export const LOCALE_SETTINGS = ['auto', 'en', 'pt-BR'] as const;
export type LocaleSetting = (typeof LOCALE_SETTINGS)[number];

export interface UiRenderSettings {
  /** `flush`: a key paints the frame at once. `throttle`: it waits for the frame limiter of Ink. */
  readonly keyRender: KeyRenderMode;
  readonly maxFps: number;
  /** Window to merge bursts of stream events into one update (used by the chat view, P11). */
  readonly coalesceMs: number;
  /** Memoize the components that do not depend on what changed. */
  readonly memo: boolean;
  /** Patches of `output.js` of Ink (only applied to the exact version they were made for). */
  readonly inkPatches: readonly InkPatchName[];
  /** How many messages the history view keeps rendered; 0 is all of them (P11). */
  readonly historyWindow: number;
}

/** `ui.keyboard`: the keyboard protocol the TUI asks the terminal for (see `keyboard.ts`). */
export interface UiKeyboardSettings {
  readonly protocol: KeyboardProtocol;
}

export interface UiRuntimeSettings {
  /** V8 `--max-semi-space-size`, in MB. */
  readonly maxSemiSpaceMB: number;
  /** V8 `--max-old-space-size`, in MB (a hard cap); `undefined` leaves V8's default. */
  readonly maxOldSpaceMB: number | undefined;
  /** How long the process waits for its own end before it forces the exit, in ms. */
  readonly exitGraceMs: number;
}

export const KEYMAP_PRESETS = ['agents', 'classic'] as const;
export type KeymapPresetName = (typeof KEYMAP_PRESETS)[number];

export const KEYMAP_ENVIRONMENTS = ['auto', 'none'] as const;
export type KeymapEnvironmentSetting = (typeof KEYMAP_ENVIRONMENTS)[number];

export const SCROLL_STEPS = ['page', 'half', 'line'] as const;
export type ScrollStep = (typeof SCROLL_STEPS)[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

/** `ui.tuiLayout.sidebarEdge` (N277): `tab` (drag and a stop of Tab with the arrows), `mouse` (drag only), `off` (fixed width). */
export const SIDEBAR_EDGE_MODES = ['tab', 'mouse', 'off'] as const;
export type SidebarEdgeMode = (typeof SIDEBAR_EDGE_MODES)[number];

/** `ui.keymap`: the preset, whether to follow the environment, and the person's own shortcuts. */
export interface UiKeymapSettings {
  readonly preset: KeymapPresetName;
  readonly environment: KeymapEnvironmentSetting;
  /** Action id to a combination, a list, or `[]` to take the shortcut away. */
  readonly overrides: Record<string, string | string[]>;
}

/** `ui.tuiLayout` (P9): the sizes of the common layout and how far a scroll key goes. */
export interface UiTuiLayoutSettings {
  readonly sidebarWidth: number;
  readonly railWidth: number;
  readonly minChatWidth: number;
  readonly minPanelWidth: number;
  readonly chatStep: number;
  readonly scrollStep: ScrollStep;
  /** `density` (N258): `comfortable` draws the margins of the mockup, `compact` the screen without them. */
  readonly density: Density;
  /** `sidebarEdge` (N277): how the border between the side bar and the chat is adjusted. */
  readonly sidebarEdge: SidebarEdgeMode;
}

export const TRAJECTORY_OPEN_MODES = ['none', 'last', 'all'] as const;
export type TrajectoryOpenMode = (typeof TRAJECTORY_OPEN_MODES)[number];

export const TRAJECTORY_FOLLOW_MODES = ['latest', 'play', 'direct'] as const;
export type TrajectoryFollowMode = (typeof TRAJECTORY_FOLLOW_MODES)[number];

/** `ui.trajectories` (P14): which steps of the Trajectories tab start open, how much it keeps and shows of a diff. */
export interface UiTrajectoriesSettings {
  readonly open: TrajectoryOpenMode;
  readonly keep: number;
  readonly diffLines: number;
  /** P27: what the tab follows, a play or a direct session. */
  readonly follow: TrajectoryFollowMode;
}

export const CHAT_QUEUE_MODES = ['daemon', 'hold'] as const;
export type ChatQueueMode = (typeof CHAT_QUEUE_MODES)[number];
export const CHAT_DECISION_FOCUS_MODES = ['auto', 'manual'] as const;
export type ChatDecisionFocus = (typeof CHAT_DECISION_FOCUS_MODES)[number];
export const CHAT_DECISION_CLICK_MODES = ['answer', 'select'] as const;
export type ChatDecisionClick = (typeof CHAT_DECISION_CLICK_MODES)[number];
export const CHAT_DIRECTOR_FOOTER_MODES = ['on', 'off'] as const;
export type ChatDirectorFooter = (typeof CHAT_DIRECTOR_FOOTER_MODES)[number];
export const CHAT_ESC_MODES = ['stop', 'off'] as const;
export type ChatEscMode = (typeof CHAT_ESC_MODES)[number];
export const CHAT_NO_SCENARIO_MODES = ['open', 'notice'] as const;
export type ChatNoScenarioMode = (typeof CHAT_NO_SCENARIO_MODES)[number];

/** `ui.chat` (P12): the queue while the Director is in a turn, the `/` list, decisions and Esc. */
export interface UiChatSettings {
  readonly queue: ChatQueueMode;
  /** How many commands the `/` list shows at most; 0 turns it off. */
  readonly suggestions: number;
  readonly decisionFocus: ChatDecisionFocus;
  /** What a click on an option of the decision card does (P14 of docs/19); it needs `ui.mouse: full`. */
  readonly decisionClick: ChatDecisionClick;
  readonly esc: ChatEscMode;
  /** The footer of the Director under the text box (P14 of Phase 9): `on` or `off`. */
  readonly directorFooter: ChatDirectorFooter;
  /** How many of the last events of the scenario the chat shows on opening (P26); 0 opens it empty. */
  readonly history: number;
  /** A message sent with no scenario (N329): `open` opens the prompt and keeps it; `notice` only warns. */
  readonly noScenario: ChatNoScenarioMode;
}

export const MOUSE_MODES = ['full', 'wheel', 'off'] as const;
export type MouseMode = (typeof MOUSE_MODES)[number];

export const THEME_MODES = ['otheater', 'terminal'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const CLIPBOARD_COPY_MODES = ['osc52', 'system', 'auto', 'off'] as const;
export type ClipboardCopyMode = (typeof CLIPBOARD_COPY_MODES)[number];

/** `ui.tuiMouse` (P11): the lines a wheel notch moves and the most one selection copies, in bytes. */
export interface UiTuiMouseSettings {
  readonly wheelLines: number;
  readonly copyMaxBytes: number;
}

export const SETUP_OPEN_MODES = ['auto', 'never'] as const;
export type SetupOpenMode = (typeof SETUP_OPEN_MODES)[number];
export const SETUP_REVIEW_NOTES_MODES = ['grouped', 'all'] as const;
export type SetupReviewNotesMode = (typeof SETUP_REVIEW_NOTES_MODES)[number];
export const SETUP_MODEL_PICK_MODES = ['preset', 'all', 'none'] as const;
export type SetupModelPickMode = (typeof SETUP_MODEL_PICK_MODES)[number];
export const SETUP_EXECUTORS_INPUT_MODES = ['list', 'prompt'] as const;
export type SetupExecutorsInputMode = (typeof SETUP_EXECUTORS_INPUT_MODES)[number];

/** `ui.setup` (P17): whether the first run opens the assistant, and how long the TUI waits to know. */
export interface UiSetupSettings {
  readonly open: SetupOpenMode;
  readonly readTimeoutMs: number;
  /** How the review shows its notes (N324): folded by family of models, or every one. */
  readonly reviewNotes: SetupReviewNotesMode;
  /** Which models of the list after a login start checked (N324): the preset's, all or none. */
  readonly modelPick: SetupModelPickMode;
  /** How the step of the Executors takes them (N333): a list of models to check, or a typed line. */
  readonly executorsInput: SetupExecutorsInputMode;
}

export const NEW_PROJECT_REPO_MODES = ['cwd', 'git_root', 'empty'] as const;
export type NewProjectRepoMode = (typeof NEW_PROJECT_REPO_MODES)[number];
export const NEW_PROJECT_TYPE_MODES = ['chat', 'project'] as const;
export type NewProjectTypeMode = (typeof NEW_PROJECT_TYPE_MODES)[number];
export const NEW_PROJECT_PICKER_MODES = ['browser', 'path'] as const;
export type NewProjectPickerMode = (typeof NEW_PROJECT_PICKER_MODES)[number];
export const NEW_PROJECT_HIDDEN_MODES = ['hide', 'show'] as const;
export type NewProjectHiddenMode = (typeof NEW_PROJECT_HIDDEN_MODES)[number];

/** `ui.newProject` (P22, N329): what the prompt of a new scenario starts with. */
export interface UiNewProjectSettings {
  readonly repo: NewProjectRepoMode;
  /** The type the prompt starts on (N329). */
  readonly type: NewProjectTypeMode;
  /** How the folder of a project is asked: the folder browser or a path field (N332). */
  readonly picker: NewProjectPickerMode;
  /** Whether the folder browser starts with the hidden folders (N332). */
  readonly hidden: NewProjectHiddenMode;
  /** The folders the browser keeps at the top (N332). */
  readonly favorites: readonly string[];
}

export const SIDEBAR_FINISHED_MODES = ['collapsed', 'hidden', 'expanded'] as const;
export type SidebarFinishedMode = (typeof SIDEBAR_FINISHED_MODES)[number];

/** `ui.sidebar` (P11 of docs/19): the "Terminadas" section of the side bar. */
export interface UiSidebarSettings {
  readonly finishedPlays: SidebarFinishedMode;
  /** How many finished plays are read and listed at most. */
  readonly finishedLimit: number;
}

export const SETTINGS_TAB_LIMITS_MODES = ['folded', 'open'] as const;
export type SettingsTabLimitsMode = (typeof SETTINGS_TAB_LIMITS_MODES)[number];
export const SETTINGS_TAB_ROLES_MODES = ['line', 'list'] as const;
export type SettingsTabRolesMode = (typeof SETTINGS_TAB_ROLES_MODES)[number];

export const SETTINGS_TAB_MODELS_AFTER_LOGIN_MODES = ['empty', 'added', 'always'] as const;
export type SettingsTabModelsAfterLoginMode =
  (typeof SETTINGS_TAB_MODELS_AFTER_LOGIN_MODES)[number];

/** `ui.settingsTab` [proposta] (2026-11-26): Limits folded or open; the roles on one line or whole. */
export interface UiSettingsTabSettings {
  readonly limits: SettingsTabLimitsMode;
  readonly roles: SettingsTabRolesMode;
  /** When the list of models opens after a login (N330): see `UiSettingsTabConfigSchema`. */
  readonly modelsAfterLogin: SettingsTabModelsAfterLoginMode;
}

export const QUOTA_SHOW_MODES = ['remaining', 'used'] as const;
export type QuotaShowMode = (typeof QUOTA_SHOW_MODES)[number];

/** `ui.quota` [proposta] (N330): the percent of a quota window says what is left or what was used. */
export interface UiQuotaSettings {
  readonly show: QuotaShowMode;
}

export const LOGIN_BROWSER_MODES = ['auto', 'key', 'off'] as const;
export type LoginBrowserMode = (typeof LOGIN_BROWSER_MODES)[number];

/** `ui.login`: whether the sign-in panel opens the address in the browser (`auto`, `key`, `off`). */
export interface UiLoginSettings {
  readonly browser: LoginBrowserMode;
}

export const SECURITY_BANNER_MODES = ['on', 'off'] as const;
export type SecurityBannerMode = (typeof SECURITY_BANNER_MODES)[number];

/** `ui.security` [proposta] (N334): the fixed row about the reduced protection (`on`) or none (`off`). */
export interface UiSecuritySettings {
  readonly banner: SecurityBannerMode;
}

export interface UiSettings {
  readonly locale: LocaleSetting;
  readonly render: UiRenderSettings;
  readonly runtime: UiRuntimeSettings;
  readonly keyboard: UiKeyboardSettings;
  readonly keymap: UiKeymapSettings;
  readonly tuiLayout: UiTuiLayoutSettings;
  readonly trajectories: UiTrajectoriesSettings;
  readonly chat: UiChatSettings;
  /** `ui.input`: the text box (P10). */
  readonly input: InputSettings;
  readonly overview: OverviewSettings;
  readonly usage: UsageSettings;
  /** `ui.mouse` (N34). */
  readonly mouse: MouseMode;
  /** `ui.theme`: the colours of the screen, the palette of the mockup or the terminal's own 16. */
  readonly theme: ThemeMode;
  /** `ui.clipboard.copy` (N36). */
  readonly clipboardCopy: ClipboardCopyMode;
  readonly tuiMouse: UiTuiMouseSettings;
  readonly setup: UiSetupSettings;
  readonly newProject: UiNewProjectSettings;
  readonly sidebar: UiSidebarSettings;
  readonly login: UiLoginSettings;
  readonly settingsTab: UiSettingsTabSettings;
  readonly quota: UiQuotaSettings;
  readonly security: UiSecuritySettings;
}

export const DEFAULT_RENDER: UiRenderSettings = {
  keyRender: 'flush',
  maxFps: 30,
  coalesceMs: 16,
  memo: true,
  inkPatches: ['cache', 'grid'],
  historyWindow: 0,
};

export const DEFAULT_RUNTIME: UiRuntimeSettings = {
  maxSemiSpaceMB: 2,
  maxOldSpaceMB: undefined,
  exitGraceMs: 2000,
};

export const DEFAULT_KEYBOARD: UiKeyboardSettings = { protocol: 'auto' };

export const DEFAULT_KEYMAP: UiKeymapSettings = {
  preset: 'agents',
  environment: 'auto',
  overrides: {},
};

export const DEFAULT_TUI_LAYOUT: UiTuiLayoutSettings = {
  sidebarWidth: 30,
  railWidth: 5,
  minChatWidth: 30,
  minPanelWidth: 30,
  chatStep: 2,
  scrollStep: 'half',
  density: 'comfortable',
  sidebarEdge: 'tab',
};

export const DEFAULT_TRAJECTORIES: UiTrajectoriesSettings = {
  open: 'last',
  keep: 5000,
  diffLines: 200,
  follow: 'latest',
};

export const DEFAULT_CHAT: UiChatSettings = {
  queue: 'daemon',
  suggestions: 6,
  decisionFocus: 'auto',
  decisionClick: 'answer',
  esc: 'stop',
  directorFooter: 'on',
  history: 40,
  noScenario: 'open',
};

export const DEFAULT_TUI_MOUSE: UiTuiMouseSettings = {
  wheelLines: 3,
  copyMaxBytes: 100_000,
};

export const DEFAULT_SETUP: UiSetupSettings = {
  open: 'auto',
  readTimeoutMs: 5000,
  reviewNotes: 'grouped',
  modelPick: 'preset',
  executorsInput: 'list',
};

export const DEFAULT_NEW_PROJECT: UiNewProjectSettings = {
  repo: 'cwd',
  type: 'chat',
  picker: 'browser',
  hidden: 'hide',
  favorites: [],
};

export const DEFAULT_SIDEBAR: UiSidebarSettings = { finishedPlays: 'collapsed', finishedLimit: 20 };

export const DEFAULT_LOGIN: UiLoginSettings = { browser: 'auto' };

export const DEFAULT_SETTINGS_TAB: UiSettingsTabSettings = {
  limits: 'folded',
  roles: 'line',
  modelsAfterLogin: 'empty',
};

export const DEFAULT_QUOTA: UiQuotaSettings = { show: 'remaining' };

export const DEFAULT_SECURITY: UiSecuritySettings = { banner: 'on' };

export const DEFAULT_UI_SETTINGS: UiSettings = {
  locale: 'auto',
  render: DEFAULT_RENDER,
  runtime: DEFAULT_RUNTIME,
  keyboard: DEFAULT_KEYBOARD,
  keymap: DEFAULT_KEYMAP,
  tuiLayout: DEFAULT_TUI_LAYOUT,
  trajectories: DEFAULT_TRAJECTORIES,
  chat: DEFAULT_CHAT,
  input: DEFAULT_INPUT_SETTINGS,
  overview: DEFAULT_OVERVIEW_SETTINGS,
  usage: DEFAULT_USAGE_SETTINGS,
  mouse: 'full',
  theme: 'otheater',
  clipboardCopy: 'osc52',
  tuiMouse: DEFAULT_TUI_MOUSE,
  setup: DEFAULT_SETUP,
  newProject: DEFAULT_NEW_PROJECT,
  sidebar: DEFAULT_SIDEBAR,
  login: DEFAULT_LOGIN,
  settingsTab: DEFAULT_SETTINGS_TAB,
  quota: DEFAULT_QUOTA,
  security: DEFAULT_SECURITY,
};

/** `value` as an object (an empty one when it is not an object). */
function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function field(source: Readonly<Record<string, unknown>>, key: string): unknown {
  return source[key];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** A list of non-empty texts; what is not a text is dropped, and anything but a list is the fallback. */
function strings(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

function patches(value: unknown, fallback: readonly InkPatchName[]): readonly InkPatchName[] {
  if (!Array.isArray(value)) return fallback;
  const valid = value.filter((item): item is InkPatchName =>
    (INK_PATCHES as readonly unknown[]).includes(item),
  );
  // An unknown name is dropped, but the list was written on purpose: `[]` turns the patches off.
  return [...new Set(valid)];
}

function overrides(value: unknown): UiKeymapSettings['overrides'] {
  const source = record(value);
  const result: Record<string, string | string[]> = {};
  for (const [action, combos] of Object.entries(source)) {
    if (typeof combos === 'string') result[action] = combos;
    else if (Array.isArray(combos) && combos.every((item) => typeof item === 'string')) {
      result[action] = combos;
    }
  }
  return result;
}

/** Reads `ui` (the object under the `ui` key of the configuration), never throwing. */
export function parseUiSettings(ui: unknown): UiSettings {
  const source = record(ui);
  const render = record(field(source, 'render'));
  const runtime = record(field(source, 'runtime'));
  const oldSpace = integer(field(runtime, 'maxOldSpaceMB'), 16, 65_536, 0);
  const keyboard = record(field(source, 'keyboard'));
  const keymap = record(field(source, 'keymap'));
  const tuiLayout = record(field(source, 'tuiLayout'));
  const trajectories = record(field(source, 'trajectories'));
  const chat = record(field(source, 'chat'));
  const clipboard = record(field(source, 'clipboard'));
  const tuiMouse = record(field(source, 'tuiMouse'));
  const setup = record(field(source, 'setup'));
  const newProject = record(field(source, 'newProject'));
  const sidebar = record(field(source, 'sidebar'));
  const login = record(field(source, 'login'));
  const settingsTab = record(field(source, 'settingsTab'));
  const quota = record(field(source, 'quota'));
  const security = record(field(source, 'security'));
  return {
    locale: oneOf(field(source, 'locale'), LOCALE_SETTINGS, DEFAULT_UI_SETTINGS.locale),
    render: {
      keyRender: oneOf(field(render, 'keyRender'), KEY_RENDER_MODES, DEFAULT_RENDER.keyRender),
      maxFps: integer(field(render, 'maxFps'), 1, 240, DEFAULT_RENDER.maxFps),
      coalesceMs: integer(field(render, 'coalesceMs'), 0, 1000, DEFAULT_RENDER.coalesceMs),
      memo:
        typeof field(render, 'memo') === 'boolean'
          ? (field(render, 'memo') as boolean)
          : DEFAULT_RENDER.memo,
      inkPatches: patches(field(render, 'inkPatches'), DEFAULT_RENDER.inkPatches),
      historyWindow: integer(
        field(render, 'historyWindow'),
        0,
        1_000_000,
        DEFAULT_RENDER.historyWindow,
      ),
    },
    runtime: {
      maxSemiSpaceMB: integer(
        field(runtime, 'maxSemiSpaceMB'),
        1,
        256,
        DEFAULT_RUNTIME.maxSemiSpaceMB,
      ),
      // 0 means "not set or not valid": V8 keeps its own limit.
      maxOldSpaceMB: oldSpace === 0 ? DEFAULT_RUNTIME.maxOldSpaceMB : oldSpace,
      exitGraceMs: integer(field(runtime, 'exitGraceMs'), 0, 60_000, DEFAULT_RUNTIME.exitGraceMs),
    },
    keyboard: {
      protocol: oneOf(field(keyboard, 'protocol'), KEYBOARD_PROTOCOLS, DEFAULT_KEYBOARD.protocol),
    },
    keymap: {
      preset: oneOf(field(keymap, 'preset'), KEYMAP_PRESETS, DEFAULT_KEYMAP.preset),
      environment: oneOf(
        field(keymap, 'environment'),
        KEYMAP_ENVIRONMENTS,
        DEFAULT_KEYMAP.environment,
      ),
      overrides: overrides(field(keymap, 'overrides')),
    },
    tuiLayout: {
      sidebarWidth: integer(
        field(tuiLayout, 'sidebarWidth'),
        16,
        80,
        DEFAULT_TUI_LAYOUT.sidebarWidth,
      ),
      railWidth: integer(field(tuiLayout, 'railWidth'), 3, 16, DEFAULT_TUI_LAYOUT.railWidth),
      minChatWidth: integer(
        field(tuiLayout, 'minChatWidth'),
        20,
        200,
        DEFAULT_TUI_LAYOUT.minChatWidth,
      ),
      minPanelWidth: integer(
        field(tuiLayout, 'minPanelWidth'),
        20,
        200,
        DEFAULT_TUI_LAYOUT.minPanelWidth,
      ),
      chatStep: integer(field(tuiLayout, 'chatStep'), 1, 20, DEFAULT_TUI_LAYOUT.chatStep),
      scrollStep: oneOf(
        field(tuiLayout, 'scrollStep'),
        SCROLL_STEPS,
        DEFAULT_TUI_LAYOUT.scrollStep,
      ),
      density: oneOf(field(tuiLayout, 'density'), DENSITIES, DEFAULT_TUI_LAYOUT.density),
      sidebarEdge: oneOf(
        field(tuiLayout, 'sidebarEdge'),
        SIDEBAR_EDGE_MODES,
        DEFAULT_TUI_LAYOUT.sidebarEdge,
      ),
    },
    trajectories: {
      open: oneOf(field(trajectories, 'open'), TRAJECTORY_OPEN_MODES, DEFAULT_TRAJECTORIES.open),
      keep: integer(field(trajectories, 'keep'), 100, 100_000, DEFAULT_TRAJECTORIES.keep),
      diffLines: integer(
        field(trajectories, 'diff_lines'),
        10,
        10_000,
        DEFAULT_TRAJECTORIES.diffLines,
      ),
      follow: oneOf(
        field(trajectories, 'follow'),
        TRAJECTORY_FOLLOW_MODES,
        DEFAULT_TRAJECTORIES.follow,
      ),
    },
    chat: {
      queue: oneOf(field(chat, 'queue'), CHAT_QUEUE_MODES, DEFAULT_CHAT.queue),
      suggestions: integer(field(chat, 'suggestions'), 0, 30, DEFAULT_CHAT.suggestions),
      decisionFocus: oneOf(
        field(chat, 'decisionFocus'),
        CHAT_DECISION_FOCUS_MODES,
        DEFAULT_CHAT.decisionFocus,
      ),
      decisionClick: oneOf(
        field(chat, 'decisionClick'),
        CHAT_DECISION_CLICK_MODES,
        DEFAULT_CHAT.decisionClick,
      ),
      esc: oneOf(field(chat, 'esc'), CHAT_ESC_MODES, DEFAULT_CHAT.esc),
      directorFooter: oneOf(
        field(chat, 'directorFooter'),
        CHAT_DIRECTOR_FOOTER_MODES,
        DEFAULT_CHAT.directorFooter,
      ),
      history: integer(field(chat, 'history'), 0, 200, DEFAULT_CHAT.history),
      noScenario: oneOf(field(chat, 'noScenario'), CHAT_NO_SCENARIO_MODES, DEFAULT_CHAT.noScenario),
    },
    input: parseInputSettings(field(source, 'input')),
    overview: parseOverviewSettings(field(source, 'overview')),
    usage: parseUsageSettings(field(source, 'usage')),
    mouse: oneOf(field(source, 'mouse'), MOUSE_MODES, DEFAULT_UI_SETTINGS.mouse),
    theme: oneOf(field(source, 'theme'), THEME_MODES, DEFAULT_UI_SETTINGS.theme),
    clipboardCopy: oneOf(
      field(clipboard, 'copy'),
      CLIPBOARD_COPY_MODES,
      DEFAULT_UI_SETTINGS.clipboardCopy,
    ),
    tuiMouse: {
      wheelLines: integer(field(tuiMouse, 'wheelLines'), 1, 50, DEFAULT_TUI_MOUSE.wheelLines),
      copyMaxBytes: integer(
        field(tuiMouse, 'copyMaxBytes'),
        1,
        10_000_000,
        DEFAULT_TUI_MOUSE.copyMaxBytes,
      ),
    },
    setup: {
      open: oneOf(field(setup, 'open'), SETUP_OPEN_MODES, DEFAULT_SETUP.open),
      readTimeoutMs: integer(
        field(setup, 'readTimeoutMs'),
        100,
        60_000,
        DEFAULT_SETUP.readTimeoutMs,
      ),
      reviewNotes: oneOf(
        field(setup, 'reviewNotes'),
        SETUP_REVIEW_NOTES_MODES,
        DEFAULT_SETUP.reviewNotes,
      ),
      modelPick: oneOf(field(setup, 'modelPick'), SETUP_MODEL_PICK_MODES, DEFAULT_SETUP.modelPick),
      executorsInput: oneOf(
        field(setup, 'executorsInput'),
        SETUP_EXECUTORS_INPUT_MODES,
        DEFAULT_SETUP.executorsInput,
      ),
    },
    newProject: {
      repo: oneOf(field(newProject, 'repo'), NEW_PROJECT_REPO_MODES, DEFAULT_NEW_PROJECT.repo),
      type: oneOf(field(newProject, 'type'), NEW_PROJECT_TYPE_MODES, DEFAULT_NEW_PROJECT.type),
      picker: oneOf(
        field(newProject, 'picker'),
        NEW_PROJECT_PICKER_MODES,
        DEFAULT_NEW_PROJECT.picker,
      ),
      hidden: oneOf(
        field(newProject, 'hidden'),
        NEW_PROJECT_HIDDEN_MODES,
        DEFAULT_NEW_PROJECT.hidden,
      ),
      favorites: strings(field(newProject, 'favorites'), DEFAULT_NEW_PROJECT.favorites),
    },
    sidebar: {
      finishedPlays: oneOf(
        field(sidebar, 'finishedPlays'),
        SIDEBAR_FINISHED_MODES,
        DEFAULT_SIDEBAR.finishedPlays,
      ),
      finishedLimit: integer(
        field(sidebar, 'finishedLimit'),
        1,
        500,
        DEFAULT_SIDEBAR.finishedLimit,
      ),
    },
    login: {
      browser: oneOf(field(login, 'browser'), LOGIN_BROWSER_MODES, DEFAULT_LOGIN.browser),
    },
    settingsTab: {
      limits: oneOf(
        field(settingsTab, 'limits'),
        SETTINGS_TAB_LIMITS_MODES,
        DEFAULT_SETTINGS_TAB.limits,
      ),
      roles: oneOf(
        field(settingsTab, 'roles'),
        SETTINGS_TAB_ROLES_MODES,
        DEFAULT_SETTINGS_TAB.roles,
      ),
      modelsAfterLogin: oneOf(
        field(settingsTab, 'modelsAfterLogin'),
        SETTINGS_TAB_MODELS_AFTER_LOGIN_MODES,
        DEFAULT_SETTINGS_TAB.modelsAfterLogin,
      ),
    },
    quota: {
      show: oneOf(field(quota, 'show'), QUOTA_SHOW_MODES, DEFAULT_QUOTA.show),
    },
    security: {
      banner: oneOf(field(security, 'banner'), SECURITY_BANNER_MODES, DEFAULT_SECURITY.banner),
    },
  };
}
