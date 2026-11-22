// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSET_INDEX_KEY, assetIndex, collectTextAssets, fileSize, sha256File } from './assets.js';
import { repoRoot } from './resolve.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ot-assets-'));
  dirs.push(dir);
  return dir;
}

describe('assets', () => {
  it('collects the catalogs and the prompts of the repository, in key order', () => {
    const keys = collectTextAssets(repoRoot()).map((asset) => asset.key);
    expect(keys).toContain('locales/en/cli.json');
    expect(keys).toContain('locales/pt-BR/cli.json');
    expect(keys).toContain('prompts/director.md');
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('takes only .json from locales and only .md from prompts', () => {
    const root = temp();
    mkdirSync(path.join(root, 'locales', 'en'), { recursive: true });
    mkdirSync(path.join(root, 'prompts'));
    writeFileSync(path.join(root, 'locales', 'en', 'a.json'), '{}');
    writeFileSync(path.join(root, 'locales', 'en', 'a.json.bak'), '{}');
    writeFileSync(path.join(root, 'prompts', 'x.md'), '#');
    writeFileSync(path.join(root, 'prompts', 'x.txt'), '#');
    expect(collectTextAssets(root).map((asset) => asset.key)).toEqual([
      'locales/en/a.json',
      'prompts/x.md',
    ]);
  });

  it('the index lists the sorted keys and never itself', () => {
    const parsed = JSON.parse(assetIndex(['b', ASSET_INDEX_KEY, 'a'])) as string[];
    expect(parsed).toEqual(['a', 'b']);
  });

  it('hashes and measures a file', () => {
    const file = path.join(temp(), 'f');
    writeFileSync(file, 'abc');
    expect(sha256File(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(fileSize(file)).toBe(3);
  });
});
