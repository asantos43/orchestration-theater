// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { isKeyCombo } from './key-combo.js';

/**
 * Schemas of the `ui.*` keys the terminal interface reads (architecture 5.13: keymap N35,
 * clipboard N36, mouse N34, render and runtime N37; P7 of docs/18). `ui.locale` and `ui.layout`
 * stay in the daemon's `config.ts`. The defaults are the ones the architecture states; what it
 * does not state is marked [proposta]. The schemas are here, and not in the daemon, so the
 * interfaces read the same shape (`GET /v1/config`) and the daemon validates it at start-up.
 */

/** `agents` (the default: the text box keeps the editing keys) or `classic` (the Ctrl keys of v0.7). */
export const UI_KEYMAP_PRESETS = ['agents', 'classic'] as const;
/**
 * [proposta] `auto` applies the defaults of the environment the interface detects (macOS, `TMUX`,
 * `TERM_PROGRAM=vscode`); `none` ignores them and uses the preset as it is.
 */
export const UI_KEYMAP_ENVIRONMENTS = ['auto', 'none'] as const;
export const UI_CLIPBOARD_COPY_MODES = ['osc52', 'system', 'auto', 'off'] as const;
export const UI_MOUSE_MODES = ['full', 'wheel', 'off'] as const;
export const UI_KEY_RENDER_MODES = ['flush', 'throttle'] as const;
export const UI_SETUP_OPEN_MODES = ['auto', 'never'] as const;
/** `ui.setup.reviewNotes` (N324): the notes of the review folded by family of models, or all of them. */
export const UI_SETUP_REVIEW_NOTES_MODES = ['grouped', 'all'] as const;
/** `ui.setup.modelPick` (N324) [proposta]: which models of the list after a login start checked. */
export const UI_SETUP_MODEL_PICK_MODES = ['preset', 'all', 'none'] as const;
/**
 * `ui.setup.executorsInput` (N333) [proposta]: how the step "Executores" of the assistant takes the
 * Executors: `list` (default) a list of the models of each account to check, with the effort on the
 * arrow keys; `prompt` the line `<conta> <modelo> [esforço]` typed, as before.
 */
export const UI_SETUP_EXECUTORS_INPUT_MODES = ['list', 'prompt'] as const;
export const UI_INK_PATCHES = ['cache', 'grid'] as const;
export const UI_SCROLL_STEPS = ['page', 'half', 'line'] as const;
export const UI_DENSITIES = ['comfortable', 'compact'] as const;
export const UI_SIDEBAR_EDGE_MODES = ['tab', 'mouse', 'off'] as const;
export const UI_KEYBOARD_PROTOCOLS = ['auto', 'kitty', 'off'] as const;

export type UiKeymapPreset = (typeof UI_KEYMAP_PRESETS)[number];
export type UiKeymapEnvironmentMode = (typeof UI_KEYMAP_ENVIRONMENTS)[number];

/** One key combination (`Alt+S`), written as `parseKeyCombo` reads it. */
export const KeyComboTextSchema = z.string().refine(isKeyCombo, {
  message: 'expected a key combination such as Alt+S, Ctrl+Shift+Left or F1',
});

/**
 * `ui.keymap` (architecture 5.13, N35).
 * - `preset`: `agents` (default) or `classic`;
 * - `overrides`: action id to the combination or list of combinations that replaces the preset's
 *   for that action; an empty list takes the shortcut away (the command stays in the palette).
 *   The ids belong to the registry of `@otheater/client`, which also refuses a repeated
 *   combination and warns about the list of collisions;
 * - `environment`: see {@link UI_KEYMAP_ENVIRONMENTS}.
 */
export const UiKeymapConfigSchema = z.strictObject({
  preset: z.enum(UI_KEYMAP_PRESETS).default('agents'),
  environment: z.enum(UI_KEYMAP_ENVIRONMENTS).default('auto'),
  overrides: z
    .record(z.string().min(1), z.union([KeyComboTextSchema, z.array(KeyComboTextSchema)]))
    .default({}),
});
export type UiKeymapConfig = z.output<typeof UiKeymapConfigSchema>;

