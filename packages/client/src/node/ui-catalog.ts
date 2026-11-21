// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_LANGUAGES, UI_NAMESPACE, type UiCatalog, type UiCatalogResources } from '../ui/text.js';

/**
 * [proposta] Folder of the catalogs: `locales/` at the repository root, relative to this file, in
 * the source tree and in `dist/` alike (the same place the daemon looks in). A packaged install
 * must ship them, or pass `localesDir`.
 */
export const DEFAULT_UI_LOCALES_DIR = fileURLToPath(
  new URL('../../../../locales/', import.meta.url),
);

function isCatalog(value: unknown): value is UiCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((leaf) => typeof leaf === 'string' || isCatalog(leaf));
}

/**
 * Reads `locales/<language>/tui.json` of every language the screens ship in and returns the
 * resources as i18next takes them (`resources`, with the namespace `tui`). It reads the files
 * once; a missing or malformed catalog is an error, since a screen without text is a bug.
 */
export async function loadUiCatalogs(
  localesDir: string = DEFAULT_UI_LOCALES_DIR,
): Promise<UiCatalogResources> {
  const entries = await Promise.all(
    UI_LANGUAGES.map(async (language) => {
      const file = join(localesDir, language, `${UI_NAMESPACE}.json`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(`Cannot read the screen catalog ${file}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      if (!isCatalog(parsed)) throw new Error(`The screen catalog ${file} is not a tree of texts`);
      return [language, { [UI_NAMESPACE]: parsed }] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as UiCatalogResources;
}
