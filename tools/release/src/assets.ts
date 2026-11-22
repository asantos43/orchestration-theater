// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The asset that lists every other asset key; the code in the executable reads it (`SEA_ASSET_INDEX`). */
export const ASSET_INDEX_KEY = 'ot-assets.json';

export interface AssetEntry {
  /** The key inside the executable (`locales/en/cli.json`, `prompts/actor.md`, `native/better_sqlite3.node`). */
  readonly key: string;
  /** The file on disk that holds the bytes. */
  readonly file: string;
}

export interface NativeAsset extends AssetEntry {
  /** The name the file gets when it is extracted next to the data folder. */
  readonly name: string;
  readonly sha256: string;
}

function listFiles(dir: string, base: string, extension: string, out: AssetEntry[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const file = path.join(dir, entry.name);
    const key = `${base}/${entry.name}`;
    if (entry.isDirectory()) listFiles(file, key, extension, out);
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push({ key, file });
  }
}

/**
 * The text assets of the executable: the catalogs of every locale (`locales/<lng>/<ns>.json`) and the
 * prompts of the roles (`prompts/<role>.md`), in key order. Both folders sit at the root of the repository.
 */
export function collectTextAssets(root: string): AssetEntry[] {
  const out: AssetEntry[] = [];
  listFiles(path.join(root, 'locales'), 'locales', '.json', out);
  listFiles(path.join(root, 'prompts'), 'prompts', '.md', out);
  return out;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The JSON text of the index asset: the sorted keys of `keys`, and of the index itself left out. */
export function assetIndex(keys: readonly string[]): string {
  return `${JSON.stringify([...keys].filter((key) => key !== ASSET_INDEX_KEY).sort(), null, 2)}\n`;
}

export function fileSize(file: string): number {
  return statSync(file).size;
}
