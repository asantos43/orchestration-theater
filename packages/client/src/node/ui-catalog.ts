// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_LANGUAGES, UI_NAMESPACE, type UiCatalog, type UiCatalogResources } from '../ui/text.js';
import { isSeaProcess, readSeaAsset } from './sea.js';

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
export async function loadUiCatalogs(localesDir?: string): Promise<UiCatalogResources> {
  // In the single executable (Phase 10, P1) the catalogs are assets of the executable; an explicit
  // folder still reads the disk.
  const fromAssets = localesDir === undefined && isSeaProcess();
  const folder = localesDir ?? DEFAULT_UI_LOCALES_DIR;
  const entries = await Promise.all(
    UI_LANGUAGES.map(async (language) => {
      const key = `locales/${language}/${UI_NAMESPACE}.json`;
      const file = fromAssets ? key : join(folder, language, `${UI_NAMESPACE}.json`);
      let parsed: unknown;
      try {
        const text = fromAssets ? readSeaAsset(key) : await readFile(file, 'utf8');
        if (text === undefined) throw new Error('no such asset');
        parsed = JSON.parse(text) as unknown;
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
