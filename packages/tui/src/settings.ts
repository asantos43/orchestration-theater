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
}

export const TRAJECTORY_OPEN_MODES = ['none', 'last', 'all'] as const;
export type TrajectoryOpenMode = (typeof TRAJECTORY_OPEN_MODES)[number];

/** `ui.trajectories` (P14): which steps of the Trajectories tab start open, how much it keeps and shows of a diff. */
export interface UiTrajectoriesSettings {
  readonly open: TrajectoryOpenMode;
  readonly keep: number;
  readonly diffLines: number;
}

export const CHAT_QUEUE_MODES = ['daemon', 'hold'] as const;
export type ChatQueueMode = (typeof CHAT_QUEUE_MODES)[number];
export const CHAT_DECISION_FOCUS_MODES = ['auto', 'manual'] as const;
export type ChatDecisionFocus = (typeof CHAT_DECISION_FOCUS_MODES)[number];
export const CHAT_ESC_MODES = ['stop', 'off'] as const;
export type ChatEscMode = (typeof CHAT_ESC_MODES)[number];

/** `ui.chat` (P12): the queue while the Director is in a turn, the `/` list, decisions and Esc. */
export interface UiChatSettings {
  readonly queue: ChatQueueMode;
  /** How many commands the `/` list shows at most; 0 turns it off. */
  readonly suggestions: number;
  readonly decisionFocus: ChatDecisionFocus;
  readonly esc: ChatEscMode;
  /** How many of the last events of the scenario the chat shows on opening (P26); 0 opens it empty. */
  readonly history: number;
}

export const MOUSE_MODES = ['full', 'wheel', 'off'] as const;
export type MouseMode = (typeof MOUSE_MODES)[number];

export const CLIPBOARD_COPY_MODES = ['osc52', 'system', 'auto', 'off'] as const;
export type ClipboardCopyMode = (typeof CLIPBOARD_COPY_MODES)[number];

/** `ui.tuiMouse` (P11): the lines a wheel notch moves and the most one selection copies, in bytes. */
export interface UiTuiMouseSettings {
  readonly wheelLines: number;
  readonly copyMaxBytes: number;
}

export const SETUP_OPEN_MODES = ['auto', 'never'] as const;
export type SetupOpenMode = (typeof SETUP_OPEN_MODES)[number];

/** `ui.setup` (P17): whether the first run opens the assistant, and how long the TUI waits to know. */
export interface UiSetupSettings {
  readonly open: SetupOpenMode;
  readonly readTimeoutMs: number;
}

export const NEW_PROJECT_REPO_MODES = ['cwd', 'git_root', 'empty'] as const;
export type NewProjectRepoMode = (typeof NEW_PROJECT_REPO_MODES)[number];

/** `ui.newProject` (P22): what the prompt of "new project" starts with. */
export interface UiNewProjectSettings {
  readonly repo: NewProjectRepoMode;
}

export interface UiSettings {
  readonly locale: LocaleSetting;
  readonly render: UiRenderSettings;
  readonly runtime: UiRuntimeSettings;
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
  /** `ui.clipboard.copy` (N36). */
  readonly clipboardCopy: ClipboardCopyMode;
  readonly tuiMouse: UiTuiMouseSettings;
  readonly setup: UiSetupSettings;
  readonly newProject: UiNewProjectSettings;
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
};

export const DEFAULT_TRAJECTORIES: UiTrajectoriesSettings = {
  open: 'last',
  keep: 5000,
  diffLines: 200,
};

export const DEFAULT_CHAT: UiChatSettings = {
  queue: 'daemon',
  suggestions: 6,
  decisionFocus: 'auto',
  esc: 'stop',
  history: 40,
};

export const DEFAULT_TUI_MOUSE: UiTuiMouseSettings = {
  wheelLines: 3,
  copyMaxBytes: 100_000,
};

export const DEFAULT_SETUP: UiSetupSettings = { open: 'auto', readTimeoutMs: 5000 };

export const DEFAULT_NEW_PROJECT: UiNewProjectSettings = { repo: 'cwd' };

export const DEFAULT_UI_SETTINGS: UiSettings = {
  locale: 'auto',
  render: DEFAULT_RENDER,
  runtime: DEFAULT_RUNTIME,
  keymap: DEFAULT_KEYMAP,
  tuiLayout: DEFAULT_TUI_LAYOUT,
  trajectories: DEFAULT_TRAJECTORIES,
  chat: DEFAULT_CHAT,
  input: DEFAULT_INPUT_SETTINGS,
  overview: DEFAULT_OVERVIEW_SETTINGS,
  usage: DEFAULT_USAGE_SETTINGS,
  mouse: 'full',
  clipboardCopy: 'osc52',
  tuiMouse: DEFAULT_TUI_MOUSE,
  setup: DEFAULT_SETUP,
  newProject: DEFAULT_NEW_PROJECT,
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
  const keymap = record(field(source, 'keymap'));
  const tuiLayout = record(field(source, 'tuiLayout'));
  const trajectories = record(field(source, 'trajectories'));
  const chat = record(field(source, 'chat'));
  const clipboard = record(field(source, 'clipboard'));
  const tuiMouse = record(field(source, 'tuiMouse'));
  const setup = record(field(source, 'setup'));
  const newProject = record(field(source, 'newProject'));
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
    },
    chat: {
      queue: oneOf(field(chat, 'queue'), CHAT_QUEUE_MODES, DEFAULT_CHAT.queue),
      suggestions: integer(field(chat, 'suggestions'), 0, 30, DEFAULT_CHAT.suggestions),
      decisionFocus: oneOf(
        field(chat, 'decisionFocus'),
        CHAT_DECISION_FOCUS_MODES,
        DEFAULT_CHAT.decisionFocus,
      ),
      esc: oneOf(field(chat, 'esc'), CHAT_ESC_MODES, DEFAULT_CHAT.esc),
      history: integer(field(chat, 'history'), 0, 200, DEFAULT_CHAT.history),
    },
    input: parseInputSettings(field(source, 'input')),
    overview: parseOverviewSettings(field(source, 'overview')),
    usage: parseUsageSettings(field(source, 'usage')),
    mouse: oneOf(field(source, 'mouse'), MOUSE_MODES, DEFAULT_UI_SETTINGS.mouse),
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
    },
    newProject: {
      repo: oneOf(field(newProject, 'repo'), NEW_PROJECT_REPO_MODES, DEFAULT_NEW_PROJECT.repo),
    },
  };
}
