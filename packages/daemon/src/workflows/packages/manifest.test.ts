// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  buildPackageManifest,
  isPackageRelativePath,
  parsePackageManifest,
  sha256Hex,
  sha256Of,
} from './manifest.js';

const FILE = Buffer.from('id: a\n');

describe('isPackageRelativePath', () => {
  it('accepts relative yaml paths made of plain segments', () => {
    for (const path of ['a.yaml', 'workflows/review.yml', 'a/b/c-d_e.1.yaml']) {
      expect(isPackageRelativePath(path)).toBe(true);
    }
  });

  it('refuses what leaves the folder, is hidden, absolute or not yaml', () => {
    for (const path of [
      '../a.yaml',
      'a/../b.yaml',
      '/etc/a.yaml',
      '.hidden.yaml',
      'a//b.yaml',
      'a\\b.yaml',
      'a.json',
      'a.yaml/',
      '',
      `${'x'.repeat(200)}.yaml`,
    ]) {
      expect(isPackageRelativePath(path)).toBe(false);
    }
  });
});

describe('the manifest', () => {
  it('is written and read back with the hash of every file', () => {
    const text = buildPackageManifest({
      id: 'review-kit',
      version: '1.2.0',
      description: 'Reviews: "quoted"\nand a second line',
      workflows: [{ path: 'workflows/review.yaml', bytes: FILE }],
    });
    expect(parsePackageManifest(text, 10)).toEqual({
      id: 'review-kit',
      version: '1.2.0',
      description: 'Reviews: "quoted"\nand a second line',
      workflows: [{ path: 'workflows/review.yaml', sha256: sha256Hex(FILE) }],
    });
  });

  it('hashes with a prefix for the record and without it for the manifest', () => {
    expect(sha256Of(FILE)).toBe(`sha256:${sha256Hex(FILE)}`);
    expect(sha256Hex(FILE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses what is not a manifest, saying where', () => {
    const bad = (text: string, pattern: RegExp): void => {
      expect(() => parsePackageManifest(text, 10)).toThrow(InvalidInput);
      expect(() => parsePackageManifest(text, 10)).toThrow(pattern);
    };
    bad('id: [\n', /not valid YAML/);
    bad('id: Review\nversion: 1.0.0\nworkflows: []\n', /id/);
    bad(
      `id: a\nversion: "1"\nworkflows:\n  - path: a.yaml\n    sha256: "${'0'.repeat(64)}"\n`,
      /version/,
    );
    bad('id: a\nversion: 1.0.0\nworkflows: []\n', /workflows/);
    bad('id: a\nversion: 1.0.0\nworkflows:\n  - path: ../a.yaml\n    sha256: "x"\n', /path|sha256/);
    bad(
      `id: a\nversion: 1.0.0\nextra: 1\nworkflows:\n  - path: a.yaml\n    sha256: "${'0'.repeat(64)}"\n`,
      /extra/,
    );
  });

  it('refuses a path listed twice and too many workflows', () => {
    const twice = buildPackageManifest({
      id: 'a',
      version: '1.0.0',
      workflows: [
        { path: 'a.yaml', bytes: FILE },
        { path: 'a.yaml', bytes: FILE },
      ],
    });
    expect(() => parsePackageManifest(twice, 10)).toThrow(/twice/);
    const two = buildPackageManifest({
      id: 'a',
      version: '1.0.0',
      workflows: [
        { path: 'a.yaml', bytes: FILE },
        { path: 'b.yaml', bytes: FILE },
      ],
    });
    expect(() => parsePackageManifest(two, 1)).toThrow(/max_workflows/);
  });
});