/**
 * `ui.clipboard.copy` (N36): `osc52` (default), `system` (pbcopy, wl-copy, clip.exe), `auto`
 * [proposta] (the system tool when the interface runs on this machine and finds one, OSC 52
 * otherwise, as over SSH) or `off`.
 */
export const UiClipboardConfigSchema = z.strictObject({
  copy: z.enum(UI_CLIPBOARD_COPY_MODES).default('osc52'),
});

/**
 * `ui.mouse` (N34): `full` (default), `wheel` (only the wheel) or `off`. Only `off` gives the
 * normal selection of the terminal back; in `wheel` the interface still tracks the mouse, and the
 * terminal keeps its own selection under Shift.
 */
export const UiMouseModeSchema = z.enum(UI_MOUSE_MODES);

/**
 * `ui.render` (N37). `keyRender`: `flush` (default, each key draws a frame at once) or `throttle`;
 * `maxFps`: 30, for the stream only; `coalesceMs`: 16; `memo`: on; `inkPatches`: `[cache, grid]`
 * (default) or empty; `historyWindow`: 0, off (otherwise the number of messages drawn). The ranges
 * are [proposta].
 */
export const UiRenderConfigSchema = z.strictObject({
  keyRender: z.enum(UI_KEY_RENDER_MODES).default('flush'),
  maxFps: z.int().min(1).max(240).default(30),
  coalesceMs: z.int().min(0).max(1000).default(16),
  memo: z.boolean().default(true),
  inkPatches: z
    .array(z.enum(UI_INK_PATCHES))
    .refine((list) => new Set(list).size === list.length, { message: 'repeated patch' })
    .default(['cache', 'grid']),
  historyWindow: z.int().min(0).default(0),
});

/**
 * `ui.keyboard` [proposta]: how the interface asks the terminal for a keyboard that tells more keys
 * apart. `protocol`: `auto` (default) asks the terminal if it speaks the kitty keyboard protocol
 * and turns it on only when it answers, so Shift+Enter is told from Enter; `kitty` turns it on
 * without asking (a terminal that does not know it ignores the request); `off` asks for nothing,
 * and the new line stays on Ctrl+J and Alt+Enter. The protocol is turned off again when the
 * interface ends or hands the terminal to another program.
 */
export const UiKeyboardConfigSchema = z.strictObject({
  protocol: z.enum(UI_KEYBOARD_PROTOCOLS).default('auto'),
});
export type UiKeyboardConfig = z.output<typeof UiKeyboardConfigSchema>;
export type UiKeyboardProtocol = (typeof UI_KEYBOARD_PROTOCOLS)[number];

/**
 * `ui.runtime` (N37). `maxSemiSpaceMB`: 2, the young heap of V8 (`--max-semi-space-size`).
 * `maxOldSpaceMB`: a hard cap (the process dies above it); absent by default, until the
 * measurement with the real client (P8) gives a number [proposta]. `exitGraceMs`: 2000, how long
 * the TUI process waits for its own end (the layout save on unmount) before it forces the exit; 0
 * exits at once [proposta].
 */
export const UiRuntimeConfigSchema = z.strictObject({
  maxSemiSpaceMB: z.int().min(1).default(2),
  maxOldSpaceMB: z.int().min(1).optional(),
  exitGraceMs: z.int().min(0).max(60_000).default(2000),
});

/**
 * `ui.tuiLayout` (architecture 5.13, P9 of docs/18): the measures of the screen of the terminal.
 * `sidebarWidth`: columns of the side bar open (30, as in the mockup); since N277 it is the width
 * the TUI starts with, and the one the person drags or steps to is kept in the layout preferences
 * (`LayoutPreferences.sidebarWidth`); `railWidth`: columns of the
 * rail it becomes (5); `minChatWidth` and `minPanelWidth`: the least the chat and the work panel
 * keep when the window is narrow (30 each); `chatStep`: columns one press of the width keys moves
 * the edge of the chat (2); `scrollStep`: how far the scroll keys of a list go, `page`, `half`
 * (default) or `line`; `density` (N258): `comfortable` (default) draws the margins and the alignment
 * of the mockup (a column of margin inside each frame, the sections of the panel with a blank row
 * and an indent, the tab bar and the hints in the places of the mockup), `compact` is the screen
 * as it was before (no margin); `sidebarEdge` (N277, 2026-11-22): how the border between the side bar
 * and the chat is adjusted, `tab` (default: the mouse drags it, and it is a stop of Tab where the
 * arrows change the width, as the border of the chat), `mouse` (only the drag: no stop of Tab) or
 * `off` (the width is fixed: neither drag nor keys). The ranges and defaults are [proposta].
 */
