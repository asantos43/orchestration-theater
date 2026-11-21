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
export const UI_CLIPBOARD_COPY_MODES = ['osc52', 'system', 'off'] as const;
export const UI_MOUSE_MODES = ['full', 'wheel', 'off'] as const;
export const UI_KEY_RENDER_MODES = ['flush', 'throttle'] as const;
export const UI_INK_PATCHES = ['cache', 'grid'] as const;
export const UI_SCROLL_STEPS = ['page', 'half', 'line'] as const;

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

/** `ui.clipboard.copy` (N36): `osc52` (default), `system` (pbcopy, wl-copy, clip.exe) or `off`. */
export const UiClipboardConfigSchema = z.strictObject({
  copy: z.enum(UI_CLIPBOARD_COPY_MODES).default('osc52'),
});

/** `ui.mouse` (N34): `full` (default), `wheel` (only the wheel) or `off`. */
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
 * `ui.runtime` (N37). `maxSemiSpaceMB`: 2, the young heap of V8 (`--max-semi-space-size`).
 * `maxOldSpaceMB`: a hard cap (the process dies above it); absent by default, until the
 * measurement with the real client (P8) gives a number [proposta].
 */
export const UiRuntimeConfigSchema = z.strictObject({
  maxSemiSpaceMB: z.int().min(1).default(2),
  maxOldSpaceMB: z.int().min(1).optional(),
});

/**
 * `ui.tuiLayout` (architecture 5.13, P9 of docs/18): the measures of the screen of the terminal.
 * `sidebarWidth`: columns of the side bar open (30, as in the mockup); `railWidth`: columns of the
 * rail it becomes (5); `minChatWidth` and `minPanelWidth`: the least the chat and the work panel
 * keep when the window is narrow (30 each); `chatStep`: columns one press of the width keys moves
 * the edge of the chat (2); `scrollStep`: how far the scroll keys of a list go, `page`, `half`
 * (default) or `line`. The ranges and defaults are [proposta].
 */
export const UiTuiLayoutConfigSchema = z.strictObject({
  sidebarWidth: z.int().min(16).max(80).default(30),
  railWidth: z.int().min(3).max(16).default(5),
  minChatWidth: z.int().min(20).max(200).default(30),
  minPanelWidth: z.int().min(20).max(200).default(30),
  chatStep: z.int().min(1).max(20).default(2),
  scrollStep: z.enum(UI_SCROLL_STEPS).default('half'),
});
export type UiTuiLayoutConfig = z.output<typeof UiTuiLayoutConfigSchema>;
export type UiScrollStep = (typeof UI_SCROLL_STEPS)[number];
