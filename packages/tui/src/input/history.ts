// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writePrivateFileAtomic } from '@otheater/client/node';
import type { AttachmentDraft } from './attachments.js';

/**
 * The history of the messages of the box: the navigation with the arrows, the search of Ctrl+R,
 * and where it is kept between runs (N35). The navigation and the search are pure.
 */

/** One message of the history; the drafts are kept only while the TUI runs. */
export interface HistoryEntry {
  readonly text: string;
  readonly drafts: readonly AttachmentDraft[];
}

/** Where the history lives between runs. */
export interface HistoryStore {
  /** The messages, oldest first. Never rejects: a history that cannot be read is empty. */
  load(): Promise<readonly string[]>;
  /** Adds a message; rejects when it could not be saved. */
  append(text: string): Promise<void>;
}

// ---- Navigation ------------------------------------------------------------------------------

export interface HistoryNav {
  readonly entries: readonly HistoryEntry[];
  /** The entry on the box now, or `null` when the box holds what the Producer is writing. */
  readonly index: number | null;
  /** What the Producer was writing when they left it for the history. */
  readonly draft: HistoryEntry | null;
}

export function createHistoryNav(entries: readonly HistoryEntry[] = []): HistoryNav {
  return { entries, index: null, draft: null };
}

/** The previous (older) message, saving `current` as the draft on the first step back. */
export function historyOlder(
  nav: HistoryNav,
  current: HistoryEntry,
): { readonly nav: HistoryNav; readonly entry: HistoryEntry } | undefined {
  const from = nav.index ?? nav.entries.length;
  if (from <= 0) return undefined;
  const index = from - 1;
  const entry = nav.entries[index];
  if (entry === undefined) return undefined;
  return { nav: { ...nav, index, draft: nav.index === null ? current : nav.draft }, entry };
}

/** The next (newer) message, or the draft after the newest. */
export function historyNewer(
  nav: HistoryNav,
): { readonly nav: HistoryNav; readonly entry: HistoryEntry } | undefined {
  if (nav.index === null) return undefined;
  const index = nav.index + 1;
  const entry = nav.entries[index];
  if (entry === undefined) {
    return { nav: { ...nav, index: null, draft: null }, entry: nav.draft ?? { text: '', drafts: [] } };
  }
  return { nav: { ...nav, index }, entry };
}

/** The list with `entry` at the end (a message equal to the last one is not repeated), `size` at most. */
export function pushEntry(
  entries: readonly HistoryEntry[],
  entry: HistoryEntry,
  size: number,
): readonly HistoryEntry[] {
  if (entry.text.trim() === '') return entries;
  const last = entries[entries.length - 1];
  const next = last?.text === entry.text ? [...entries.slice(0, -1), entry] : [...entries, entry];
  return next.slice(Math.max(0, next.length - size));
}

// ---- Search (Ctrl+R) -------------------------------------------------------------------------

/** The indices of the entries that have `query`, newest first, a text once (case does not matter). */
export function searchHistory(
  entries: readonly HistoryEntry[],
  query: string,
): readonly number[] {
  const needle = query.toLowerCase();
  const seen = new Set<string>();
  const found: number[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const text = entries[index]?.text ?? '';
    if (seen.has(text) || !text.toLowerCase().includes(needle)) continue;
    seen.add(text);
    found.push(index);
  }
  return found;
}

// ---- Keeping it -------------------------------------------------------------------------------

/** Only while the TUI runs (`ui.input.history.store: memory`). */
export class MemoryHistoryStore implements HistoryStore {
  #entries: string[];
  readonly #size: number;

  constructor(size = 500, entries: readonly string[] = []) {
    this.#size = size;
    this.#entries = [...entries];
  }

  load(): Promise<readonly string[]> {
    return Promise.resolve([...this.#entries]);
  }

  append(text: string): Promise<void> {
    this.#entries = pushText(this.#entries, text, this.#size);
    return Promise.resolve();
  }
}

function pushText(entries: readonly string[], text: string, size: number): string[] {
  if (text.trim() === '') return [...entries];
  const base = entries[entries.length - 1] === text ? entries.slice(0, -1) : entries;
  const next = [...base, text];
  return next.slice(Math.max(0, next.length - size));
}

/** The file of the history, in the data folder of OTheater (`<data>/tui/input-history.json`). */
export function inputHistoryFile(dataDir: string): string {
  return join(dataDir, 'tui', 'input-history.json');
}

interface HistoryFile {
  readonly version: 1;
  readonly entries: readonly string[];
}

/** `ui.input.history.store: file`: a JSON file with the messages (text only), private to the user. */
export class FileHistoryStore implements HistoryStore {
  readonly #path: string;
  readonly #size: number;
  #entries: string[] | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, size = 500) {
    this.#path = path;
    this.#size = size;
  }

  async load(): Promise<readonly string[]> {
    if (this.#entries !== undefined) return [...this.#entries];
    let entries: string[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
      const list = (parsed as { entries?: unknown } | null)?.entries;
      if (Array.isArray(list)) {
        entries = list.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      // No file yet, or one that is not ours: start empty. The next save replaces it.
    }
    this.#entries = entries.slice(Math.max(0, entries.length - this.#size));
    return [...this.#entries];
  }

  append(text: string): Promise<void> {
    const run = async (): Promise<void> => {
      const current = await this.load();
      this.#entries = pushText(current, text, this.#size);
      const file: HistoryFile = { version: 1, entries: this.#entries };
      await writePrivateFileAtomic(this.#path, `${JSON.stringify(file)}\n`);
    };
    // One write at a time, and a failed one does not stop the next.
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