export const UiTuiLayoutConfigSchema = z.strictObject({
  sidebarWidth: z.int().min(16).max(80).default(30),
  railWidth: z.int().min(3).max(16).default(5),
  minChatWidth: z.int().min(20).max(200).default(30),
  minPanelWidth: z.int().min(20).max(200).default(30),
  chatStep: z.int().min(1).max(20).default(2),
  scrollStep: z.enum(UI_SCROLL_STEPS).default('half'),
  density: z.enum(UI_DENSITIES).default('comfortable'),
  sidebarEdge: z.enum(UI_SIDEBAR_EDGE_MODES).default('tab'),
});
export type UiTuiLayoutConfig = z.output<typeof UiTuiLayoutConfigSchema>;
export type UiScrollStep = (typeof UI_SCROLL_STEPS)[number];
export type UiDensity = (typeof UI_DENSITIES)[number];
export type UiSidebarEdgeMode = (typeof UI_SIDEBAR_EDGE_MODES)[number];
// ---- The text box (N35; P10 of docs/18) ---------------------------------------------------------

/** `marker`: a long paste becomes `[Pasted text #n]` plus an attachment; `inline`: it stays in the text. */
export const UI_PASTE_MODES = ['marker', 'inline'] as const;
/** `attach`: a pasted path of an existing file becomes an attachment; `text`: it stays as text. */
export const UI_DROP_PATH_MODES = ['attach', 'text'] as const;
/** `file`: the history of the box lives in the data folder; `memory`: only while the TUI runs. */
export const UI_HISTORY_STORES = ['file', 'memory'] as const;
/** `auto`: `$VISUAL`, then `$EDITOR`; `off`: Ctrl+G does nothing but say so. */
export const UI_EDITOR_MODES = ['auto', 'off'] as const;
/**
 * The tool Ctrl+V reads an image with. `auto` picks by the system (`wl-paste` or `xclip` on Linux,
 * `osascript` on macOS, PowerShell on Windows); `off` turns the image paste off.
 */
export const UI_IMAGE_TOOLS = [
  'auto',
  'wl-paste',
  'xclip',
  'osascript',
  'powershell',
  'off',
] as const;

export type UiImageTool = (typeof UI_IMAGE_TOOLS)[number];

/**
 * `ui.input` (N35; P10). Every default and range here is [proposta], since the architecture fixes
 * the keys of the box and not these limits:
 * - `paste`: `mode` (`marker`, default), and the limit of a long paste, `lines` (10) or `chars`
 *   (2000), whichever is passed first;
 * - `dropPaths`: `attach` (default) or `text`;
 * - `history`: `store` (`file`, default) and `size`, the messages kept (500);
 * - `editor`: `auto` (default) or `off`;
 * - `maxVisibleLines`: the height of the box before it scrolls (8);
 * - `image`: the clipboard image of Ctrl+V: `tool` (`auto`), `timeoutMs` (3000) and `maxBytes`
 *   (20 MiB).
 */
export const UiInputConfigSchema = z.strictObject({
  paste: z
    .strictObject({
      mode: z.enum(UI_PASTE_MODES).default('marker'),
      lines: z.int().min(1).default(10),
      chars: z.int().min(1).default(2000),
    })
    .prefault({}),
  dropPaths: z.enum(UI_DROP_PATH_MODES).default('attach'),
  history: z
    .strictObject({
      store: z.enum(UI_HISTORY_STORES).default('file'),
      size: z.int().min(1).max(100_000).default(500),
    })
    .prefault({}),
  editor: z.enum(UI_EDITOR_MODES).default('auto'),
  maxVisibleLines: z.int().min(1).max(100).default(8),
  image: z
    .strictObject({
      tool: z.enum(UI_IMAGE_TOOLS).default('auto'),
      timeoutMs: z.int().min(100).max(60_000).default(3000),
      maxBytes: z
        .int()
        .min(1)
        .default(20 * 1024 * 1024),
    })
    .prefault({}),
});
export type UiInputConfig = z.output<typeof UiInputConfigSchema>;

