// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_REGISTRY,
  DEFAULT_UI_REGISTRY_DEFINITION,
  UiRegistryError,
  contextsOverlap,
  createUiRegistry,
  registryTextKeys,
  tabContextOf,
  type UiRegistryDefinition,
} from './index.js';

const keys = (combos: string[]) => ({ tui: { agents: { default: combos } } });

function withAction(
  action: UiRegistryDefinition['actions'][number],
  base: UiRegistryDefinition = DEFAULT_UI_REGISTRY_DEFINITION,
): UiRegistryDefinition {
  return { ...base, actions: [...base.actions, action] };
}

describe('interface registry', () => {
  it('has the tabs, the actions and one tabs.open.<id> action per tab', () => {
    const ids = DEFAULT_UI_REGISTRY.entries.map((entry) => entry.id);
    expect(ids).toContain('layout.toggleSidebar');
    expect(ids).toContain('tabs.open.settings');
    expect(DEFAULT_UI_REGISTRY.entry('app.quit')?.surfaces).toContain('tui');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes a new tab with one line (the Agenda tab of Phase 9b)', () => {
    const registry = createUiRegistry({
      ...DEFAULT_UI_REGISTRY_DEFINITION,
      tabs: [
        ...DEFAULT_UI_REGISTRY_DEFINITION.tabs,
        { id: 'agenda', textKey: 'tabs.agenda', order: 80, keys: keys(['F7']) },
      ],
    });
    expect(registry.tabs.map((tab) => tab.id)).toContain('agenda');
    expect(registry.entry('tabs.open.agenda')?.text).toEqual({
      key: 'actions.tabs.open',
      params: { tab: { key: 'tabs.agenda' } },
    });
    expect(registryTextKeys(registry)).toContain('tabs.agenda');
  });

  it('refuses a duplicated id', () => {
    const duplicate = DEFAULT_UI_REGISTRY_DEFINITION.actions[0];
    if (duplicate === undefined) throw new Error('no action');
    expect(() => createUiRegistry(withAction({ ...duplicate, keys: {} }))).toThrow(UiRegistryError);
  });

  it('lets two tabs take the same key, but not a tab and the panel (P15 and P16)', () => {
    expect(contextsOverlap('directives', 'settings')).toBe(false);
    expect(contextsOverlap('directives', 'panel')).toBe(true);
    expect(contextsOverlap('global', 'settings')).toBe(true);
    expect(contextsOverlap('chat', 'settings')).toBe(false);
    expect(tabContextOf('settings')).toBe('settings');
    expect(tabContextOf('plugins')).toBe('plugins');
    expect(tabContextOf('agenda')).toBeUndefined();
    // E is taken by directives.extend and settings.edit, each in its own tab.
    expect(DEFAULT_UI_REGISTRY.entry('directives.extend')?.context).toBe('directives');
    expect(DEFAULT_UI_REGISTRY.entry('settings.edit')?.context).toBe('settings');
    const inPanel = () =>
      createUiRegistry(
        withAction({
          id: 'demo.panelE',
          textKey: 'actions.demo.panelE',
          group: 'general',
          context: 'panel',
          keys: keys(['E']),
        }),
      );
    expect(inPanel).toThrow(/"E" is claimed by/);
  });

  it('refuses a shortcut two entries claim', () => {
    const attempt = () =>
      createUiRegistry(
        withAction({
          id: 'demo.thing',
          textKey: 'actions.demo.thing',
          group: 'general',
          keys: keys(['Alt+S']),
        }),
      );
    expect(attempt).toThrow(UiRegistryError);
    expect(attempt).toThrow(/Alt\+S/);
  });

  it('refuses a global shortcut that the decision context also uses (both are alive together)', () => {
    // `decision` is alive together with `global`, so Enter in a global action collides.
    expect(() =>
      createUiRegistry(
        withAction({
          id: 'demo.enter',
          textKey: 'actions.demo.enter',
          group: 'general',
          keys: keys(['Enter']),
        }),
      ),
    ).toThrow(UiRegistryError);
  });

  it('refuses what a terminal cannot deliver', () => {
    for (const combo of ['Cmd+K', 'Ctrl+Shift+P', 'X']) {
      expect(
        () =>
          createUiRegistry(
            withAction({
              id: 'demo.bad',
              textKey: 'actions.demo.bad',
              group: 'general',
              keys: keys([combo]),
            }),
          ),
        combo,
      ).toThrow(UiRegistryError);
    }
  });

  it('refuses an unknown group and an unknown preset', () => {
    expect(() =>
      createUiRegistry(withAction({ id: 'demo.x', textKey: 'k', group: 'nowhere', keys: {} })),
    ).toThrow(UiRegistryError);
    expect(() =>
      createUiRegistry(
        withAction({
          id: 'demo.y',
          textKey: 'k',
          group: 'general',
          keys: { tui: { vim: { default: ['F9'] } } },
        }),
      ),
    ).toThrow(UiRegistryError);
  });

  it('has "new project" in the side bar (P22), remappable and in the palette', () => {
    const entry = DEFAULT_UI_REGISTRY.entry('sidebar.newProject');
    expect(entry?.context).toBe('sidebar');
    expect(entry?.text.key).toBe('actions.sidebar.newProject');
    expect(entry?.keys.tui?.agents?.default).toEqual(['N']);
    // No other action of the side bar or of the global keys uses the same combination.
    const taken = DEFAULT_UI_REGISTRY.entries.filter(
      (other) =>
        other.id !== 'sidebar.newProject' &&
        (other.context === 'sidebar' || other.context === 'global') &&
        (other.keys.tui?.agents?.default ?? []).includes('N'),
    );
    expect(taken).toEqual([]);
  });

  it('has "open or close the finished plays" in the side bar (P11), remappable and in the palette', () => {
    const entry = DEFAULT_UI_REGISTRY.entry('sidebar.toggleFinished');
    expect(entry?.context).toBe('sidebar');
    expect(entry?.text.key).toBe('actions.sidebar.toggleFinished');
    expect(entry?.keys.tui?.agents?.default).toEqual(['F']);
    const taken = DEFAULT_UI_REGISTRY.entries.filter(
      (other) =>
        other.id !== 'sidebar.toggleFinished' &&
        (other.context === 'sidebar' || other.context === 'global') &&
        (other.keys.tui?.agents?.default ?? []).includes('F'),
    );
    expect(taken).toEqual([]);
  });
});
