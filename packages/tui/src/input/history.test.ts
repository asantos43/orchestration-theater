// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileHistoryStore,
  MemoryHistoryStore,
  createHistoryNav,
  historyNewer,
  historyOlder,
  inputHistoryFile,
  pushEntry,
  searchHistory,
  type HistoryEntry,
} from './history.js';

const entry = (text: string): HistoryEntry => ({ text, drafts: [] });
const list = (...texts: string[]): readonly HistoryEntry[] => texts.map(entry);

describe('navigation of the history', () => {
  it('goes back from the newest, keeps the draft, and returns to it', () => {
    const nav = createHistoryNav(list('one', 'two', 'three'));
    const first = historyOlder(nav, entry('draft'));
    expect(first?.entry.text).toBe('three');
    const second = historyOlder(first!.nav, entry('three'));
    expect(second?.entry.text).toBe('two');
    const back = historyNewer(second!.nav);
    expect(back?.entry.text).toBe('three');
    const end = historyNewer(back!.nav);
    expect(end?.entry.text).toBe('draft');
    expect(end?.nav.index).toBeNull();
    expect(historyNewer(end!.nav)).toBeUndefined();
  });

  it('stops at the oldest message and has nowhere to go with an empty history', () => {
    let nav = createHistoryNav(list('only'));
    const step = historyOlder(nav, entry(''));
    nav = step!.nav;
    expect(historyOlder(nav, entry('only'))).toBeUndefined();
    expect(historyOlder(createHistoryNav(), entry('x'))).toBeUndefined();
  });

  it('adds a message once, drops the empty ones and keeps the newest `size`', () => {
    expect(pushEntry(list('a'), entry('a'), 10)).toHaveLength(1);
    expect(pushEntry(list('a'), entry('  '), 10)).toHaveLength(1);
    expect(pushEntry(list('a', 'b'), entry('c'), 2).map((item) => item.text)).toEqual(['b', 'c']);
  });
});

describe('search of the history', () => {
  const entries = list('Fix the build', 'write docs', 'fix the lint', 'write docs', 'deploy');

  it('finds the matches newest first, ignoring case and repeated messages', () => {
    expect(searchHistory(entries, 'fix')).toEqual([2, 0]);
    expect(searchHistory(entries, 'DOCS')).toEqual([3]);
    expect(searchHistory(entries, 'nothing')).toEqual([]);
  });

  it('matches every message with an empty query', () => {
    expect(searchHistory(entries, '')).toEqual([4, 3, 2, 0]);
  });
});

describe('the stores of the history', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function temp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ot-history-'));
    dirs.push(dir);
    return dir;
  }

  it('keeps the messages in memory, once each and up to the size', async () => {
    const store = new MemoryHistoryStore(2, ['a']);
    await store.append('b');
    await store.append('b');
    await store.append('c');
    expect(await store.load()).toEqual(['b', 'c']);
  });

  it('puts the file in the data folder', () => {
    expect(inputHistoryFile('/data')).toBe(join('/data', 'tui', 'input-history.json'));
  });

  it('writes the file, private to the user, and reads it back in another run', async () => {
    const path = inputHistoryFile(await temp());
    const first = new FileHistoryStore(path, 3);
    expect(await first.load()).toEqual([]);
    await Promise.all([first.append('one'), first.append('two'), first.append('three')]);
    await first.append('four');
    const second = new FileHistoryStore(path, 3);
    expect(await second.load()).toEqual(['two', 'three', 'four']);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      entries: ['two', 'three', 'four'],
    });
  });

  it('starts empty from a file that is not a history, and replaces it on the next save', async () => {
    const path = inputHistoryFile(await temp());
    await new FileHistoryStore(path).append('x');
    await writeFile(path, 'not json');
    const store = new FileHistoryStore(path);
    expect(await store.load()).toEqual([]);
    await store.append('y');
    expect(await new FileHistoryStore(path).load()).toEqual(['y']);
  });

  it('rejects the append that could not be saved, and the next one still works', async () => {
    const dir = await temp();
    // The parent of the file is a regular file, so the folder cannot be created.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, '');
    const bad = new FileHistoryStore(join(blocker, 'history.json'));
    await expect(bad.append('x')).rejects.toBeDefined();
    await expect(bad.append('y')).rejects.toBeDefined();
  });
});