// ---- The Trajectories tab (P14 of docs/18) -------------------------------------------------------

/** `none`: every step starts closed; `last`: the last step of the play starts open; `all`: every step starts open. */
export const UI_TRAJECTORY_OPEN_MODES = ['none', 'last', 'all'] as const;
export type UiTrajectoryOpenMode = (typeof UI_TRAJECTORY_OPEN_MODES)[number];

/**
 * What the Trajectories tab follows (P27 of docs/18). `latest`: whichever of the latest play and the
 * latest direct session of the scenario moved last; `play`: always the latest play; `direct`: the
 * latest direct session, and the latest play when the scenario has none. [proposta]
 */
export const UI_TRAJECTORY_FOLLOW_MODES = ['latest', 'play', 'direct'] as const;
export type UiTrajectoryFollowMode = (typeof UI_TRAJECTORY_FOLLOW_MODES)[number];

/**
 * `ui.trajectories` (architecture 5.13, P14 of docs/18): the Trajectories tab. `open`: which steps
 * (the attempts and their turns) start open, `last` by default, and a press of Enter on a step
 * flips what it started as; `keep`: how many events of a play the interface keeps to draw its
 * trajectory (5000), the oldest go first; `diff_lines`: how many lines of a demand diff the tab
 * shows (200); `follow`: what the tab follows, a play or a direct session (`latest`). The ranges and
 * defaults are [proposta].
 */
export const UiTrajectoriesConfigSchema = z.strictObject({
  open: z.enum(UI_TRAJECTORY_OPEN_MODES).default('last'),
  keep: z.int().min(100).max(100_000).default(5000),
  diff_lines: z.int().min(10).max(10_000).default(200),
  follow: z.enum(UI_TRAJECTORY_FOLLOW_MODES).default('latest'),
});
export type UiTrajectoriesConfig = z.output<typeof UiTrajectoriesConfigSchema>;

// ---- The chat of the terminal interface (P12 of docs/18) ----------------------------------------

/**
 * What the TUI does with a message the Producer sends while the Director is in a turn. `daemon`: it
 * goes at once and the daemon holds it in the prompt queue of the scenario (5.13, "Enfileirar");
 * `hold`: the TUI keeps it, shown as waiting, and sends it when the turn ends.
 */
export const UI_CHAT_QUEUE_MODES = ['daemon', 'hold'] as const;
/**
 * How a decision of the Producer takes the keyboard. `auto`: the list opens in the chat as soon as
 * it arrives and the arrows, Space and Enter answer it; `manual`: the chat only says there is a
 * decision, and a key opens the list.
 */
export const UI_CHAT_DECISION_FOCUS_MODES = ['auto', 'manual'] as const;
/**
 * What a click on an option of the decision card does (P14 of docs/19, N34; it needs `ui.mouse:
 * full`). `answer`: the click does what the keys do on that option, so it answers a simple choice
 * and marks or unmarks one of a multiple choice; `select`: the click only moves the cursor to the
 * option, and a second click on it does what `answer` does.
 */
export const UI_CHAT_DECISION_CLICK_MODES = ['answer', 'select'] as const;
/**
 * Whether the chat draws the footer of the Director under its text box (P14 of Phase 9, N242): the
 * Executor, the model and the effort the Director runs with, and the key that opens the picker.
 * `on` (default) or `off`; with `off` the shortcut and `/director` still work.
 */
export const UI_CHAT_DIRECTOR_FOOTER_MODES = ['on', 'off'] as const;
/** What Esc does while the Director is replying: `stop` asks the daemon to stop the reply (`/stop`); `off` does nothing. */
export const UI_CHAT_ESC_MODES = ['stop', 'off'] as const;
/**
 * What the chat does when the person sends a message with no scenario open (N329): `open` (default)
 * opens the prompt of a new scenario and keeps the message, which goes to the Director once the
 * scenario opens; `notice` only says that there is no scenario and keeps the text in the box.
 */
export const UI_CHAT_NO_SCENARIO_MODES = ['open', 'notice'] as const;

