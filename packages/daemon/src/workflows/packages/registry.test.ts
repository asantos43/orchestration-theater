// SPDX-License-Identifier: MPL-2.0
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempFolders, tempFolder } from './packages.test-support.js';
import {
  WorkflowPackageRegistry,
  workflowPackagePaths,
  type InstalledWorkflowPackage,
} from './registry.js';

afterEach(removeTempFolders);

function entry(id: string, version = '1.0.0'): InstalledWorkflowPackage {
  return {
    id,
    version,
    hash: `sha256:${'a'.repeat(64)}`,
    origin: { kind: 'file', path: '/work/pkg' },
    workflows: [`${id}@${version}`],
    signature: 'verified',
    signer: 'SHA256:abc',
    confirmedUnsigned: false,
    permissions: ['tool:lint'],
    installedAt: 1_000,
    updatedAt: 2_000,
  };
}

async function registry(): Promise<{ registry: WorkflowPackageRegistry; file: string }> {
  const dir = await tempFolder();
  const file = workflowPackagePaths(dir).file;
  return { registry: new WorkflowPackageRegistry(file), file };
}

describe('WorkflowPackageRegistry', () => {
  it('is empty while the file does not exist, and puts the paths in the data directory', async () => {
    const { registry: empty, file } = await registry();
    expect(await empty.list()).toEqual([]);
    expect(await empty.get('a')).toBeUndefined();
    expect(file.endsWith('workflow-packages.json')).toBe(true);
    expect(workflowPackagePaths('/data').staging).toBe(
      join('/data', 'workflow-packages', '.staging'),
    );
  });

  it('saves, replaces, lists in order and forgets', async () => {
    const { registry: store, file } = await registry();
    await store.put(entry('b'));
    await store.put(entry('a'));
    await store.put({ ...entry('a', '1.1.0'), permissions: [] });
    expect((await store.list()).map((item) => `${item.id}@${item.version}`)).toEqual([
      'a@1.1.0',
      'b@1.0.0',
    ]);
    expect((await store.get('a'))?.permissions).toEqual([]);
    await store.remove('a');
    await store.remove('never-there');
    expect((await store.list()).map((item) => item.id)).toEqual(['b']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('keeps every write when they come together', async () => {
    const { registry: store } = await registry();
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.put(entry(id))));
    expect((await store.list()).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('writes the file private (mode 0600) on systems that have modes', async () => {
    const { registry: store, file } = await registry();
    await store.put(entry('a'));
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses an entry that is not valid and a file that is not a registry', async () => {
    const { registry: store, file } = await registry();
    expect(() => store.put({ ...entry('a'), hash: 'nope' })).toThrow();
    await writeFile(file, '{ not json');
    await expect(store.list()).rejects.toThrow(InvalidInput);
    await writeFile(file, JSON.stringify({ version: 2, packages: {} }));
    await expect(store.list()).rejects.toThrow(/not a registry/);
    await writeFile(file, JSON.stringify({ version: 1, packages: { a: { id: 'a' } } }));
    await expect(store.get('a')).rejects.toThrow(InvalidInput);
  });

  it('does not leave temporary files next to the registry', async () => {
    const { registry: store, file } = await registry();
    await store.put(entry('a'));
    const { readdir } = await import('node:fs/promises');
    const dir = join(file, '..');
    expect(await readdir(dir)).toEqual(['workflow-packages.json']);
  });
});
