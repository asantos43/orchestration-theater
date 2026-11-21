// SPDX-License-Identifier: MPL-2.0
import { normalizeKeyCombo, parseKeyCombo, type UiKeymapConfig } from '@otheater/protocol';
import {
  bindingsFor,
  findKeyConflicts,
  terminalKeyProblem,
  type TerminalKeyProblem,
  type UiContext,
  type UiSurface,
} from './keys.js';
import type { UiEntry, UiRegistry } from './registry.js';
import type { UiText } from './text.js';

/**
 * The keymap of the terminal (architecture 5.13, "Mapa de teclas"; N35): the preset, the defaults
 * of the environment, the overrides of `ui.keymap.overrides` and the checks. Pure: the
 * environment comes in as an argument, so a test simulates macOS, tmux and the terminal of VS
 * Code.
 */

/** What the environment says of the terminal (5.13: macOS, `TMUX`, `TERM_PROGRAM=vscode`). */
export interface KeymapEnvironment {
  readonly platform: 'mac' | 'other';
  readonly tmux: boolean;
  readonly vscode: boolean;
}

/** The part of `process.env` the detection reads. */
export type KeymapEnv = Readonly<Record<string, string | undefined>>;

/**
 * The environment from the variables and the platform (`process.platform`, `darwin` for macOS).
 * Both are arguments: the function reads nothing by itself.
 */
export function detectKeymapEnvironment(env: KeymapEnv, platform: string): KeymapEnvironment {
  return {
    platform: platform === 'darwin' ? 'mac' : 'other',
    tmux: (env.TMUX ?? '') !== '',
    vscode: env.TERM_PROGRAM === 'vscode',
  };
}

// ---- The list of collisions of 5.13 ------------------------------------------------------------

/** Why a combination is a poor shortcut; each reason is a text of the catalog (`keymap.reasons.*`). */
export const COLLISION_REASONS = [
  'readline',
  'textBox',
  'wordJump',
  'flowControl',
  'tmuxPrefix',
  'browserTab',
  'terminalAlias',
] as const;
export type CollisionReason = (typeof COLLISION_REASONS)[number];

function collisionTable(): ReadonlyMap<string, readonly CollisionReason[]> {
  const table = new Map<string, CollisionReason[]>();
  const add = (combos: readonly string[], reason: CollisionReason): void => {
    for (const text of combos) {
      const combo = normalizeKeyCombo(text) ?? text;
      table.set(combo, [...(table.get(combo) ?? []), reason]);
    }
  };
  // The editing of the text box has priority (N35): the readline keys and the ones of the coding
  // agents. Alt+B C D F G L N P R T U X Y is the set `bind -p` of bash uses (checked locally).
  add(
    ['Ctrl+A', 'Ctrl+E', 'Ctrl+B', 'Ctrl+F', 'Ctrl+K', 'Ctrl+U', 'Ctrl+W', 'Ctrl+Y', 'Ctrl+T'],
    'readline',
  );
  add(
    Array.from('BCDFGLNPRTUXY').map((letter) => `Alt+${letter}`),
    'readline',
  );
  add(['Ctrl+J', 'Ctrl+V', 'Ctrl+G', 'Ctrl+R'], 'textBox');
  add(['Ctrl+Left', 'Ctrl+Right'], 'wordJump');
  add(['Ctrl+Q', 'Ctrl+S'], 'flowControl');
  add(['Ctrl+B'], 'tmuxPrefix');
  add(['Ctrl+W'], 'browserTab');
  // [proposta] Pairs a terminal cannot tell apart: Ctrl+I is Tab, Ctrl+M is Enter, Ctrl+H is Backspace.
  add(['Ctrl+I', 'Ctrl+M', 'Ctrl+H'], 'terminalAlias');
  return table;
}

const COLLISIONS = collisionTable();

/** The reasons the list of 5.13 gives against a combination (empty when it is not on the list). */
export function collisionReasons(combo: string): readonly CollisionReason[] {
  return COLLISIONS.get(normalizeKeyCombo(combo) ?? combo) ?? [];
}

/**
 * [hipótese, not checked in a real terminal] What the editor may take before the terminal of VS
 * Code sees it: the palette (F1), debugging and focus (F5, F6) and, with the Ctrl keys of the
 * classic preset, the sidebar, the panel, the chords and closing. The notice says "may".
 */
const VSCODE_CAPTURES: ReadonlySet<string> = new Set([
  'F1',
  'F5',
  'F6',
  'Ctrl+B',
  'Ctrl+J',
  'Ctrl+K',
  'Ctrl+W',
]);

// ---- Result ------------------------------------------------------------------------------------

export type KeymapErrorCode =
  'unknown_action' | 'invalid_combo' | 'duplicate' | 'terminal_unsupported';

/** A reason to refuse the keymap. `message` is English, for the log; `text` is for the person. */
export interface KeymapError {
  readonly code: KeymapErrorCode;
  readonly actionId: string;
  readonly combo?: string | undefined;
  /** For `duplicate`: the other action that has the combination. */
  readonly otherActionId?: string | undefined;
  readonly message: string;
  readonly text: UiText;
}

