// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSET_INDEX_KEY } from './assets.js';
import { seaConfig, writeAssetIndex } from './sea-config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the SEA config', () => {
  it('maps each key to its file and keeps snapshot and code cache off', () => {
    const config = seaConfig('/o/ot.cjs', '/o/blob', [
      { key: 'locales/en/cli.json', file: '/r/locales/en/cli.json' },
      { key: 'prompts/actor.md', file: '/r/prompts/actor.md' },
    ]);
    expect(config.main).toBe('/o/ot.cjs');
    expect(config.output).toBe('/o/blob');
    expect(config.assets).toEqual({
      'locales/en/cli.json': '/r/locales/en/cli.json',
      'prompts/actor.md': '/r/prompts/actor.md',
    });
    expect(config.useSnapshot).toBe(false);
    expect(config.useCodeCache).toBe(false);
    expect(config.disableExperimentalSEAWarning).toBe(true);
  });

  it('refuses two assets with the same key', () => {
    expect(() =>
      seaConfig('m', 'o', [
        { key: 'a', file: '1' },
        { key: 'a', file: '2' },
      ]),
    ).toThrow(/Two assets/);
  });

  it('writes the index asset with the keys of the others', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ot-sea-'));
    dirs.push(dir);
    const file = path.join(dir, 'ot-assets.json');
    const entry = writeAssetIndex(file, [
      { key: 'b', file: 'x' },
      { key: 'a', file: 'y' },
    ]);
    expect(entry).toEqual({ key: ASSET_INDEX_KEY, file });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['a', 'b']);
  });
});
