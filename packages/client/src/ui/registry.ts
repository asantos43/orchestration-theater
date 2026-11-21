// SPDX-License-Identifier: MPL-2.0
import { KeyComboTextSchema, UI_KEYMAP_PRESETS } from '@otheater/protocol';
import { z } from 'zod';
import {
  UI_CONTEXTS,
  UI_SURFACES,
  bindingsFor,
  findKeyConflicts,
  terminalKeyProblem,
  type UiContext,
  type UiSurface,
} from './keys.js';
import type { UiText } from './text.js';

/**
 * The interface registry (architecture 5.13 and 5.18, N35 and N39): tabs, commands of the palette
 * and actions of the keymap, one entry per action, as data. The palette, the help (F1) and the
 * bar of shortcuts are derived from it (`derive.ts`), and so is the effective keymap
 * (`keymap.ts`). A new tab is one line in `tabs`; a new action is one line in `actions`. The
 * registry refuses a duplicated id, an entry out of its schema and a repeated shortcut when it is
 * built, never in the middle of use (5.18).
 */

const SurfaceSchema = z.enum(UI_SURFACES);

const KeyBindingsSchema = z.strictObject({
  /** Windows and Linux (and macOS when `mac` is missing). */
  default: z.array(KeyComboTextSchema).optional(),
  mac: z.array(KeyComboTextSchema).optional(),
});

/** Surface, then the preset, then the combinations: the keymap of an entry. */
const KeysSchema = z
  .partialRecord(SurfaceSchema, z.record(z.string().min(1), KeyBindingsSchema))
  .default({});

const TextKeySchema = z.string().min(1);
const GroupIdSchema = z.string().regex(/^[a-z][A-Za-z0-9]*$/);

export const UiGroupSchema = z.strictObject({
  id: GroupIdSchema,
  textKey: TextKeySchema,
  /** Order of the group in the help and in the palette. */
  order: z.int(),
});

/** What the bar of shortcuts shows of an entry: a short label and the place in the bar. */
const BarSchema = z.strictObject({ textKey: TextKeySchema, order: z.int() });

/** An action: `<area>.<name>` (`layout.toggleSidebar`). */
export const UiActionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/),
  /** The title, in the catalog `tui`. */
  textKey: TextKeySchema,
  group: GroupIdSchema,
  context: z.enum(UI_CONTEXTS).default('global'),
  /** The interfaces that have the action. */
  surfaces: z
    .array(SurfaceSchema)
    .min(1)
    .default([...UI_SURFACES]),
  /** Whether the palette lists it. Every action should be reachable from the palette (5.13). */
  palette: z.boolean().default(true),
  keys: KeysSchema,
  bar: BarSchema.optional(),
});

/** A tab of the work panel. Its entry also gives the action that opens it (`tabs.open.<id>`). */
export const UiTabSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** The name of the tab, in the catalog `tui`. */
  textKey: TextKeySchema,
  /** Order of the tab in the work panel. */
  order: z.int(),
  /** The keys that open the tab (F5 for Settings). */
  keys: KeysSchema,
});

export const UiRegistrySchema = z.strictObject({
  groups: z.array(UiGroupSchema),
  tabs: z.array(UiTabSchema),
  actions: z.array(UiActionSchema),
});

export type UiGroup = z.output<typeof UiGroupSchema>;
export type UiActionDefinition = z.output<typeof UiActionSchema>;
export type UiTabDefinition = z.output<typeof UiTabSchema>;
export type UiRegistryDefinition = z.input<typeof UiRegistrySchema>;

/** The catalog key of the title of every action that opens a tab; the tab goes in as `{{tab}}`. */
export const TAB_OPEN_TEXT_KEY = 'actions.tabs.open';
/** The group the actions that open tabs belong to. */
export const TAB_GROUP_ID = 'tabs';

/** One entry of the registry as the derivations see it: an action, or the opening of a tab. */
export interface UiEntry {
  readonly id: string;
  readonly kind: 'action' | 'tab';
  /** The title, with the tab as a parameter for a tab. */
  readonly text: UiText;
  readonly group: string;
  readonly context: UiContext;
  readonly surfaces: readonly UiSurface[];
  readonly palette: boolean;
  readonly keys: z.output<typeof KeysSchema>;
  readonly bar?: z.output<typeof BarSchema> | undefined;
}

/** A registry that passed the checks. */
export interface UiRegistry {
  readonly groups: readonly UiGroup[];
  /** In the order of the work panel. */
  readonly tabs: readonly UiTabDefinition[];
  readonly entries: readonly UiEntry[];
  /** The entry with this id. */
  entry(id: string): UiEntry | undefined;
}

