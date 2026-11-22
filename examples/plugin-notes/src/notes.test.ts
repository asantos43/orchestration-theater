// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_NOTES, NOTES_FILE, NotesStore } from './notes.js';

describe('NotesStore', () => {
  let dir: string;
  const at = (iso: string) => () => new Date(iso);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-notes-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is empty when the project has no file yet', async () => {
    expect(await new NotesStore(dir).list()).toEqual([]);
  });

  it('adds notes with growing ids and keeps them in the project folder', async () => {
    const store = new NotesStore(dir, at('2026-11-21T12:00:00Z'));
    expect(await store.add('first')).toEqual({
      id: 1,
      text: 'first',
      created_at: '2026-11-21T12:00:00.000Z',
    });
    await store.add('second');
    expect((await new NotesStore(dir).list()).map((note) => note.text)).toEqual([
      'first',
      'second',
    ]);
    const file = JSON.parse(await readFile(join(dir, NOTES_FILE), 'utf8')) as { next_id: number };
    expect(file.next_id).toBe(3);
  });

  it('gives distinct ids to calls made at the same time', async () => {
    const store = new NotesStore(dir);
    const notes = await Promise.all(['a', 'b', 'c', 'd'].map((text) => store.add(text)));
    expect(notes.map((note) => note.id)).toEqual([1, 2, 3, 4]);
    expect(await store.list()).toHaveLength(4);
  });

  it('clears the notes, reports how many, and goes on with the ids', async () => {
    const store = new NotesStore(dir);
    await store.add('a');
    await store.add('b');
    expect(await store.clear()).toBe(2);
    expect(await store.list()).toEqual([]);
    expect((await store.add('c')).id).toBe(3);
    expect(await new NotesStore(dir).clear()).toBe(1);
  });

  it('refuses a note past the limit of the file', async () => {
    const notes = Array.from({ length: MAX_NOTES }, (_, index) => ({
      id: index + 1,
      text: 'n',
      created_at: '2026-11-21T12:00:00.000Z',
    }));
    await writeFile(
      join(dir, NOTES_FILE),
      JSON.stringify({ version: 1, next_id: MAX_NOTES + 1, notes }),
    );
    await expect(new NotesStore(dir).add('one more')).rejects.toThrow(/clear them first/);
  });

  it('refuses a file that is not JSON or not a notes file, and leaves it as it is', async () => {
    await writeFile(join(dir, NOTES_FILE), '{not json');
    await expect(new NotesStore(dir).list()).rejects.toThrow(/not valid JSON/);
    await expect(new NotesStore(dir).add('x')).rejects.toThrow(/not valid JSON/);
    expect(await readFile(join(dir, NOTES_FILE), 'utf8')).toBe('{not json');
    await writeFile(join(dir, NOTES_FILE), JSON.stringify({ version: 2, notes: [] }));
    await expect(new NotesStore(dir).list()).rejects.toThrow(/not a notes file/);
  });

  it('keeps working after a failed call', async () => {
    const store = new NotesStore(dir);
    await writeFile(join(dir, NOTES_FILE), 'oops');
    await expect(store.add('x')).rejects.toThrow();
    await rm(join(dir, NOTES_FILE));
    expect((await store.add('y')).id).toBe(1);
  });
});
