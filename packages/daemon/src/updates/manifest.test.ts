// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { UpdateStop } from './errors.js';
import { assetFor, parseManifest } from './manifest.js';
import { buildRelease, makeKeys } from './release-fixture.js';

const keys = makeKeys();
const parse = (over: Record<string, unknown> = {}): ReturnType<typeof parseManifest> =>
  parseManifest(buildRelease(keys, { version: '1.2.3', manifest: over }).manifestBytes);

function reason(over: Record<string, unknown>): string | undefined {
  try {
    parse(over);
    return undefined;
  } catch (error) {
    return error instanceof UpdateStop ? error.reason : 'other';
  }
}

describe('the manifest', () => {
  it('reads a good one, and ignores a field it does not know', () => {
    const manifest = parse({ future: true, schemas: { store: 3, telemetry: 1 } });
    expect(manifest).toMatchObject({
      version: '1.2.3',
      channel: 'stable',
      schemas: { store: 3, telemetry: 1 },
    });
    expect(assetFor(manifest, 'linux-x64')?.name).toBe('otheater-1.2.3-linux-x64');
    expect(assetFor(manifest, 'darwin-arm64')).toBeUndefined();
  });

  it('refuses what is not a manifest', () => {
    expect(reason({ schema: 2 })).toBe('bad_manifest');
    expect(reason({ version: 'latest' })).toBe('bad_manifest');
    expect(reason({ version: 'v1.2.3' })).toBe('bad_manifest');
    expect(reason({ channel: 'nightly' })).toBe('bad_manifest');
    expect(reason({ publishedAt: 'yesterday' })).toBe('bad_manifest');
    expect(reason({ assets: [] })).toBe('bad_manifest');
    expect(reason({ minVersion: 'x' })).toBe('bad_manifest');
    expect(() => parseManifest(Buffer.from('not json'))).toThrow(UpdateStop);
    expect(() => parseManifest(Buffer.from([0xff, 0xfe]))).toThrow(UpdateStop);
  });

  it('refuses an executable that has a bad name, size or hash', () => {
    const asset = { platform: 'linux-x64', kind: 'exe', size: 10, sha256: 'a'.repeat(64) };
    expect(reason({ assets: [{ ...asset, name: '../evil' }] })).toBe('bad_manifest');
    expect(reason({ assets: [{ ...asset, name: 'a/b' }] })).toBe('bad_manifest');
    expect(reason({ assets: [{ ...asset, name: 'ok', size: 0 }] })).toBe('bad_manifest');
    expect(reason({ assets: [{ ...asset, name: 'ok', size: 2 ** 40 }] })).toBe('bad_manifest');
    expect(reason({ assets: [{ ...asset, name: 'ok', sha256: 'A'.repeat(64) }] })).toBe(
      'bad_manifest',
    );
    expect(reason({ assets: [{ ...asset, name: 'ok' }] })).toBeUndefined();
  });

  it('accepts the notices of a platform as an asset, and they are not an update either', () => {
    const manifest = parse({
      assets: [
        {
          platform: 'linux-x64',
          kind: 'exe',
          name: 'otheater-linux-x64',
          size: 9,
          sha256: 'a'.repeat(64),
        },
        {
          platform: 'linux-x64',
          kind: 'notices',
          name: 'THIRD_PARTY_NOTICES-linux-x64.md',
          size: 5,
          sha256: 'c'.repeat(64),
        },
      ],
    });
    expect(assetFor(manifest, 'linux-x64')?.name).toBe('otheater-linux-x64');
  });

  it('the installer is not an update', () => {
    const manifest = parse({
      assets: [
        { platform: 'win32-x64', kind: 'msi', name: 'ot.msi', size: 5, sha256: 'b'.repeat(64) },
      ],
    });
    expect(assetFor(manifest, 'win32-x64')).toBeUndefined();
  });
});
