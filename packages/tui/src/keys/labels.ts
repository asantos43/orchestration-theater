// SPDX-License-Identifier: MPL-2.0
import { formatKeyLabel } from '@otheater/client';
import type { TuiKeymap } from './use-keymap.js';

/** The first key of an action as the person reads it (`Alt+S`); `undefined` when it has none. */
export function keyLabel(keymap: TuiKeymap, actionId: string): string | undefined {
  const first = keymap.keymap.bindings.get(actionId)?.[0];
  return first === undefined ? undefined : formatKeyLabel(first, keymap.keymap.platform);
}

/**
 * Two keys of the same family as one label: `Ctrl+Shift+←/→` for the pair that narrows and widens
 * the chat, instead of the combination twice. Keys that share nothing stay whole (`A/B`).
 */
export function pairLabel(first: string | undefined, second: string | undefined): string {
  if (first === undefined || second === undefined) return first ?? second ?? '';
  const cut = (text: string): number => text.lastIndexOf('+');
  const a = cut(first);
  const b = cut(second);
  if (a > 0 && first.slice(0, a) === second.slice(0, b)) return `${first}/${second.slice(b + 1)}`;
  return `${first}/${second}`;
}
