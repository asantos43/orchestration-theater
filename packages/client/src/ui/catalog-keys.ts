// SPDX-License-Identifier: MPL-2.0
import { COLLISION_REASONS } from './keymap.js';
import { registryTextKeys, type UiRegistry } from './registry.js';
import { TERMINAL_PROBLEMS } from './keys.js';

/**
 * Every catalog key the registry and the keymap can hand out: the tests, and the interface at its
 * start-up, check that `tui.json` has a text for each one in every language.
 */
export function uiCatalogKeys(registry: UiRegistry): readonly string[] {
  return [
    ...registryTextKeys(registry),
    'keymap.errors.unknownAction',
    'keymap.errors.invalidCombo',
    'keymap.errors.duplicate',
    'keymap.errors.repeated',
    ...TERMINAL_PROBLEMS.map((problem) => `keymap.errors.terminal.${problem}`),
    'keymap.notices.collision',
    'keymap.notices.tmuxPrefix',
    'keymap.notices.vscodeCapture',
    'keymap.notices.macOption',
    'keymap.notices.macFn',
    ...COLLISION_REASONS.map((reason) => `keymap.reasons.${reason}`),
  ];
}
