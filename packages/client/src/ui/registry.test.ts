// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_REGISTRY,
  DEFAULT_UI_REGISTRY_DEFINITION,
  UiRegistryError,
  createUiRegistry,
  registryTextKeys,
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

  it('takes a new tab with one line (the Plugins tab of Phase 9)', () => {
    const registry = createUiRegistry({
      ...DEFAULT_UI_REGISTRY_DEFINITION,
      tabs: [
        ...DEFAULT_UI_REGISTRY_DEFINITION.tabs,
        { id: 'plugins', textKey: 'tabs.plugins', order: 70, keys: keys(['F6']) },
      ],
    });
    expect(registry.tabs.map((tab) => tab.id)).toContain('plugins');
    expect(registry.entry('tabs.open.plugins')?.text).toEqual({
      key: 'actions.tabs.open',
      params: { tab: { key: 'tabs.plugins' } },
    });
    expect(registryTextKeys(registry)).toContain('tabs.plugins');
  });

  it('refuses a duplicated id', () => {
    const duplicate = DEFAULT_UI_REGISTRY_DEFINITION.actions[0];
    if (duplicate === undefined) throw new Error('no action');
    expect(() => createUiRegistry(withAction({ ...duplicate, keys: {} }))).toThrow(UiRegistryError);
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
});