/** The registry was refused: `problems` says each reason, in English (it goes to the log). */
export class UiRegistryError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid interface registry: ${problems.join('; ')}`);
    this.name = 'UiRegistryError';
    this.problems = problems;
  }
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * Builds the registry, or throws {@link UiRegistryError}. Refuses: an entry out of its schema, a
 * repeated id, an unknown group, keys for an interface the entry does not have, a preset the
 * terminal does not know, a combination the terminal cannot deliver and a shortcut two entries
 * claim in the same preset (checked for the default platform and for macOS).
 */
export function createUiRegistry(definition: UiRegistryDefinition): UiRegistry {
  const parsed = UiRegistrySchema.safeParse(definition);
  if (!parsed.success) throw new UiRegistryError(describeIssues(parsed.error));
  const { groups, tabs, actions } = parsed.data;
  const problems: string[] = [];

  const groupIds = new Set<string>();
  for (const group of groups) {
    if (groupIds.has(group.id)) problems.push(`duplicate group "${group.id}"`);
    groupIds.add(group.id);
  }
  if (!groupIds.has(TAB_GROUP_ID)) problems.push(`the group "${TAB_GROUP_ID}" is missing`);

  const tabIds = new Set<string>();
  for (const tab of tabs) {
    if (tabIds.has(tab.id)) problems.push(`duplicate tab "${tab.id}"`);
    tabIds.add(tab.id);
  }

  const entries: UiEntry[] = [];
  const entryIds = new Set<string>();
  const add = (entry: UiEntry): void => {
    if (entryIds.has(entry.id)) problems.push(`duplicate action "${entry.id}"`);
    entryIds.add(entry.id);
    entries.push(entry);
  };
  for (const action of actions) {
    if (!groupIds.has(action.group))
      problems.push(`action "${action.id}": unknown group "${action.group}"`);
    add({
      id: action.id,
      kind: 'action',
      text: { key: action.textKey },
      group: action.group,
      context: action.context,
      surfaces: action.surfaces,
      palette: action.palette,
      keys: action.keys,
      bar: action.bar,
    });
  }
  const orderedTabs = [...tabs].sort((a, b) => a.order - b.order);
  for (const tab of orderedTabs) {
    add({
      id: `tabs.open.${tab.id}`,
      kind: 'tab',
      text: { key: TAB_OPEN_TEXT_KEY, params: { tab: { key: tab.textKey } } },
      group: TAB_GROUP_ID,
      context: 'global',
      surfaces: [...UI_SURFACES],
      palette: true,
      keys: tab.keys,
    });
  }

  for (const entry of entries) {
    for (const [surface, presets] of Object.entries(entry.keys) as [
      UiSurface,
      Record<string, { default?: string[] | undefined; mac?: string[] | undefined }>,
    ][]) {
      if (!entry.surfaces.includes(surface))
        problems.push(`entry "${entry.id}": keys for "${surface}", which it does not have`);
      for (const [preset, bindings] of Object.entries(presets)) {
        if (surface === 'tui' && !(UI_KEYMAP_PRESETS as readonly string[]).includes(preset))
          problems.push(`entry "${entry.id}": unknown preset "${preset}" of the terminal`);
        if (surface !== 'tui') continue;
        for (const combo of [...(bindings.default ?? []), ...(bindings.mac ?? [])]) {
          const problem = terminalKeyProblem(combo, entry.context);
          if (problem !== undefined)
            problems.push(
              `entry "${entry.id}": "${combo}" cannot be a shortcut in a terminal (${problem})`,
            );
        }
      }
    }
  }

  // A shortcut two entries claim, per surface, preset and platform.
  const presetsOf = new Map<UiSurface, Set<string>>();
  for (const entry of entries)
    for (const [surface, presets] of Object.entries(entry.keys) as [
      UiSurface,
      Record<string, unknown>,
    ][]) {
      const known = presetsOf.get(surface) ?? new Set<string>();
      for (const preset of Object.keys(presets)) known.add(preset);
      presetsOf.set(surface, known);
    }
  for (const [surface, presetNames] of presetsOf) {
    for (const preset of presetNames) {
      for (const platform of ['other', 'mac'] as const) {
        const owners = entries
          .filter((entry) => entry.surfaces.includes(surface))
          .map((entry) => ({
            id: entry.id,
            context: entry.context,
            combos: bindingsFor(entry.keys[surface]?.[preset], platform),
          }));
        for (const conflict of findKeyConflicts(owners))
          problems.push(
            `${surface}/${preset}/${platform}: "${conflict.combo}" is claimed by "${conflict.ids[0]}" and "${conflict.ids[1]}"`,
          );
      }
    }
  }

  if (problems.length > 0) throw new UiRegistryError([...new Set(problems)]);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    groups: [...groups].sort((a, b) => a.order - b.order),
    tabs: orderedTabs,
    entries,
    entry: (id) => byId.get(id),
  };
}

/** The catalog keys the registry refers to: groups, tabs, titles and bar labels. */
export function registryTextKeys(registry: UiRegistry): readonly string[] {
  const keys = new Set<string>();
  for (const group of registry.groups) keys.add(group.textKey);
  for (const tab of registry.tabs) keys.add(tab.textKey);
  for (const entry of registry.entries) {
    keys.add(entry.text.key);
    if (entry.bar !== undefined) keys.add(entry.bar.textKey);
  }
  return [...keys];
}
