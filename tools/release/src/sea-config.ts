// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { ASSET_INDEX_KEY, assetIndex, type AssetEntry } from './assets.js';

/** What `node --experimental-sea-config` reads. `useCodeCache` and `useSnapshot` stay off (see `docs/21`). */
export interface SeaConfig {
  readonly main: string;
  readonly output: string;
  readonly disableExperimentalSEAWarning: true;
  readonly useSnapshot: false;
  readonly useCodeCache: false;
  readonly assets: Readonly<Record<string, string>>;
}

export function seaConfig(main: string, output: string, assets: readonly AssetEntry[]): SeaConfig {
  const map: Record<string, string> = {};
  for (const asset of assets) {
    if (asset.key in map) throw new Error(`Two assets with the key ${asset.key}`);
    map[asset.key] = asset.file;
  }
  return {
    main,
    output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: map,
  };
}

/** Writes the index asset (the list of the other keys) and returns its entry. */
export function writeAssetIndex(file: string, assets: readonly AssetEntry[]): AssetEntry {
  writeFileSync(file, assetIndex(assets.map((asset) => asset.key)));
  return { key: ASSET_INDEX_KEY, file };
}

/**
 * Runs the Node binary that will be injected on the config: the blob has to come from the same binary
 * (the SEA machinery and V8 are not compatible across versions).
 */
export function generateBlob(nodeBinary: string, configFile: string): void {
  execFileSync(nodeBinary, ['--experimental-sea-config', configFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}
