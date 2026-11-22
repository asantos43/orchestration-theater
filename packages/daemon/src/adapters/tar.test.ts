// SPDX-License-Identifier: MPL-2.0
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeTar, makeTarball } from './adapter-fixture.js';
import { readTarGz, safeArchivePath, TarError } from './tar.js';

const LONG = `deep/${'folder/'.repeat(20)}file.js`;

describe('readTarGz', () => {
  it('reads the files of an npm tarball and drops the first component', () => {
    const files = readTarGz(
      makeTarball([
        { path: 'package.json', content: '{"a":1}' },
        { path: 'bin/run.js', content: 'x', mode: 0o755 },
      ]),
    );
    expect(files.map((f) => [f.path, f.data.toString(), f.executable])).toEqual([
      ['package.json', '{"a":1}', false],
      ['bin/run.js', 'x', true],
    ]);
  });

  it.each(['pax', 'gnu', 'prefix'] as const)('reads a long name given by %s', (longNames) => {
    const files = readTarGz(makeTarball([{ path: LONG, content: 'long' }], { longNames }));
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(LONG);
    expect(files[0]?.data.toString()).toBe('long');
  });

  it('skips links and other entry types, never creating them', () => {
    const files = readTarGz(
      makeTarball([{ path: 'a.js', content: 'a' }], {
        extra: [
          { name: 'package/link', type: '2' },
          { name: 'package/dev', type: '3' },
        ],
      }),
    );
    expect(files.map((f) => f.path)).toEqual(['a.js']);
  });

  it('refuses a path that leaves the archive or is absolute', () => {
    for (const name of ['package/../../evil.js', '/etc/passwd', 'package/a/../../../x']) {
      expect(() => readTarGz(makeTarball([], { extra: [{ name, content: 'x' }] }))).toThrow(
        TarError,
      );
    }
    expect(() => safeArchivePath('C:\\windows\\x')).toThrow(TarError);
  });

  it('refuses what is not a tarball, a bad checksum, a cut archive and an archive over the limit', () => {
    expect(() => readTarGz(Buffer.from('not gzip'))).toThrow(TarError);
    const tar = makeTar([{ path: 'a.js', content: 'a' }]);
    const corrupt = Buffer.from(tar);
    corrupt[10] = (corrupt[10] ?? 0) ^ 0xff;
    expect(() => readTarGz(gzipSync(corrupt))).toThrow(/checksum/u);
    expect(() => readTarGz(gzipSync(tar.subarray(0, 700)))).toThrow(/cut/u);
    expect(() =>
      readTarGz(makeTarball([{ path: 'a.js', content: 'x'.repeat(5000) }]), { maxBytes: 2048 }),
    ).toThrow(TarError);
  });

  it('an empty archive has no files', () => {
    expect(readTarGz(gzipSync(Buffer.alloc(1024)))).toEqual([]);
  });
});
