// SPDX-License-Identifier: MPL-2.0

/**
 * Screen text never sits in the code (N50): the registry and the functions derived from it hand
 * out a catalog key and its parameters, and the interface translates them with the i18next of the
 * namespace {@link UI_NAMESPACE}.
 */

/** The namespace of the screen catalog, `locales/<language>/tui.json` (architecture 5.22, P7 of docs/18). */
export const UI_NAMESPACE = 'tui';

/** The languages the screen catalog ships in (architecture 5.22). */
export const UI_LANGUAGES = ['en', 'pt-BR'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** A catalog file: nested objects with the texts as leaves. */
export interface UiCatalog {
  readonly [key: string]: string | UiCatalog;
}

/** What i18next takes as `resources`: language, then namespace, then the catalog. */
export type UiCatalogResources = Readonly<
  Record<UiLanguage, Readonly<Record<typeof UI_NAMESPACE, UiCatalog>>>
>;

/** A parameter of a text: a value, or another text to translate first. */
export type UiTextParam = string | number | UiText;

/** A text of the screen: a catalog key and its parameters. */
export interface UiText {
  readonly key: string;
  readonly params?: Readonly<Record<string, UiTextParam>> | undefined;
}

/** The shape of the `t` of i18next that {@link translateUiText} needs. */
export type UiTranslate = (key: string, params?: Record<string, string | number>) => string;

/** The text of `text` in the language `t` speaks; a parameter that is a key is translated first. */
export function translateUiText(t: UiTranslate, text: UiText): string {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(text.params ?? {})) {
    params[name] = typeof value === 'object' ? translateUiText(t, value) : value;
  }
  return t(text.key, params);
}

/** The leaf at a dotted key of a catalog, or `undefined`. */
export function lookupCatalogText(catalog: UiCatalog, key: string): string | undefined {
  let node: string | UiCatalog | undefined = catalog;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** The keys of `keys` the catalog has no text for. */
export function missingCatalogKeys(catalog: UiCatalog, keys: Iterable<string>): string[] {
  return [...new Set(keys)].filter((key) => lookupCatalogText(catalog, key) === undefined);
}
