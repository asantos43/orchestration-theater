// SPDX-License-Identifier: MPL-2.0

/**
 * The `ui.*` settings the TUI uses (architecture 5.13 N37 and 5.22). The schema of the daemon
 * (`DaemonConfigSchema.ui`) is the source of truth; P7 of the plan adds `ui.render` and `ui.runtime`
 * to it. Until then this module reads them tolerantly: a missing or invalid value falls back to the
 * default here, and nothing throws. This package never imports the daemon, so the defaults are
 * repeated on purpose.
 */

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
}

export interface UiSettings {
  readonly locale: LocaleSetting;
  readonly render: UiRenderSettings;
  readonly runtime: UiRuntimeSettings;
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
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  locale: 'auto',
  render: DEFAULT_RENDER,
  runtime: DEFAULT_RUNTIME,
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

/** Reads `ui` (the object under the `ui` key of the configuration), never throwing. */
export function parseUiSettings(ui: unknown): UiSettings {
  const source = record(ui);
  const render = record(field(source, 'render'));
  const runtime = record(field(source, 'runtime'));
  const oldSpace = integer(field(runtime, 'maxOldSpaceMB'), 16, 65_536, 0);
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
    },
  };
}
