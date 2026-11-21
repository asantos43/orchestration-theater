// SPDX-License-Identifier: MPL-2.0
import { normalizeKeyCombo } from '@otheater/protocol';
import { matchKey, type ResolvedKeymap, type UiRegistry } from '@otheater/client';
import type { Key } from 'ink';

/**
 * From a key of Ink to the action of the keymap (P7). The box has no key written in it: the
 * combination goes to `matchKey` with the context `textBox`, so the preset, the environment and
 * `ui.keymap.overrides` decide what each key does.
 *
 * What the terminal tells (checked with the parser of Ink 8): Ctrl+J arrives as the line feed
 * (`\n`), Alt+Enter as `\x1b\r`, and Shift+Enter only with the kitty keyboard protocol
 * (`\x1b[13;2u`); a terminal without the protocol sends the same `\r` for Enter and Shift+Enter, and
 * there the new line is Ctrl+J or Alt+Enter.
 */

const NAMED: readonly (readonly [keyof Key, string])[] = [
  ['upArrow', 'Up'],
  ['downArrow', 'Down'],
  ['leftArrow', 'Left'],
  ['rightArrow', 'Right'],
  ['pageUp', 'PageUp'],
  ['pageDown', 'PageDown'],
  ['home', 'Home'],
  ['end', 'End'],
  ['return', 'Enter'],
  ['escape', 'Esc'],
  ['tab', 'Tab'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
];

/**
 * The canonical combination of a key press, or `undefined` for a plain character (which is text,
 * not a shortcut) and for the release of a key.
 */
export function comboOf(input: string, key: Key): string | undefined {
  if (key.eventType === 'release') return undefined;
  const modifiers: string[] = [];
  if (key.ctrl) modifiers.push('Ctrl');
  if (key.meta) modifiers.push('Alt');
  if (key.shift) modifiers.push('Shift');
  if (key.super) modifiers.push('Cmd');

  const named = NAMED.find(([flag]) => key[flag] === true)?.[1];
  if (named !== undefined) return normalizeKeyCombo([...modifiers, named].join('+'));

  // Ctrl+J is the line feed: Ink reports it as the key `enter`, with no flag and `\n` as the input.
  if (input === '\n' && modifiers.length === 0) return 'Ctrl+J';

  if (!key.ctrl && !key.meta && !key.super) return undefined;
  if (input.length !== 1) return undefined;
  const name = input === ' ' ? 'Space' : input.toUpperCase();
  // The shift of a capital letter is part of the letter; it only counts when another modifier is held.
  return normalizeKeyCombo([...modifiers, name].join('+'));
}

/** The id of the action of the box (`input.submit`...) a key press triggers, if any. */
export function actionOf(
  keymap: ResolvedKeymap,
  registry: UiRegistry,
  input: string,
  key: Key,
): string | undefined {
  const combo = comboOf(input, key);
  return combo === undefined ? undefined : matchKey(keymap, registry, combo, ['textBox']);
}

/** The text a key press types, or `undefined` when it is not a character. */
export function typedText(input: string, key: Key): string | undefined {
  if (key.ctrl || key.meta || key.super || key.eventType === 'release') return undefined;
  if (input === '' || input === '\n') return undefined;
  for (const [flag] of NAMED) if (key[flag] === true) return undefined;
  return input;
}
