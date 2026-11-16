// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectCargoPackages, findCargoLockDirs, parseCargoMetadata } from './cargo.js';
import { UsageError, type ExecFn } from './common.js';
import { buildLicenseReport } from './licenses.js';
import { bareRealPolicy, cleanupTemp, makeTemp, writeTree } from './test-helpers.js';

afterAll(cleanupTemp);

function metadata(packages: { name: string; version: string; license: string | null }[]): string {
  const own = 'path+file:///x/native/demo#demo@0.0.0';
  return JSON.stringify({
    workspace_members: [own],
    packages: [
      { id: own, name: 'demo', version: '0.0.0', license: 'MPL-2.0' },
      ...packages.map((p) => ({ ...p, id: `registry+x#${p.name}@${p.version}` })),
    ],
  });
}

const GOOD = [
  { name: 'windows-sys', version: '0.61.2', license: 'MIT OR Apache-2.0' },
  { name: 'windows-link', version: '0.2.1', license: 'MIT/Apache-2.0' },
];

describe('cargo metadata', () => {
  it('skips the crate itself, keeps the others at level B and reads "/" as OR', () => {
    const packages = parseCargoMetadata(metadata(GOOD), 'native/demo/Cargo.lock');
    expect(packages.map((p) => `${p.name}@${p.version}:${p.license}:${p.level}`)).toEqual([
      'windows-sys@0.61.2:MIT OR Apache-2.0:B',
      'windows-link@0.2.1:MIT OR Apache-2.0:B',
    ]);
    expect(packages.every((p) => p.path === 'native/demo/Cargo.lock')).toBe(true);
  });

  it('rejects output that is not cargo metadata', () => {
    expect(() => parseCargoMetadata('nope', 'x')).toThrow(UsageError);
    expect(() => parseCargoMetadata('{}', 'x')).toThrow(UsageError);
  });

  it('feeds the same classification as the npm packages', () => {
    const policy = bareRealPolicy();
    const classify = (license: string | null): string => {
      const packages = parseCargoMetadata(
        metadata([{ name: 'c', version: '1.0.0', license }]),
        'native/demo/Cargo.lock',
      );
      return buildLicenseReport(packages, policy, '/repo').items[0]?.situation ?? 'none';
    };
    expect(classify('MIT OR Apache-2.0')).toBe('allowed');
    expect(classify('Apache-2.0 WITH LLVM-exception')).toBe('allowed');
    expect(classify('GPL-3.0-only')).toBe('forbidden');
    expect(classify('LGPL-2.1-or-later')).toBe('forbidden');
    expect(classify('Zlib')).toBe('undecided');
    expect(classify(null)).toBe('undecided');
  });
});

describe('collectCargoPackages', () => {
  it('does nothing (and never runs cargo) when there is no Cargo.lock', async () => {
    const root = makeTemp('otheater-cargo-');
    writeTree(root, { 'native/demo/Cargo.toml': '', 'package.json': '{}' });
    expect(findCargoLockDirs(root)).toEqual([]);
    const exec: ExecFn = () => Promise.reject(new Error('must not run'));
    expect(await collectCargoPackages(exec, root)).toEqual([]);
  });

  it('runs cargo metadata offline and locked in each crate with a lock', async () => {
    const root = makeTemp('otheater-cargo-');
    writeTree(root, { 'native/a/Cargo.lock': '', 'native/b/Cargo.lock': '', 'native/c/x': '' });
    const calls: string[] = [];
    const exec: ExecFn = (file, args, options) => {
      calls.push(
        `${file} ${args.join(' ')} @ ${path.relative(root, options.cwd).split(path.sep).join('/')}`,
      );
      return Promise.resolve(metadata(GOOD));
    };
    const packages = await collectCargoPackages(exec, root);
    expect(calls).toEqual([
      'cargo metadata --locked --offline --format-version 1 @ native/a',
      'cargo metadata --locked --offline --format-version 1 @ native/b',
    ]);
    expect(packages).toHaveLength(4);
  });

  it('fails clearly when cargo is not on PATH', async () => {
    const root = makeTemp('otheater-cargo-');
    writeTree(root, { 'native/a/Cargo.lock': '' });
    const exec: ExecFn = () => Promise.reject(new UsageError('spawn cargo ENOENT'));
    await expect(collectCargoPackages(exec, root)).rejects.toThrow(/"cargo" is not on PATH/);
  });

  it('suggests cargo fetch when the offline read fails', async () => {
    const root = makeTemp('otheater-cargo-');
    writeTree(root, { 'native/a/Cargo.lock': '' });
    const exec: ExecFn = () => Promise.reject(new UsageError('no matching package named x'));
    await expect(collectCargoPackages(exec, root)).rejects.toThrow(/cargo fetch --locked/);
  });
});
