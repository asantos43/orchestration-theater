// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUiCatalogs } from './ui-catalog.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadUiCatalogs', () => {
  it('reads the catalogs of the repository, ready for i18next resources', async () => {
    const resources = await loadUiCatalogs();
    expect(Object.keys(resources).sort()).toEqual(['en', 'pt-BR']);
    expect(resources.en.tui).toHaveProperty('actions.layout');
    expect(resources['pt-BR'].tui).toHaveProperty('groups.general', 'Geral');
  });

  it('reads another folder and fails on a missing or malformed catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ot-ui-catalog-'));
    dirs.push(dir);
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'tui.json'), '{"a":{"b":"c"}}');
    await expect(loadUiCatalogs(dir)).rejects.toThrow(/pt-BR/);
    await mkdir(join(dir, 'pt-BR'));
    await writeFile(join(dir, 'pt-BR', 'tui.json'), '{"a":1}');
    await expect(loadUiCatalogs(dir)).rejects.toThrow(/not a tree of texts/);
    await writeFile(join(dir, 'pt-BR', 'tui.json'), '{"a":{"b":"d"}}');
    const resources = await loadUiCatalogs(dir);
    expect(resources.en.tui).toEqual({ a: { b: 'c' } });
    expect(resources['pt-BR'].tui).toEqual({ a: { b: 'd' } });
  });
});
