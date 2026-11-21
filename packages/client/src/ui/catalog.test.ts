// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_REGISTRY,
  UI_LANGUAGES,
  UI_NAMESPACE,
  lookupCatalogText,
  missingCatalogKeys,
  translateUiText,
  uiCatalogKeys,
  type UiTranslate,
} from './index.js';
import { loadUiCatalogs } from '../node/index.js';

function variables(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '').sort();
}

describe('the screen catalog (locales/<language>/tui.json)', () => {
  it('has a text in every language for every key the registry and the keymap hand out', async () => {
    const resources = await loadUiCatalogs();
    const keys = uiCatalogKeys(DEFAULT_UI_REGISTRY);
    expect(keys.length).toBeGreaterThan(30);
    for (const language of UI_LANGUAGES)
      expect(missingCatalogKeys(resources[language][UI_NAMESPACE], keys), language).toEqual([]);
  });

  it('has the same variables in both languages', async () => {
    const resources = await loadUiCatalogs();
    for (const key of uiCatalogKeys(DEFAULT_UI_REGISTRY)) {
      const en = lookupCatalogText(resources.en.tui, key) ?? '';
      const pt = lookupCatalogText(resources['pt-BR'].tui, key) ?? '';
      expect(variables(pt), key).toEqual(variables(en));
    }
  });

  it('translates a text with a nested text as a parameter', async () => {
    const resources = await loadUiCatalogs();
    const t =
      (language: 'en' | 'pt-BR'): UiTranslate =>
      (key, params = {}) =>
        (lookupCatalogText(resources[language].tui, key) ?? key).replace(
          /\{\{(\w+)\}\}/g,
          (_, name: string) => String(params[name] ?? ''),
        );
    const text = DEFAULT_UI_REGISTRY.entry('tabs.open.settings')?.text;
    if (text === undefined) throw new Error('no entry');
    expect(translateUiText(t('en'), text)).toBe('Go to the tab Settings');
    expect(translateUiText(t('pt-BR'), text)).toBe('Ir para a aba Configurações');
  });
});
