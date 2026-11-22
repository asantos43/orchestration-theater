// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_LOCK_SPECS,
  buildAdapterLockFiles,
  checkAdapterLocks,
  deriveAdapterLock,
  resolveKey,
  type AdapterLockSpec,
  type NpmLockPackages,
} from './adapter-locks.js';
import { REPOSITORY_ROOT } from './test-helpers.js';

const SPEC: AdapterLockSpec = {
  id: 'fake-acp',
  packageName: 'fake-acp',
  source: 'fake.json',
  skipPrefixes: ['skipped-'],
  bundled: false,
};

const PACKAGES: NpmLockPackages = {
  '': { version: '0.0.0' },
  'node_modules/fake-acp': {
    version: '1.0.0',
    integrity: 'sha512-AAAA',
    bin: { 'fake-acp': 'dist/index.js' },
    dependencies: { a: '1', b: '2', 'skipped-native': '1' },
    optionalDependencies: { 'other-platform': '1' },
    peerDependencies: { zod: '^4', 'peer-opt': '1' },
    peerDependenciesMeta: { 'peer-opt': { optional: true } },
  },
  'node_modules/a': { version: '1.0.0', integrity: 'sha512-BBBB', dependencies: { b: '2' } },
  'node_modules/b': { version: '1.0.0', integrity: 'sha512-CCCC' },
  'node_modules/fake-acp/node_modules/b': { version: '2.0.0', integrity: 'sha512-DDDD' },
  'node_modules/zod': { version: '4.0.0', integrity: 'sha512-EEEE' },
  'node_modules/skipped-native': { version: '1.0.0', integrity: 'sha512-FFFF', os: ['linux'] },
  'node_modules/unrelated': { version: '9.0.0', integrity: 'sha512-GGGG' },
};

describe('adapter locks', () => {
  it('resolves like node: the nearest node_modules going up', () => {
    expect(resolveKey(PACKAGES, 'node_modules/fake-acp', 'b')).toBe(
      'node_modules/fake-acp/node_modules/b',
    );
    expect(resolveKey(PACKAGES, 'node_modules/a', 'b')).toBe('node_modules/b');
    expect(resolveKey(PACKAGES, 'node_modules/a', 'nope')).toBeUndefined();
  });

  it('keeps the subtree: dependencies and required peers, no skipped, optional or unrelated', () => {
    const lock = deriveAdapterLock(SPEC, PACKAGES);
    expect(lock.version).toBe('1.0.0');
    expect(lock.entry).toBe('dist/index.js');
    expect(lock.entries.map((e) => e.path)).toEqual([
      'node_modules/a',
      'node_modules/b',
      'node_modules/fake-acp',
      'node_modules/fake-acp/node_modules/b',
      'node_modules/zod',
    ]);
  });

  it('a bundled adapter is installed alone', () => {
    const lock = deriveAdapterLock({ ...SPEC, bundled: true }, PACKAGES);
    expect(lock.entries.map((e) => e.path)).toEqual(['node_modules/fake-acp']);
  });

  it('fails closed when a package has no integrity or a dependency is missing', () => {
    const noIntegrity: NpmLockPackages = {
      ...PACKAGES,
      'node_modules/a': { version: '1.0.0', dependencies: { b: '2' } },
    };
    expect(() => deriveAdapterLock(SPEC, noIntegrity)).toThrow(/no integrity/);
    const missing: NpmLockPackages = {
      ...PACKAGES,
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-B', dependencies: { gone: '1' } },
    };
    expect(() => deriveAdapterLock(SPEC, missing)).toThrow(/absent from/);
  });

  it('the files in the repository are what the spikes derive, with every package pinned', () => {
    const result = checkAdapterLocks(REPOSITORY_ROOT);
    expect(result.findings).toEqual([]);
    const { files } = buildAdapterLockFiles(REPOSITORY_ROOT);
    expect(files.size).toBe(ADAPTER_LOCK_SPECS.length + 1);
    for (const content of files.values()) expect(content).not.toMatch(/"integrity": null/);
  });
});
