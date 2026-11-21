// SPDX-License-Identifier: MPL-2.0

/**
 * A key combination as the configuration writes it (`Alt+S`, `Ctrl+Shift+Left`, `F1`): the one
 * grammar of the keymap of every interface (architecture 5.13, N35 and N39). Pure and free of
 * Node, so the daemon validates the keys of `ui.keymap.overrides` and a client reads them with the
 * same code.
 *
 * [proposta] The text is a list of modifiers joined by `+`, then one key. The names are not case
 * sensitive on input and have one canonical spelling on output:
 * - modifiers `Ctrl`, `Alt`, `Shift` and `Cmd` (aliases `Control`; `Option`, `Meta`; `Command`,
 *   `Super`, `Win`), always written in that order;
 * - a key is a named key (`Enter`, `Esc`, `Tab`, `Backspace`, `Delete`, `Space`, `Up`, `Down`,
 *   `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `F1` to `F12`; the arrows may
 *   be written `↑ ↓ ← →`) or one printable character, a letter in upper case. The key `+` is
 *   written `Plus`.
 */

export const KEY_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

export const NAMED_KEYS = [
  'Enter',
  'Esc',
  'Tab',
  'Backspace',
  'Delete',
  'Space',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const;

export interface KeyCombo {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly cmd: boolean;
  /** A name of {@link NAMED_KEYS}, or one printable character (a letter in upper case). */
  readonly key: string;
}

const MODIFIER_ALIASES: Readonly<Record<string, KeyModifier>> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Alt',
  shift: 'Shift',
  cmd: 'Cmd',
  command: 'Cmd',
  super: 'Cmd',
  win: 'Cmd',
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  escape: 'Esc',
  return: 'Enter',
  del: 'Delete',
  ins: 'Insert',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  pgdown: 'PageDown',
  spacebar: 'Space',
  plus: '+',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right',
};

const NAMED_BY_LOWER: ReadonlyMap<string, string> = new Map(
  NAMED_KEYS.map((name) => [name.toLowerCase(), name]),
);

function parseKey(text: string): string | undefined {
  const lower = text.toLowerCase();
  const named = NAMED_BY_LOWER.get(lower) ?? KEY_ALIASES[lower];
  if (named !== undefined) return named;
  // One printable character (a code point, so an accented letter counts), no space or control.
  const chars = Array.from(text);
  if (chars.length !== 1) return undefined;
  const char = chars[0] ?? '';
  if (/[\s\p{Cc}]/u.test(char)) return undefined;
  const upper = char.toUpperCase();
  return Array.from(upper).length === 1 ? upper : char;
}

/** The combination written by `text`, or `undefined` when it is not valid. */
export function parseKeyCombo(text: string): KeyCombo | undefined {
  const parts = text.trim().split('+');
  // "Plus" is how the key "+" is written, so an empty part means a malformed text ("Ctrl+").
  if (parts.some((part) => part.trim() === '')) return undefined;
  const keyText = parts[parts.length - 1]?.trim();
  if (keyText === undefined) return undefined;
  const key = parseKey(keyText);
  if (key === undefined) return undefined;
  const found = new Set<KeyModifier>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (modifier === undefined || found.has(modifier)) return undefined;
    found.add(modifier);
  }
  return {
    ctrl: found.has('Ctrl'),
    alt: found.has('Alt'),
    shift: found.has('Shift'),
    cmd: found.has('Cmd'),
    key,
  };
}

/** The canonical text of a combination: `Ctrl+Alt+Shift+Cmd+Key`, `+` written `Plus`. */
export function formatKeyCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  if (combo.cmd) parts.push('Cmd');
  parts.push(combo.key === '+' ? 'Plus' : combo.key);
  return parts.join('+');
}

/** Whether `text` is a valid combination. */
export function isKeyCombo(text: string): boolean {
  return parseKeyCombo(text) !== undefined;
}

/** The canonical spelling of a valid combination, or `undefined`. The id two spellings share. */
export function normalizeKeyCombo(text: string): string | undefined {
  const combo = parseKeyCombo(text);
  return combo === undefined ? undefined : formatKeyCombo(combo);
}
