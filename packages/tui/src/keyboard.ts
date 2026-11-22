// SPDX-License-Identifier: MPL-2.0
import type { KittyKeyboardOptions } from 'ink';
import type { KeyboardProtocol } from './settings.js';

/**
 * `ui.keyboard.protocol` as the `kittyKeyboard` option of `render` of Ink 8 (checked in
 * `ink@8.0.0/build/ink.js`, `initKittyKeyboard`):
 * - `auto` (default): Ink asks the terminal with `CSI ? u` and turns the protocol on only when the
 *   terminal answers (and waits at most 200 ms for it). A terminal that does not know the protocol
 *   keeps sending what it always sent, so nothing changes there. Ink only asks when the TUI is
 *   interactive and both streams are TTYs.
 * - `kitty`: Ink turns it on without asking (`CSI > 1 u`), as long as both streams are TTYs. A
 *   terminal that does not know the request ignores it.
 * - `off`: the option is not passed, so Ink neither asks nor turns anything on.
 * Ink turns the protocol off again (`CSI < u`) when the app unmounts and when it hands the terminal
 * to another program (`suspendTerminal`, the editor of Ctrl+G), and turns it on again after.
 *
 * The only flag asked for is `disambiguateEscapeCodes` (value 1 of the protocol): it makes the keys
 * that a legacy terminal sends as the same bytes tell apart (Shift+Enter, Ctrl+Enter, Esc from the
 * start of a sequence, Ctrl+letter from the control characters) and changes nothing else. The
 * others would change what the rest of the TUI reads: `reportEventTypes` adds the release of a key,
 * `reportAllKeysAsEscapeCodes` sends even the plain text as sequences, and `reportAlternateKeys`
 * and `reportAssociatedText` enlarge every sequence. Plain Enter, Tab and Backspace keep their
 * bytes with the flag on, and so do the arrows and Home/End without a modifier, the F keys and the
 * bracketed paste.
 */
export const KEYBOARD_FLAGS: NonNullable<KittyKeyboardOptions['flags']> = [
  'disambiguateEscapeCodes',
];

/** The option for `render`, or `undefined` when the protocol is not to be asked for. */
export function kittyKeyboardOption(protocol: KeyboardProtocol): KittyKeyboardOptions | undefined {
  switch (protocol) {
    case 'auto':
      return { mode: 'auto', flags: [...KEYBOARD_FLAGS] };
    case 'kitty':
      return { mode: 'enabled', flags: [...KEYBOARD_FLAGS] };
    case 'off':
      return undefined;
  }
}
