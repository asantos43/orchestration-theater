// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  constraintMatches,
  hostPlatform,
  isPlatformId,
  parseLockfile,
  PLATFORM_IDS,
  type PlatformConstraint,
} from './lockfile.js';
import { REPOSITORY_ROOT } from './test-helpers.js';

const SAMPLE = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      left:
        specifier: 1.0.0
        version: 1.0.0

packages:

  '@scope/native-linux-x64-gnu@2.0.0':
    resolution: {integrity: sha512-aaa}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  '@scope/native-linux-x64-musl@2.0.0':
    resolution: {integrity: sha512-bbb}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  '@scope/native-win32-x64-msvc@2.0.0':
    resolution: {integrity: sha512-ccc}
    cpu: [x64]
    os: [win32]

  '@scope/native@2.0.0':
    resolution: {integrity: sha512-ddd}

  plain@1.0.0:
    resolution: {integrity: sha512-eee}
    peerDependencies:
      react: '*'

snapshots:

  '@scope/native-linux-x64-gnu@2.0.0': {}

  '@scope/native@2.0.0':
    optionalDependencies:
      '@scope/native-linux-x64-gnu': 2.0.0
      '@scope/native-win32-x64-msvc': 2.0.0

  plain@1.0.0(react@19.3.1):
    dependencies:
      react: 19.3.1
    optionalDependencies:
      other: 3.0.0(peer@1.0.0)
`;

describe('lockfile', () => {
  it('reads os, cpu and libc of the packages that have them, and the optional dependencies', () => {
    const lock = parseLockfile(SAMPLE);
    expect([...lock.constrained.keys()]).toEqual([
      '@scope/native-linux-x64-gnu@2.0.0',
      '@scope/native-linux-x64-musl@2.0.0',
      '@scope/native-win32-x64-msvc@2.0.0',
    ]);
    expect(lock.constrained.get('@scope/native-linux-x64-gnu@2.0.0')).toEqual({
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
    });
    expect(lock.optionalDependencies.get('@scope/native@2.0.0')).toEqual(
      new Map([
        ['@scope/native-linux-x64-gnu', '2.0.0'],
        ['@scope/native-win32-x64-msvc', '2.0.0'],
      ]),
    );
    // The peer suffix of a snapshot is dropped, in the key and in the version.
    expect(lock.optionalDependencies.get('plain@1.0.0')).toEqual(new Map([['other', '3.0.0']]));
    expect(lock.optionalDependencies.has('@scope/native-linux-x64-gnu@2.0.0')).toBe(false);
  });

  it('matches a package to a platform by os, cpu and libc (Linux means glibc)', () => {
    const lock = parseLockfile(SAMPLE);
    const matches = (id: string): PlatformConstraint => {
      const found = lock.constrained.get(id);
      if (found === undefined) throw new Error(id);
      return found;
    };
    const gnu = matches('@scope/native-linux-x64-gnu@2.0.0');
    const musl = matches('@scope/native-linux-x64-musl@2.0.0');
    const win = matches('@scope/native-win32-x64-msvc@2.0.0');
    expect(PLATFORM_IDS.filter((p) => constraintMatches(gnu, p))).toEqual(['linux-x64']);
    expect(PLATFORM_IDS.filter((p) => constraintMatches(musl, p))).toEqual([]);
    expect(PLATFORM_IDS.filter((p) => constraintMatches(win, p))).toEqual(['win32-x64']);
    const notWindows: PlatformConstraint = { os: ['!win32'], cpu: undefined, libc: undefined };
    expect(PLATFORM_IDS.filter((p) => constraintMatches(notWindows, p))).toEqual([
      'linux-x64',
      'darwin-arm64',
    ]);
  });

  it('names the host platform, and refuses what is not supported', () => {
    expect(hostPlatform('linux', 'x64')).toBe('linux-x64');
    expect(hostPlatform('win32', 'x64')).toBe('win32-x64');
    expect(hostPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hostPlatform('darwin', 'x64')).toBeUndefined();
    expect(isPlatformId('linux-x64')).toBe(true);
    expect(isPlatformId('linux-arm64')).toBe(false);
  });

  it('the real lockfile: each platform has exactly one keyring binary package (the glibc one on Linux)', () => {
    const lock = parseLockfile(readFileSync(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8'));
    const keyring = [...(lock.optionalDependencies.get('@napi-rs/keyring@2.1.2') ?? [])].map(
      ([name, version]) => `${name}@${version}`,
    );
    expect(keyring.length).toBeGreaterThan(3);
    const per = (platform: (typeof PLATFORM_IDS)[number]): string[] =>
      keyring.filter((id) => {
        const constraint = lock.constrained.get(id);
        return constraint !== undefined && constraintMatches(constraint, platform);
      });
    expect(per('linux-x64')).toEqual(['@napi-rs/keyring-linux-x64-gnu@2.1.2']);
    expect(per('win32-x64')).toEqual(['@napi-rs/keyring-win32-x64-msvc@2.1.2']);
    expect(per('darwin-arm64')).toEqual(['@napi-rs/keyring-darwin-arm64@2.1.2']);
    // better-sqlite3 ships every platform inside its one package: it has no constraint.
    expect(lock.constrained.has('better-sqlite3@13.2.0')).toBe(false);
  });
});
