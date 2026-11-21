// SPDX-License-Identifier: MPL-2.0
import { normalizeKeyCombo, parseKeyCombo } from '@otheater/protocol';

/**
 * The shared base of the interface registry and of the keymap: where a registry entry can be
 * shown, when its keys are alive, and the checks two combinations must pass (architecture 5.13,
 * N35 and N39). Pure: it runs in Node and in a browser.
 */

/** The interfaces that draw the registry (5.13): the terminal now, the web and the desktop later. */
export const UI_SURFACES = ['tui', 'web', 'desktop'] as const;
export type UiSurface = (typeof UI_SURFACES)[number];

/**
 * When the keys of an entry are alive. `global` keys work everywhere; `decision` keys work only
 * while a pending decision of the Director has the focus (5.3), so `Enter` there does not collide
 * with the text box. `textBox` keys work only while the text box of the Producer has the focus
 * (N35): they are the editing keys, and they may repeat a key of `decision`, which never has the
 * focus at the same time. The terminal adds one context for each area that can have the focus
 * (`chat`, `edge` for the border of the chat, `sidebar`, `panel`) and one for the palette and the
 * help (`overlay`): their arrows and Enter never collide with another area's. The setup assistant
 * (P17) is a screen of its own and not an area of the layout: its context `setup` is alive only
 * while that screen is open, and meets `global` and nothing else. Each tab of the
 * panel has a context of its own as well ({@link UI_TAB_CONTEXTS}), alive while the panel has the
 * focus and that tab is the open one.
 */
export const UI_TAB_CONTEXTS = [
  'overview',
  'usage',
  'trajectories',
  'directives',
  'settings',
] as const;
export type UiTabContext = (typeof UI_TAB_CONTEXTS)[number];

export const UI_CONTEXTS = [
  'global',
  'decision',
  'textBox',
  'chat',
  'edge',
  'sidebar',
  'panel',
  'overlay',
  'setup',
  ...UI_TAB_CONTEXTS,
] as const;
export type UiContext = (typeof UI_CONTEXTS)[number];

/** Whether `context` is the context of one tab of the panel. */
export function isTabContext(context: UiContext): context is UiTabContext {
  return (UI_TAB_CONTEXTS as readonly string[]).includes(context);
}

/**
 * The context of the tab `tabId`, or `undefined` when the tab has none (a tab added by a plugin
 * acts in `panel`). [proposta] The id of the tab is the name of its context.
 */
export function tabContextOf(tabId: string | undefined): UiTabContext | undefined {
  return (UI_TAB_CONTEXTS as readonly string[]).includes(tabId ?? '')
    ? (tabId as UiTabContext)
    : undefined;
}

/** The platforms the combinations are written for: `default` (Windows and Linux) and `mac`. */
export const UI_KEY_PLATFORMS = ['default', 'mac'] as const;
export type UiKeyPlatform = (typeof UI_KEY_PLATFORMS)[number];

/** The combinations of one entry in one preset, by platform; `mac` falls back to `default`. */
export interface UiKeyBindings {
  readonly default?: readonly string[] | undefined;
  readonly mac?: readonly string[] | undefined;
}

/** Surface, then preset name, then the combinations. */
export type UiKeysBySurface = Readonly<
  Partial<Record<UiSurface, Readonly<Record<string, UiKeyBindings>>>>
>;

/** The combinations of `bindings` on a platform, in their canonical spelling. */
export function bindingsFor(
  bindings: UiKeyBindings | undefined,
  platform: 'mac' | 'other',
): readonly string[] {
  if (bindings === undefined) return [];
  const list = platform === 'mac' ? (bindings.mac ?? bindings.default) : bindings.default;
  return (list ?? []).map((text) => normalizeKeyCombo(text) ?? text);
}

/**
 * Whether keys alive in `a` and in `b` can both be pressed in the same moment. A tab context is
 * alive together with `panel` (the panel has the focus) and never with another tab's: only one tab
 * is open, so two tabs may take the same key (P15 and P16 of Phase 7).
 */
export function contextsOverlap(a: UiContext, b: UiContext): boolean {
  if (a === b || a === 'global' || b === 'global') return true;
  return (a === 'panel' && isTabContext(b)) || (b === 'panel' && isTabContext(a));
}

export interface KeyOwner {
  readonly id: string;
  readonly context: UiContext;
  /** Canonical combinations. */
  readonly combos: readonly string[];
}

export interface KeyConflict {
  readonly combo: string;
  /** The two entries that claim it (the second came later in the list). */
  readonly ids: readonly [string, string];
}

/**
 * The combinations claimed twice: by two entries whose contexts overlap, or twice by the same
 * entry. One conflict per combination and pair of claimants.
 */
export function findKeyConflicts(owners: readonly KeyOwner[]): readonly KeyConflict[] {
  const conflicts: KeyConflict[] = [];
  const claimed = new Map<string, KeyOwner[]>();
  for (const owner of owners) {
    const own = new Set<string>();
    for (const combo of owner.combos) {
      if (own.has(combo)) conflicts.push({ combo, ids: [owner.id, owner.id] });
      own.add(combo);
    }
    for (const combo of own) {
      const before = claimed.get(combo) ?? [];
      for (const other of before) {
        if (contextsOverlap(other.context, owner.context))
          conflicts.push({ combo, ids: [other.id, owner.id] });
      }
      claimed.set(combo, [...before, owner]);
    }
  }
  return conflicts;
}

/** Why a terminal cannot use a combination, or `undefined` when it can (5.13, "Regras"). */
export const TERMINAL_PROBLEMS = ['cmd', 'ctrl_shift_letter', 'bare_printable'] as const;
export type TerminalKeyProblem = (typeof TERMINAL_PROBLEMS)[number];

/**
 * What a terminal cannot deliver as a shortcut:
 * - `cmd`: the Cmd of macOS never reaches a terminal program;
 * - `ctrl_shift_letter`: without an extended keyboard mode, Ctrl+Shift+P arrives as Ctrl+P;
 * - `bare_printable`: a global shortcut on a letter, digit or symbol alone would steal what the
 *   person types in the text box (the keys of a decision, which has the focus, may be bare).
 */
export function terminalKeyProblem(
  combo: string,
  context: UiContext,
): TerminalKeyProblem | undefined {
  const parsed = parseKeyCombo(combo);
  if (parsed === undefined) return undefined;
  if (parsed.cmd) return 'cmd';
  const printable = Array.from(parsed.key).length === 1;
  const letter = /^\p{L}$/u.test(parsed.key);
  if (parsed.ctrl && parsed.shift && letter) return 'ctrl_shift_letter';
  if (printable && !parsed.ctrl && !parsed.alt && context === 'global') return 'bare_printable';
  return undefined;
}
