// SPDX-License-Identifier: MPL-2.0

/**
 * The `ui.input.*` settings of the text box (N35; P10 of docs/18). The schema of the daemon
 * (`UiInputConfigSchema`, in `@otheater/protocol`) is the source of truth. Like `../settings.ts`,
 * this reads the object tolerantly: a missing or invalid value falls back to the default here,
 * and nothing throws. The defaults repeat the schema's on purpose, and a test compares them.
 */

export const PASTE_MODES = ['marker', 'inline'] as const;
export const DROP_PATH_MODES = ['attach', 'text'] as const;
export const HISTORY_STORES = ['file', 'memory'] as const;
export const EDITOR_MODES = ['auto', 'off'] as const;
export const IMAGE_TOOLS = ['auto', 'wl-paste', 'xclip', 'osascript', 'powershell', 'off'] as const;

export type PasteMode = (typeof PASTE_MODES)[number];
export type DropPathMode = (typeof DROP_PATH_MODES)[number];
export type HistoryStoreMode = (typeof HISTORY_STORES)[number];
export type EditorMode = (typeof EDITOR_MODES)[number];
export type ImageTool = (typeof IMAGE_TOOLS)[number];

export interface InputSettings {
  readonly paste: {
    readonly mode: PasteMode;
    /** A paste with more lines than this becomes a marker. */
    readonly lines: number;
    /** A paste with more characters than this becomes a marker. */
    readonly chars: number;
  };
  readonly dropPaths: DropPathMode;
  readonly history: { readonly store: HistoryStoreMode; readonly size: number };
  readonly editor: EditorMode;
  /** The height of the box, in lines of text, before it scrolls. */
  readonly maxVisibleLines: number;
  readonly image: {
    readonly tool: ImageTool;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  };
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  paste: { mode: 'marker', lines: 10, chars: 2000 },
  dropPaths: 'attach',
  history: { store: 'file', size: 500 },
  editor: 'auto',
  maxVisibleLines: 8,
  image: { tool: 'auto', timeoutMs: 3000, maxBytes: 20 * 1024 * 1024 },
};

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
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

/** Reads `ui.input` (the object under the `input` key of `ui`), never throwing. */
export function parseInputSettings(input: unknown): InputSettings {
  const source = record(input);
  const paste = record(source.paste);
  const history = record(source.history);
  const image = record(source.image);
  const d = DEFAULT_INPUT_SETTINGS;
  return {
    paste: {
      mode: oneOf(paste.mode, PASTE_MODES, d.paste.mode),
      lines: integer(paste.lines, 1, Number.MAX_SAFE_INTEGER, d.paste.lines),
      chars: integer(paste.chars, 1, Number.MAX_SAFE_INTEGER, d.paste.chars),
    },
    dropPaths: oneOf(source.dropPaths, DROP_PATH_MODES, d.dropPaths),
    history: {
      store: oneOf(history.store, HISTORY_STORES, d.history.store),
      size: integer(history.size, 1, 100_000, d.history.size),
    },
    editor: oneOf(source.editor, EDITOR_MODES, d.editor),
    maxVisibleLines: integer(source.maxVisibleLines, 1, 100, d.maxVisibleLines),
    image: {
      tool: oneOf(image.tool, IMAGE_TOOLS, d.image.tool),
      timeoutMs: integer(image.timeoutMs, 100, 60_000, d.image.timeoutMs),
      maxBytes: integer(image.maxBytes, 1, Number.MAX_SAFE_INTEGER, d.image.maxBytes),
    },
  };
}