/**
 * `ui.chat` (P12). Every default is [proposta], since the architecture fixes the behavior and not
 * these choices:
 * - `queue`: `daemon` (default) or `hold`;
 * - `suggestions`: how many commands the list of `/` shows at most (6); 0 turns the list off;
 * - `decisionFocus`: `auto` (default) or `manual`;
 * - `decisionClick` (P14 of docs/19): `answer` (default) or `select`;
 * - `esc`: `stop` (default) or `off`;
 * - `directorFooter` (P14 of Phase 9): `on` (default) or `off`;
 * - `history` (P26, N203 item 2): how many of the last events of the scenario the chat shows when it
 *   opens on a scenario that already talked (40); `0` opens it empty, as before. The most is
 *   `CHAT_HISTORY_MAX` (200), the limit of the `history` message of the socket;
 * - `noScenario` (N329): `open` (default) or `notice`.
 */
export const UiChatConfigSchema = z.strictObject({
  queue: z.enum(UI_CHAT_QUEUE_MODES).default('daemon'),
  suggestions: z.int().min(0).max(30).default(6),
  decisionFocus: z.enum(UI_CHAT_DECISION_FOCUS_MODES).default('auto'),
  decisionClick: z.enum(UI_CHAT_DECISION_CLICK_MODES).default('answer'),
  esc: z.enum(UI_CHAT_ESC_MODES).default('stop'),
  directorFooter: z.enum(UI_CHAT_DIRECTOR_FOOTER_MODES).default('on'),
  history: z.int().min(0).max(200).default(40),
  noScenario: z.enum(UI_CHAT_NO_SCENARIO_MODES).default('open'),
});
export type UiChatConfig = z.output<typeof UiChatConfigSchema>;

// ---- The Overview and Usage tabs (P13 of docs/18) -----------------------------------------------

/** `always`: pausing or resuming asks `y` first; `off`: the key acts at once. */
export const UI_CONFIRM_MODES = ['always', 'off'] as const;
/** What the Usage tab splits the totals by (`none`: only the totals). */
export const UI_USAGE_GROUPS = ['profile', 'executor', 'play', 'session', 'none'] as const;

/**
 * `ui.overview` (P13). `confirm`: `always` (default) asks before pausing or resuming a play or an
 * Actor, `off` acts at once; `recentEvents`: how many recent events the tab lists (8);
 * `hiddenEvents`: the event types it leaves out of that list because they come in floods
 * (`session.update` by default). The ranges and defaults are [proposta].
 */
export const UiOverviewConfigSchema = z.strictObject({
  confirm: z.enum(UI_CONFIRM_MODES).default('always'),
  recentEvents: z.int().min(1).max(100).default(8),
  hiddenEvents: z.array(z.string().min(1)).default(['session.update']),
});
export type UiOverviewConfig = z.output<typeof UiOverviewConfigSchema>;

/**
 * The sections of the Usage tab, by the name `ui.usage.sections` takes (the id of a section is
 * `usage.<name>`). The first three are P13 of docs/18; the others are the telemetry panels of
 * Phase 8, P10 [proposta]: `trend` (tokens and cost by day), `bottlenecks` (where the time goes and
 * what is waited for), `play` (the tree of spans of the play followed by the Trajectories tab) and
 * `telemetry` (the receiver, the base and the export).
 */
export const UI_USAGE_SECTIONS = [
  'totals',
  'groups',
  'budget',
  'trend',
  'bottlenecks',
  'play',
  'telemetry',
] as const;
export type UiUsageSection = (typeof UI_USAGE_SECTIONS)[number];

/**
 * `ui.usage` (P13). `groupBy`: what the totals of `/v1/usage` are split by (`profile`, default).
 * `refreshSeconds`: how often the tab reads its routes again while it is open (30; `0` reads only
 * when it opens and on the refresh key). The defaults are [proposta].
 *
 * Phase 8, P10 (all [proposta]):
 * - `sections`: which sections the tab draws and in what order (default: all seven, in the order of
 *   {@link UI_USAGE_SECTIONS}). A section left out is not drawn and its route is not read, so a
 *   person who wants only the totals pays for no other read.
 * - `trendDays`: how many days the `trend` section lists, counting back from yesterday (14; 1 to
 *   90). Today is not in it: the aggregates only hold the days that are over.
 * - `spanRows`: the most lines the tree of the `play` section draws (40; 5 to 500); the rest is
 *   said in a last line.
 */
