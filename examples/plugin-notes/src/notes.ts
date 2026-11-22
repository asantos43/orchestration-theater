// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** The file of the notes, in the project folder [proposta]. */
export const NOTES_FILE = '.plugin-notes.json';

/** The most notes the file keeps and the longest note: the file is read whole on each call. */
export const MAX_NOTES = 1000;
export const MAX_NOTE_CHARS = 2000;

export interface Note {
  readonly id: number;
  readonly text: string;
  /** ISO 8601 UTC. */
  readonly created_at: string;
}

const NotesFile = z.strictObject({
  version: z.literal(1),
  next_id: z.int().min(1),
  notes: z.array(
    z.strictObject({
      id: z.int().min(1),
      text: z.string(),
      created_at: z.string(),
    }),
  ),
});
type NotesFileData = z.output<typeof NotesFile>;

/**
 * The notes of one project, in `<project>/.plugin-notes.json`. Calls of one process are
 * serialized, so two `add_note` in a row never share an id; the file is replaced whole through a
 * rename, so a reader never sees half a write. It uses no network and nothing outside the folder.
 */
export class NotesStore {
  readonly #file: string;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(projectDir: string, now: () => Date = () => new Date()) {
    this.#file = join(projectDir, NOTES_FILE);
    this.#now = now;
  }

  list(): Promise<Note[]> {
    return this.#serial(async () => (await this.#read()).notes);
  }

  add(text: string): Promise<Note> {
    return this.#serial(async () => {
      const data = await this.#read();
      if (data.notes.length >= MAX_NOTES) {
        throw new Error(`the project already has ${String(MAX_NOTES)} notes: clear them first`);
      }
      const note: Note = { id: data.next_id, text, created_at: this.#now().toISOString() };
      await this.#write({ ...data, next_id: data.next_id + 1, notes: [...data.notes, note] });
      return note;
    });
  }

  /** Deletes every note and returns how many there were. The ids go on from where they were. */
  clear(): Promise<number> {
    return this.#serial(async () => {
      const data = await this.#read();
      await this.#write({ ...data, notes: [] });
      return data.notes.length;
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<NotesFileData> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, next_id: 1, notes: [] };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${NOTES_FILE} is not valid JSON: fix or delete it`);
    }
    const parsed = NotesFile.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `${NOTES_FILE} is not a notes file (${parsed.error.issues[0]?.message ?? ''})`,
      );
    }
    return parsed.data;
  }

  async #write(data: NotesFileData): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.#file);
  }
}
