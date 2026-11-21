// SPDX-License-Identifier: MPL-2.0
import { parseKeyCombo } from '@otheater/protocol';
import type { UiContext } from './keys.js';
import type { ResolvedKeymap } from './keymap.js';
import type { UiEntry, UiRegistry } from './registry.js';
import { translateUiText, type UiText, type UiTranslate } from './text.js';

/**
 * What the registry and the keymap give the screens (architecture 5.13): the palette, the help
 * (F1) and the bar of shortcuts. All pure and all fed by the effective keymap, so what they show
 * is the keys that are really active. The functions return catalog keys (`UiText`); the interface
 * translates them.
 */

const ARROWS: Readonly<Record<string, string>> = { Up: '↑', Down: '↓', Left: '←', Right: '→' };

/**
 * A combination as the person reads it on this platform: the arrows as arrows, and on macOS the Alt
 * as Option (`Alt+S` is `Option+S`).
 */
export function formatKeyLabel(combo: string, platform: 'mac' | 'other'): string {
  const parsed = parseKeyCombo(combo);
  if (parsed === undefined) return combo;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push(platform === 'mac' ? 'Option' : 'Alt');
  if (parsed.shift) parts.push('Shift');
  if (parsed.cmd) parts.push('Cmd');
  parts.push(ARROWS[parsed.key] ?? (parsed.key === '+' ? 'Plus' : parsed.key));
  return parts.join('+');
}

/** One command, as the palette and the help list it. */
export interface UiCommandRow {
  readonly id: string;
  readonly kind: UiEntry['kind'];
  readonly text: UiText;
  readonly groupId: string;
  readonly groupTextKey: string;
  readonly context: UiContext;
  /** Canonical combinations, the preferred first; empty when the command has no shortcut. */
  readonly keys: readonly string[];
  /** The same, as the person reads them. */
  readonly labels: readonly string[];
  /** The palette lists it. */
  readonly palette: boolean;
}

function rowsOf(registry: UiRegistry, keymap: ResolvedKeymap): UiCommandRow[] {
  const groupIndex = new Map(registry.groups.map((group, index) => [group.id, index]));
  const groupText = new Map(registry.groups.map((group) => [group.id, group.textKey]));
  const rows = registry.entries
    .filter((entry) => entry.surfaces.includes(keymap.surface))
    .map((entry, order) => {
      const keys = keymap.bindings.get(entry.id) ?? [];
      return {
        order,
        row: {
          id: entry.id,
          kind: entry.kind,
          text: entry.text,
          groupId: entry.group,
          groupTextKey: groupText.get(entry.group) ?? entry.group,
          context: entry.context,
          keys,
          labels: keys.map((combo) => formatKeyLabel(combo, keymap.platform)),
          palette: entry.palette,
        } satisfies UiCommandRow,
      };
    });
  rows.sort(
    (a, b) =>
      (groupIndex.get(a.row.groupId) ?? 0) - (groupIndex.get(b.row.groupId) ?? 0) ||
      a.order - b.order,
  );
  return rows.map((item) => item.row);
}

/** The commands of the palette: one per entry the palette lists, by group and then by declaration. */
export function derivePalette(registry: UiRegistry, keymap: ResolvedKeymap): UiCommandRow[] {
  return rowsOf(registry, keymap).filter((row) => row.palette);
}

export interface UiHelpGroup {
  readonly id: string;
  readonly textKey: string;
  readonly rows: readonly UiCommandRow[];
}

/**
 * The screen of F1: every entry, by group, with the keys that are active. An entry with no key
 * (`keys: []`) is there too, as "palette only".
 */
export function deriveHelp(registry: UiRegistry, keymap: ResolvedKeymap): UiHelpGroup[] {
  const rows = rowsOf(registry, keymap);
  return registry.groups
    .map((group) => ({
      id: group.id,
      textKey: group.textKey,
      rows: rows.filter((row) => row.groupId === group.id),
    }))
    .filter((group) => group.rows.length > 0);
}

export interface UiBarItem {
  readonly id: string;
  /** The short label, from `bar.textKey` of the entry. */
  readonly text: UiText;
  /** The first key, as the person reads it. */
  readonly label: string;
}

/**
 * The bar of shortcuts of the footer: the entries that ask for a place in it and have a key, by the
 * order they ask for, with the first active key of each. `contexts` are the ones alive now
 * (`global`, and `decision` while a decision has the focus).
 */
export function deriveShortcutBar(
  registry: UiRegistry,
  keymap: ResolvedKeymap,
  contexts: readonly UiContext[] = ['global'],
): UiBarItem[] {
  const items: { order: number; item: UiBarItem }[] = [];
  for (const entry of registry.entries) {
    if (entry.bar === undefined || !entry.surfaces.includes(keymap.surface)) continue;
    if (!contexts.includes(entry.context)) continue;
    const first = keymap.bindings.get(entry.id)?.[0];
    if (first === undefined) continue;
    items.push({
      order: entry.bar.order,
      item: {
        id: entry.id,
        text: { key: entry.bar.textKey },
        label: formatKeyLabel(first, keymap.platform),
      },
    });
  }
  return items.sort((a, b) => a.order - b.order).map(({ item }) => item);
}

function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The commands that answer a search typed in the palette: every word of the search must be in the
 * title (translated) or in the id, without regard to case or accents. The best match (the word at
 * the start of the title) comes first, and ties keep the order of the palette.
 */
export function filterPalette(
  rows: readonly UiCommandRow[],
  query: string,
  t: UiTranslate,
): UiCommandRow[] {
  const words = normalizeSearch(query)
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...rows];
  const scored: { row: UiCommandRow; score: number; order: number }[] = [];
  rows.forEach((row, order) => {
    const title = normalizeSearch(translateUiText(t, row.text));
    const id = normalizeSearch(row.id);
    let score = 0;
    for (const word of words) {
      const inTitle = title.indexOf(word);
      if (inTitle >= 0) score += inTitle;
      else if (id.includes(word)) score += 1000;
      else return;
    }
    scored.push({ row, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map(({ row }) => row);
}