export const UiUsageConfigSchema = z.strictObject({
  groupBy: z.enum(UI_USAGE_GROUPS).default('profile'),
  refreshSeconds: z.int().min(0).max(3600).default(30),
  sections: z
    .array(z.enum(UI_USAGE_SECTIONS))
    .refine((list) => new Set(list).size === list.length, {
      message: 'ui.usage.sections lists a section twice',
    })
    .default([...UI_USAGE_SECTIONS]),
  trendDays: z.int().min(1).max(90).default(14),
  spanRows: z.int().min(5).max(500).default(40),
});
export type UiUsageConfig = z.output<typeof UiUsageConfigSchema>;

// ---- The mouse of the terminal interface (N34, N36; P11 of docs/18) -----------------------------

/**
 * `ui.tuiMouse` (P11). Both keys are [proposta], since the architecture fixes the modes of
 * `ui.mouse` and `ui.clipboard.copy` and not these numbers:
 * - `wheelLines`: the lines a notch of the wheel moves a list (3);
 * - `copyMaxBytes`: the most the interface copies from one selection, in bytes of the text before
 *   the encoding (100000; many terminals drop an OSC 52 payload bigger than about 100 KB).
 */
export const UiTuiMouseConfigSchema = z.strictObject({
  wheelLines: z.int().min(1).max(50).default(3),
  copyMaxBytes: z.int().min(1).max(10_000_000).default(100_000),
});
export type UiTuiMouseConfig = z.output<typeof UiTuiMouseConfigSchema>;

// ---- The setup assistant of the terminal interface (N121; P17 of docs/18) -----------------------

/**
 * `ui.setup` (P17), [proposta]: the architecture fixes that the first run opens straight in the
 * assistant and does not name a way to turn that off, so the pattern is a key with modes:
 * - `open`: `auto` (default) opens the assistant when the daemon says there is no configuration yet
 *   (`firstRunNeeded` of `GET /v1/setup`), and resumes the run the daemon kept; `never` leaves the
 *   assistant to the tab Settings and to the person.
 * - `readTimeoutMs`: how long the TUI waits for that answer before it gives up and goes on with the
 *   normal screen (a daemon that does not answer must not hold the interface), in milliseconds.
 * - `reviewNotes` (N324): `grouped` (default) folds the notes of the review that say no account has
 *   a model of the preset into one line per family of models, and the roles left with no Executor
 *   into one line; a key of the screen shows the detail. `all` shows every note, one per line.
 * - `modelPick` (N324): after the login of an account, which models of the list start checked:
 *   `preset` (default) the ones the preset names, `all` every model the client lists, `none` none.
 * - `executorsInput` (N333): how the step of the Executors takes them: `list` (default) a list of
 *   the models of each account, with the preset's already checked and the effort on the arrows;
 *   `prompt` the typed line `<account> <model> [effort]`.
 */
export const UiSetupConfigSchema = z.strictObject({
  open: z.enum(UI_SETUP_OPEN_MODES).default('auto'),
  readTimeoutMs: z.int().min(100).max(60_000).default(5000),
  reviewNotes: z.enum(UI_SETUP_REVIEW_NOTES_MODES).default('grouped'),
  modelPick: z.enum(UI_SETUP_MODEL_PICK_MODES).default('preset'),
  executorsInput: z.enum(UI_SETUP_EXECUTORS_INPUT_MODES).default('list'),
});
export type UiSetupConfig = z.output<typeof UiSetupConfigSchema>;

// ---- The warning about the layers of guarantee (N334) -------------------------------------------

/** `ui.security.banner`: whether the fixed warning about the missing layer 3 is drawn (`on`) or not (`off`). */
export const UI_SECURITY_BANNER_MODES = ['on', 'off'] as const;
export type UiSecurityBannerMode = (typeof UI_SECURITY_BANNER_MODES)[number];

/**
 * `ui.security` (N334, 2026-11-26), [proposta]: `banner` is `on` (default) or `off`. With `on` the
 * interface draws a fixed row under the header while layer 3 (the sandbox) is missing: "protection
 * reduced" when `security.unenforced` is `warn` or `allow`, and "the Director will not open, here
 * is how to fix it" when it is `refuse`.
 */
