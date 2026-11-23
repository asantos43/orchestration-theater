// SPDX-License-Identifier: MPL-2.0
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeTar, makeTarball } from './adapter-fixture.js';
import { DEFAULT_MAX_ENTRIES, readTarGz, safeArchivePath, TarError } from './tar.js';

const LONG = `deep/${'folder/'.repeat(20)}file.js`;

describe('readTarGz: duplicates and the entry limit', () => {
  it('refuses a path that appears twice, and one that differs only in case', () => {
    for (const second of ['a.js', 'A.js']) {
      expect(() =>
        readTarGz(
          makeTarball([
            { path: 'a.js', content: '1' },
            { path: second, content: '2' },
          ]),
        ),
      ).toThrow(/twice/u);
    }
  });

  it('counts every entry but the pax and long-name headers against maxEntries', () => {
    const archive = makeTarball([{ path: LONG, content: 'x' }], {
      longNames: 'pax',
      extra: [{ name: 'package/link', type: '2' }],
    });
    // The directory `package/`, the file and the link: three entries.
    expect(readTarGz(archive, { maxEntries: 3 })).toHaveLength(1);
    expect(() => readTarGz(archive, { maxEntries: 2 })).toThrow(TarError);
    expect(() => readTarGz(archive, { maxEntries: 2 })).toThrow(/more than 2 entries/u);
  });

  it('has a default limit that a normal package is far from', () => {
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `f${String(i)}`, content: '' }));
    expect(readTarGz(makeTarball(files))).toHaveLength(200);
    expect(DEFAULT_MAX_ENTRIES).toBe(20_000);
  });
});

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
