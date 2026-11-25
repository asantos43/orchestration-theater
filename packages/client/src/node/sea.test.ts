// SPDX-License-Identifier: MPL-2.0
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dataDirArgument,
  extractNative,
  isSeaProcess,
  listSeaAssets,
  loadSeaNative,
  onSeaNativeSweepFailure,
  readSeaAsset,
  readSeaAssetBytes,
  SEA_INTERNAL_PREFIX,
  type SeaSweepFailure,
} from './sea.js';
import { configureTemporaryCleanup } from './temporaries.js';

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

describe('extractNative: orphan temporaries of a killed process (N306)', () => {
  const DEAD = 2_000_000_000;
  const hex = '0123456789ab';
  const dead = (pid: number): boolean => pid !== process.pid && pid !== 4242;

  /** The folder of an addon after one extraction, so the hash folder exists. */
  function folderOf(dir: string, bytes: string): string {
    return join(extractNative('a.node', Buffer.from(bytes), { dataDir: dir }), '..');
  }

  it('removes the temporary of a dead pid, on a fresh extraction and when the good copy is there', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    const orphan = join(folder, `.a.node.${String(DEAD)}.${hex}.tmp`);
    writeFileSync(orphan, 'half');
    extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: () => false });
    expect(readdirSync(folder)).toEqual(['a.node']);

    // The good copy is gone and the orphan is there: the extraction writes again and cleans too.
    writeFileSync(orphan, 'half');
    rmSync(join(folder, 'a.node'));
    extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: () => false });
    expect(readdirSync(folder)).toEqual(['a.node']);
  });

  it('keeps the temporary of a live pid (another extraction in the same folder)', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    const live = join(folder, `.a.node.4242.${hex}.tmp`);
    writeFileSync(live, 'in flight');
    extractNative('a.node', Buffer.from('one'), {
      dataDir: dir,
      isPidAlive: (pid) => pid === 4242,
    });
    expect(readFileSync(live, 'utf8')).toBe('in flight');
  });

  it('removes a temporary that carries its own pid (a pid reused by a restart)', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    const own = join(folder, `.a.node.${String(process.pid)}.${hex}.tmp`);
    writeFileSync(own, 'half');
    extractNative('a.node', Buffer.from('one'), { dataDir: dir });
    expect(readdirSync(folder)).toEqual(['a.node']);
  });

  it('never touches a name outside the pattern, nor the temporary of another addon', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    const others = [
      `.a.node.${hex}.tmp`, // the name without a pid
      `.a.node.${String(DEAD)}.${hex}.tmp.keep`,
      `.a.node.${String(DEAD)}.XYZ.tmp`,
      `.b.node.${String(DEAD)}.${hex}.tmp`, // another addon's
      `x.a.node.${String(DEAD)}.${hex}.tmp`,
      `.aXnode.${String(DEAD)}.${hex}.tmp`, // the dot of the name is not a wildcard
      'notes.txt',
    ];
    for (const name of others) writeFileSync(join(folder, name), 'keep');
    extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: dead });
    expect(readdirSync(folder).sort()).toEqual(['a.node', ...others].sort());
  });

  it('in age mode removes the old temporary whatever its pid and keeps the new one', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    const old = `.a.node.4242.${hex}.tmp`;
    const fresh = `.a.node.${String(DEAD)}.${hex}.tmp`;
    writeFileSync(join(folder, old), 'old');
    writeFileSync(join(folder, fresh), 'new');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(folder, old), twoHoursAgo, twoHoursAgo);
    const stop = configureTemporaryCleanup({ mode: 'age', maxAgeMs: 60 * 60_000 });
    try {
      extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: () => true });
    } finally {
      stop();
    }
    expect(readdirSync(folder).sort()).toEqual([fresh, 'a.node'].sort());
  });

  it('with the cleaning off keeps every temporary', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    const orphan = `.a.node.${String(DEAD)}.${hex}.tmp`;
    writeFileSync(join(folder, orphan), 'half');
    const stop = configureTemporaryCleanup({ mode: 'off' });
    try {
      extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: () => false });
    } finally {
      stop();
    }
    expect(readdirSync(folder).sort()).toEqual([orphan, 'a.node'].sort());
  });

  it('tells a temporary it cannot remove and goes on', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    // A folder with the name of a temporary: `rmSync` without `recursive` refuses it.
    const stuck = `.a.node.${String(DEAD)}.${hex}.tmp`;
    mkdirSync(join(folder, stuck));
    const failures: SeaSweepFailure[] = [];
    const file = extractNative('a.node', Buffer.from('one'), {
      dataDir: dir,
      isPidAlive: () => false,
      onSweepFailure: (failure) => failures.push(failure),
    });
    expect(readFileSync(file, 'utf8')).toBe('one');
    expect(failures.map((failure) => failure.name)).toEqual([stuck]);
    expect(failures[0]?.error).toBeInstanceOf(Error);
  });

  it('hands a failure to the sink of the daemon, also one that came before the sink was set', () => {
    const dir = tmp();
    const folder = folderOf(dir, 'one');
    const stuck = `.a.node.${String(DEAD)}.${hex}.tmp`;
    mkdirSync(join(folder, stuck));
    // No sink yet: the failure waits.
    extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: () => false });
    const names: string[] = [];
    const stop = onSeaNativeSweepFailure((failure) => names.push(failure.name));
    expect(names).toEqual([stuck]);
    // With the sink set, the next one goes straight to it.
    extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: () => false });
    expect(names).toEqual([stuck, stuck]);
    stop();
    extractNative('a.node', Buffer.from('one'), { dataDir: dir, isPidAlive: () => false });
    expect(names).toHaveLength(2);
    // Leave the module the way it was found: the failure above waits in the queue, so drain it.
    onSeaNativeSweepFailure(() => undefined)();
  });
});