export const UiSecurityConfigSchema = z.strictObject({
  banner: z.enum(UI_SECURITY_BANNER_MODES).default('on'),
});
export type UiSecurityConfig = z.output<typeof UiSecurityConfigSchema>;

// ---- A new project from the terminal interface (N208; P22 of docs/18) ---------------------------

/**
 * Where the repository of a new project comes from when the person does not type one.
 * `cwd`: the folder the TUI was opened in; `git_root`: the root of the Git repository that folder
 * belongs to (the folder itself when it is in none); `empty`: nothing, the person types it.
 */
export const UI_NEW_PROJECT_REPO_MODES = ['cwd', 'git_root', 'empty'] as const;
export type UiNewProjectRepoMode = (typeof UI_NEW_PROJECT_REPO_MODES)[number];
/**
 * The type the prompt of a new scenario starts on (N329). The prompt shows the three official types
 * (project, task and chat); a type the daemon cannot create yet is shown off and skipped.
 */
export const UI_NEW_PROJECT_TYPE_MODES = ['chat', 'project'] as const;
export type UiNewProjectTypeMode = (typeof UI_NEW_PROJECT_TYPE_MODES)[number];
/**
 * How the prompt asks for the folder of a project (N332): `browser` (default) opens the folder
 * browser of the TUI as soon as the type is the project; `path` is the field of a path alone.
 */
export const UI_NEW_PROJECT_PICKER_MODES = ['browser', 'path'] as const;
export type UiNewProjectPickerMode = (typeof UI_NEW_PROJECT_PICKER_MODES)[number];
/** Whether the folder browser starts showing the hidden folders (N332, [proposta]): `hide` (default) or `show`. */
export const UI_NEW_PROJECT_HIDDEN_MODES = ['hide', 'show'] as const;
export type UiNewProjectHiddenMode = (typeof UI_NEW_PROJECT_HIDDEN_MODES)[number];

/**
 * `ui.newProject` (P22), [proposta]: the architecture fixes that the TUI creates a project and asks
 * for the repository, and not what the prompt starts with, so the pattern is a key with modes:
 * `repo` is `cwd` (default), `git_root` or `empty`. Since N329 the prompt opens any official type,
 * and `type` is the one it starts on: `chat` (default) or `project`. Since N332 `picker` says how
 * the folder is asked (`browser`, default, or `path`), `hidden` whether the browser starts with the
 * hidden folders (`hide`, default, or `show`) and `favorites` is the list of folders the browser
 * keeps at the top, which the browser itself edits ([proposta]: at most 64, each up to 4096 characters).
 */
export const UiNewProjectConfigSchema = z.strictObject({
  repo: z.enum(UI_NEW_PROJECT_REPO_MODES).default('cwd'),
  type: z.enum(UI_NEW_PROJECT_TYPE_MODES).default('chat'),
  picker: z.enum(UI_NEW_PROJECT_PICKER_MODES).default('browser'),
  hidden: z.enum(UI_NEW_PROJECT_HIDDEN_MODES).default('hide'),
  favorites: z.array(z.string().min(1).max(4096)).max(64).default([]),
});
export type UiNewProjectConfig = z.output<typeof UiNewProjectConfigSchema>;

// ---- The finished plays in the side bar (N200 item 5; P11 of docs/19) ---------------------------

/**
 * How the side bar shows the plays that are finished: `collapsed` (default) a "Terminadas" section
 * that starts folded, `expanded` the same section starting open, `hidden` no section (and no read
 * of the finished plays).
 */
export const UI_SIDEBAR_FINISHED_MODES = ['collapsed', 'hidden', 'expanded'] as const;
export type UiSidebarFinishedMode = (typeof UI_SIDEBAR_FINISHED_MODES)[number];

/**
 * `ui.sidebar` (P11 of docs/19), [proposta]: `finishedPlays` is {@link UI_SIDEBAR_FINISHED_MODES}
 * (default `collapsed`); `finishedLimit` is how many finished plays the interface reads and lists
 * at most, the most recent ones (default 20, 1 to 500).
 */
export const UiSidebarConfigSchema = z.strictObject({
  finishedPlays: z.enum(UI_SIDEBAR_FINISHED_MODES).default('collapsed'),
  finishedLimit: z.int().min(1).max(500).default(20),
});
export type UiSidebarConfig = z.output<typeof UiSidebarConfigSchema>;

