// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dataDirArgument,
  extractNative,
  isSeaProcess,
  listSeaAssets,
  loadSeaNative,
  readSeaAsset,
  readSeaAssetBytes,
  SEA_INTERNAL_PREFIX,
} from './sea.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ot-sea-client-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('outside a single executable', () => {
  it('is not a SEA and has no assets', () => {
    expect(isSeaProcess()).toBe(false);
    expect(readSeaAsset('locales/en/cli.json')).toBeUndefined();
    expect(readSeaAssetBytes('x')).toBeUndefined();
    expect(listSeaAssets('prompts/')).toEqual([]);
  });

  it('refuses to load a native asset that is not there', () => {
    expect(() => loadSeaNative('native/x.node', 'abc')).toThrow(/no native asset/);
  });

  it('has the mode prefix the executable looks for', () => {
    expect(SEA_INTERNAL_PREFIX).toBe('--ot-internal=');
  });
});

describe('dataDirArgument', () => {
  it('reads both spellings and stops at --', () => {
    expect(dataDirArgument(['--data-dir', '/a'])).toBe('/a');
    expect(dataDirArgument(['x', '--data-dir=/b'])).toBe('/b');
    expect(dataDirArgument(['--', '--data-dir', '/c'])).toBeUndefined();
    expect(dataDirArgument([])).toBeUndefined();
  });
});

describe('extractNative', () => {
  it('writes the addon under the hash of its bytes and returns the path', () => {
    const dir = tmp();
    const file = extractNative('a.node', Buffer.from('one'), { dataDir: dir });
    expect(file.startsWith(join(dir, 'native'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('one');
    // Nothing is left behind but the addon.
    expect(readdirSync(join(file, '..'))).toEqual(['a.node']);
  });

  it('reuses a good copy and puts another version beside the old one', () => {
    const dir = tmp();
    const first = extractNative('a.node', Buffer.from('one'), { dataDir: dir });
    const mtime = statSync(first).mtimeMs;
    expect(extractNative('a.node', Buffer.from('one'), { dataDir: dir })).toBe(first);
    expect(statSync(first).mtimeMs).toBe(mtime);
    const second = extractNative('a.node', Buffer.from('two'), { dataDir: dir });
    expect(second).not.toBe(first);
    expect(readFileSync(first, 'utf8')).toBe('one');
  });

  it('replaces a copy that was damaged', () => {
    const dir = tmp();
    const file = extractNative('a.node', Buffer.from('one'), { dataDir: dir });
    writeFileSync(file, 'broken');
    expect(extractNative('a.node', Buffer.from('one'), { dataDir: dir })).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe('one');
  });

  it('finds the data folder from --data-dir when none is given', () => {
    const dir = tmp();
    const file = extractNative('a.node', Buffer.from('x'), { argv: ['--data-dir', dir], env: {} });
    expect(file.startsWith(dir)).toBe(true);
  });
});