export type KeymapNoticeCode =
  'collision' | 'tmux_prefix' | 'vscode_capture' | 'mac_option' | 'mac_fn';

/** A warning: the keymap works, but the person should know. */
export interface KeymapNotice {
  readonly code: KeymapNoticeCode;
  readonly severity: 'warning' | 'info';
  readonly actionId?: string | undefined;
  readonly combo?: string | undefined;
  readonly text: UiText;
}

/** The keymap in force: the combinations of each entry, and the way back from a key to the entry. */
export interface ResolvedKeymap {
  readonly surface: UiSurface;
  readonly preset: string;
  readonly platform: 'mac' | 'other';
  /** Entry id to canonical combinations, the preferred first. An entry with no key is present with `[]`. */
  readonly bindings: ReadonlyMap<string, readonly string[]>;
  readonly environment: KeymapEnvironment | undefined;
}

export type KeymapResult =
  | {
      readonly ok: true;
      readonly keymap: ResolvedKeymap;
      readonly warnings: readonly KeymapNotice[];
    }
  | { readonly ok: false; readonly errors: readonly KeymapError[] };

export interface ResolveKeymapOptions {
  readonly surface?: UiSurface | undefined;
  /** `agents` or `classic`. */
  readonly preset: string;
  /** `ui.keymap.overrides`: action id to a combination, a list, or `[]` to take the shortcut away. */
  readonly overrides?: Readonly<Record<string, string | readonly string[]>> | undefined;
  /** Without it, the keymap is the preset as written: no `mac` column, no notices. */
  readonly environment?: KeymapEnvironment | undefined;
}

const TERMINAL_PROBLEM_TEXT: Readonly<Record<TerminalKeyProblem, string>> = {
  cmd: 'the Cmd key never reaches a terminal',
  ctrl_shift_letter: 'a terminal cannot tell Ctrl+Shift+letter from Ctrl+letter',
  bare_printable: 'a global shortcut on a bare character would steal what is typed',
};

function isFunctionKey(combo: string): boolean {
  return /^F\d+$/.test(parseKeyCombo(combo)?.key ?? '');
}

/**
 * The effective keymap of the terminal, or the errors that refuse it.
 *
 * Refuses (`ok: false`): an override of an action the registry does not have, a combination that
 * is not valid or that a terminal cannot deliver, and a repeated combination (two actions that can
 * be alive together, or twice in one list). The preset's own keys were checked when the registry was
 * built, so a repeat always involves an override.
 *
 * Warns (`warnings`):
 * - an override that is on the list of collisions of 5.13 (the preset's own keys are not warned
 *   about: `classic` is the Ctrl keys on purpose);
 * - a key the environment takes: `Ctrl+B` in tmux, the keys VS Code may capture;
 * - macOS: the Alt keys need the Option as Meta, and the F keys need Fn.
 */