// ---- The sign-in panel of the terminal interface (the address of the login) ---------------------

/**
 * Whether the terminal interface opens the address of an official login in the browser:
 * `auto` (default) opens it by itself when the sign-in starts, unless the interface runs over SSH
 * (there the browser would open on the other machine); `key` opens it only when the person presses
 * the key of the panel; `off` never opens it (the address is shown and can be copied).
 */
export const UI_LOGIN_BROWSER_MODES = ['auto', 'key', 'off'] as const;
export type UiLoginBrowserMode = (typeof UI_LOGIN_BROWSER_MODES)[number];

/** `ui.login` [proposta]: `browser` is {@link UI_LOGIN_BROWSER_MODES}. */
export const UiLoginConfigSchema = z.strictObject({
  browser: z.enum(UI_LOGIN_BROWSER_MODES).default('auto'),
});
export type UiLoginConfig = z.output<typeof UiLoginConfigSchema>;

// ---- The tab Settings of the terminal interface ------------------------------------------------

/** `ui.settingsTab.limits` [proposta] (2026-11-26): the section Limits starts folded or open. */
export const UI_SETTINGS_TAB_LIMITS_MODES = ['folded', 'open'] as const;
/**
 * `ui.settingsTab.roles` [proposta] (2026-11-26): `line` shows each role on one line (its first
 * Executor and what happens when it runs out) and opens the list of the role under the cursor, to
 * reorder it; `list` shows every list whole, as before.
 */
export const UI_SETTINGS_TAB_ROLES_MODES = ['line', 'list'] as const;

/**
 * `ui.settingsTab.modelsAfterLogin` [proposta] (N330, the owner's test on Windows: "Fiz o login e
 * nada"): when the list of models opens after a login. `empty` (default) opens it after the login
 * of an account added with A and after any login of an account with no Executor; `added` only after
 * the login of an account added with A (as before); `always` after every login (the list shows only
 * the models that are not Executors yet, so it opens only when there is one).
 */
export const UI_SETTINGS_TAB_MODELS_AFTER_LOGIN_MODES = ['empty', 'added', 'always'] as const;

/** `ui.settingsTab` [proposta] (2026-11-26, the owner's "Seções de hoje, em tabela"). */
export const UiSettingsTabConfigSchema = z.strictObject({
  limits: z.enum(UI_SETTINGS_TAB_LIMITS_MODES).default('folded'),
  roles: z.enum(UI_SETTINGS_TAB_ROLES_MODES).default('line'),
  modelsAfterLogin: z.enum(UI_SETTINGS_TAB_MODELS_AFTER_LOGIN_MODES).default('empty'),
});
export type UiSettingsTabConfig = z.output<typeof UiSettingsTabConfigSchema>;

// ---- The quota of the accounts in the terminal interface ----------------------------------------

/**
 * `ui.quota.show` [proposta] (N330, the owner on 2026-11-26: "melhor seria ver quanto falta para
 * 0"): what the percent of a quota window says, in the side bar, the Overview and the tab Settings.
 * `remaining` (default) is what is left of the window (100 minus the used part); `used` is the part
 * used, as before.
 */
export const UI_QUOTA_SHOW_MODES = ['remaining', 'used'] as const;

/** `ui.quota` [proposta] (N330). */
export const UiQuotaConfigSchema = z.strictObject({
  show: z.enum(UI_QUOTA_SHOW_MODES).default('remaining'),
});
export type UiQuotaConfig = z.output<typeof UiQuotaConfigSchema>;

// ---- The colours of the terminal interface ------------------------------------------------------

/**
 * Which colours the terminal interface draws with: `otheater` (default) is the palette of the
 * mockup, in true colour (a terminal with fewer colours gets the nearest ones); `terminal` is the
 * 16 named colours, which follow the theme of the terminal the person uses.
 */
export const UI_THEME_MODES = ['otheater', 'terminal'] as const;
export type UiThemeMode = (typeof UI_THEME_MODES)[number];

/** `ui.theme` [proposta]: {@link UI_THEME_MODES}. */
export const UiThemeModeSchema = z.enum(UI_THEME_MODES);