export function resolveKeymap(registry: UiRegistry, options: ResolveKeymapOptions): KeymapResult {
  const surface = options.surface ?? 'tui';
  const { preset, environment } = options;
  const platform = environment?.platform ?? 'other';
  const errors: KeymapError[] = [];
  const entries = registry.entries.filter((entry) => entry.surfaces.includes(surface));

  const bindings = new Map<string, string[]>();
  for (const entry of entries)
    bindings.set(entry.id, [...bindingsFor(entry.keys[surface]?.[preset], platform)]);

  const overridden = new Set<string>();
  for (const [actionId, value] of Object.entries(options.overrides ?? {})) {
    const entry = entries.find((candidate) => candidate.id === actionId);
    if (entry === undefined) {
      errors.push({
        code: 'unknown_action',
        actionId,
        message: `ui.keymap.overrides: "${actionId}" is not an action of the registry`,
        text: { key: 'keymap.errors.unknownAction', params: { action: actionId } },
      });
      continue;
    }
    const combos: string[] = [];
    for (const text of typeof value === 'string' ? [value] : value) {
      const combo = normalizeKeyCombo(text);
      if (combo === undefined) {
        errors.push({
          code: 'invalid_combo',
          actionId,
          combo: text,
          message: `ui.keymap.overrides.${actionId}: "${text}" is not a key combination`,
          text: { key: 'keymap.errors.invalidCombo', params: { action: actionId, combo: text } },
        });
        continue;
      }
      const problem = surface === 'tui' ? terminalKeyProblem(combo, entry.context) : undefined;
      if (problem !== undefined) {
        errors.push({
          code: 'terminal_unsupported',
          actionId,
          combo,
          message: `ui.keymap.overrides.${actionId}: "${combo}" cannot be a shortcut: ${TERMINAL_PROBLEM_TEXT[problem]}`,
          text: {
            key: `keymap.errors.terminal.${problem}`,
            params: { action: actionId, combo },
          },
        });
        continue;
      }
      combos.push(combo);
    }
    bindings.set(actionId, combos);
    overridden.add(actionId);
  }

  for (const conflict of findKeyConflicts(
    entries.map((entry) => ({
      id: entry.id,
      context: entry.context,
      combos: bindings.get(entry.id) ?? [],
    })),
  )) {
    const [first, second] = conflict.ids;
    errors.push({
      code: 'duplicate',
      actionId: second,
      combo: conflict.combo,
      otherActionId: first,
      message:
        first === second
          ? `"${conflict.combo}" is written twice for "${first}"`
          : `"${conflict.combo}" is claimed by "${first}" and by "${second}"`,
      text: {
        key: first === second ? 'keymap.errors.repeated' : 'keymap.errors.duplicate',
        params: {
          combo: conflict.combo,
          action: textOf(entries, second),
          other: textOf(entries, first),
        },
      },
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const warnings: KeymapNotice[] = [];
  for (const actionId of overridden) {
    for (const combo of bindings.get(actionId) ?? []) {
      const reasons = collisionReasons(combo);
      for (const reason of reasons)
        warnings.push({
          code: 'collision',
          severity: 'warning',
          actionId,
          combo,
          text: {
            key: 'keymap.notices.collision',
            params: {
              combo,
              action: textOf(entries, actionId),
              reason: { key: `keymap.reasons.${reason}` },
            },
          },
        });
    }
  }

  if (environment !== undefined) {
    for (const entry of entries) {
      const list = bindings.get(entry.id) ?? [];
      for (const combo of list) {
        if (environment.tmux && combo === 'Ctrl+B')
          warnings.push({
            code: 'tmux_prefix',
            severity: 'warning',
            actionId: entry.id,
            combo,
            text: {
              key: 'keymap.notices.tmuxPrefix',
              params: { combo, action: textOf(entries, entry.id) },
            },
          });
        if (environment.vscode && VSCODE_CAPTURES.has(combo))
          warnings.push({
            code: 'vscode_capture',
            severity: 'info',
            actionId: entry.id,
            combo,
            text: {
              key: 'keymap.notices.vscodeCapture',
              params: { combo, action: textOf(entries, entry.id) },
            },
          });
      }
      // In the terminal of VS Code the keys the editor may take go last, so the label the bar and
      // the help show first is one that reaches the TUI.
      if (environment.vscode)
        bindings.set(entry.id, [
          ...list.filter((combo) => !VSCODE_CAPTURES.has(combo)),
          ...list.filter((combo) => VSCODE_CAPTURES.has(combo)),
        ]);
    }
    const all = [...bindings.values()].flat();
    if (environment.platform === 'mac') {
      if (all.some((combo) => parseKeyCombo(combo)?.alt === true))
        warnings.push({
          code: 'mac_option',
          severity: 'info',
          text: { key: 'keymap.notices.macOption' },
        });
      if (all.some(isFunctionKey))
        warnings.push({ code: 'mac_fn', severity: 'info', text: { key: 'keymap.notices.macFn' } });
    }
  }

  return {
    ok: true,
    keymap: { surface, preset, platform, bindings, environment },
    warnings,
  };
}

function textOf(entries: readonly UiEntry[], id: string): UiText {
  return (
    entries.find((entry) => entry.id === id)?.text ?? {
      key: 'keymap.errors.unknownAction',
      params: { action: id },
    }
  );
}

/**
 * The keymap the interface should use: the one with the overrides when it passes, and the plain
 * preset when it does not, with the `errors` to show. The terminal must start with a bad
 * `ui.keymap` (the daemon already refuses it at its start-up, but the client may meet an older
 * file).
 */
export function resolveKeymapOrPreset(
  registry: UiRegistry,
  options: ResolveKeymapOptions,
): {
  readonly keymap: ResolvedKeymap;
  readonly warnings: readonly KeymapNotice[];
  readonly errors: readonly KeymapError[];
} {
  const result = resolveKeymap(registry, options);
  if (result.ok) return { keymap: result.keymap, warnings: result.warnings, errors: [] };
  const plain = resolveKeymap(registry, { ...options, overrides: {} });
  if (!plain.ok)
    throw new Error('the preset itself has a repeated shortcut: the registry is wrong');
  return { keymap: plain.keymap, warnings: plain.warnings, errors: result.errors };
}

/** The keymap of the configuration (`ui.keymap`) in this environment (`auto`, or `none` for the preset as written). */
export function resolveKeymapFromConfig(
  registry: UiRegistry,
  config: Pick<UiKeymapConfig, 'preset' | 'environment' | 'overrides'>,
  environment: KeymapEnvironment,
): ReturnType<typeof resolveKeymapOrPreset> {
  return resolveKeymapOrPreset(registry, {
    preset: config.preset,
    overrides: config.overrides,
    environment: config.environment === 'auto' ? environment : undefined,
  });
}

/** Which entry a key press triggers, among the contexts alive now; `undefined` when none. */
export function matchKey(
  keymap: ResolvedKeymap,
  registry: UiRegistry,
  combo: string,
  contexts: readonly UiContext[] = ['global'],
): string | undefined {
  const canonical = normalizeKeyCombo(combo);
  if (canonical === undefined) return undefined;
  for (const [id, combos] of keymap.bindings) {
    const entry = registry.entry(id);
    if (entry === undefined || !contexts.includes(entry.context)) continue;
    if (combos.includes(canonical)) return id;
  }
  return undefined;
}
