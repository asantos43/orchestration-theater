// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '@otheater/client/node';
import { InvalidInput } from '@otheater/core';
import { z } from 'zod';

/**
 * What the triggers remember across restarts (docs/24 section 8; plan of Phase 11b, P6), in
 * `<data>/workflow-triggers.json` [proposta] (plain JSON, written atomically, mode 0600):
 *
 * - `seen`: the items (`issue_opened:12`, `pr_opened:7`, `ci_failed:7:<sha>`, `event:<id>`) a
 *   binding has dealt with, fired or dropped for good. An item in it never fires again. The ledger
 *   is half of the once-only guarantee; the other half is the id of the run, which is a function
 *   of the binding and the item (a crash between the start and the mark is caught by the
 *   `Conflict` of the second start).
 * - `pending`: the events a `queue` binding could not start because it was busy; they go first at
 *   the next look. (The items of the code host need no queue: they are still on the host.)
 * - `eventCursor`: the id of the last event of the log the event triggers have read.
 *
 * Keys of the same binding are kept up to {@link SEEN_LIMIT}; the oldest are forgotten after
 * that. [proposta] 5000 items per binding is years of issues of a normal repository, and an item
 * old enough to be forgotten is older than the `createdAt` filter of any binding that would see it.
 */

export const WORKFLOW_TRIGGERS_FILE_VERSION = 1;

/** The most keys kept per binding. [proposta] */
export const SEEN_LIMIT = 5000;

/** The most events a `queue` binding keeps waiting. [proposta] */
export const PENDING_LIMIT = 100;

/** The file of the ledger inside the data directory. */
export function workflowTriggersFile(dataDir: string): string {
  return join(dataDir, 'workflow-triggers.json');
}

const PendingEventSchema = z.strictObject({
  key: z.string().min(1),
  /** Id of the event in the log. */
  eventId: z.int().min(1),
  /** Place of the trigger in the list of the binding. */
  triggerIndex: z.int().min(0),
  queuedAt: z.int().min(0),
});
export type PendingEvent = z.infer<typeof PendingEventSchema>;

const BindingEntrySchema = z.strictObject({
  seen: z.record(z.string(), z.int().min(0)),
  pending: z.array(PendingEventSchema),
});
type BindingEntry = z.infer<typeof BindingEntrySchema>;

const TriggersFileSchema = z.strictObject({
  version: z.literal(WORKFLOW_TRIGGERS_FILE_VERSION),
  eventCursor: z.int().min(0).nullable(),
  bindings: z.record(z.string(), BindingEntrySchema),
});
type TriggersFile = z.infer<typeof TriggersFileSchema>;

export class SeenLedger {
  readonly #file: string;
  #data: TriggersFile | undefined;
  #loading: Promise<TriggersFile> | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async has(bindingId: string, key: string): Promise<boolean> {
    const data = await this.#load();
    return data.bindings[bindingId]?.seen[key] !== undefined;
  }

  /** Marks the item as dealt with. Marking it again changes nothing. */
  async mark(bindingId: string, key: string, at: number): Promise<void> {
    await this.#change((data) => {
      const entry = entryOf(data, bindingId);
      if (entry.seen[key] !== undefined) return false;
      entry.seen[key] = at;
      const keys = Object.keys(entry.seen);
      if (keys.length > SEEN_LIMIT) {
        entry.seen = Object.fromEntries(Object.entries(entry.seen).slice(-SEEN_LIMIT));
      }
      return true;
    });
  }

  async eventCursor(): Promise<number | null> {
    return (await this.#load()).eventCursor;
  }

  async setEventCursor(id: number): Promise<void> {
    await this.#change((data) => {
      if (data.eventCursor === id) return false;
      data.eventCursor = id;
      return true;
    });
  }

  async pending(bindingId: string): Promise<readonly PendingEvent[]> {
    return (await this.#load()).bindings[bindingId]?.pending ?? [];
  }

  /**
   * Keeps an event for the next look. Returns the entries that did not fit and were dropped
   * (the oldest ones, past {@link PENDING_LIMIT}); an entry already there is not added twice.
   */
  async enqueue(bindingId: string, event: PendingEvent): Promise<readonly PendingEvent[]> {
    let dropped: PendingEvent[] = [];
    await this.#change((data) => {
      const entry = entryOf(data, bindingId);
      if (entry.pending.some((item) => item.key === event.key)) return false;
      entry.pending.push(event);
      dropped = entry.pending.splice(0, Math.max(0, entry.pending.length - PENDING_LIMIT));
      return true;
    });
    return dropped;
  }

  async dequeue(bindingId: string, key: string): Promise<void> {
    await this.#change((data) => {
      const entry = data.bindings[bindingId];
      if (entry === undefined) return false;
      const before = entry.pending.length;
      entry.pending = entry.pending.filter((item) => item.key !== key);
      return entry.pending.length !== before;
    });
  }

  async #load(): Promise<TriggersFile> {
    if (this.#data !== undefined) return this.#data;
    this.#loading ??= this.#read().then((data) => {
      this.#data = data;
      return data;
    });
    try {
      return await this.#loading;
    } catch (error) {
      this.#loading = undefined;
      throw error;
    }
  }

  async #read(): Promise<TriggersFile> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: WORKFLOW_TRIGGERS_FILE_VERSION, eventCursor: null, bindings: {} };
      }
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new InvalidInput(`${this.#file} is not valid JSON`, { cause: error });
    }
    const parsed = TriggersFileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new InvalidInput(
        `${this.#file} is not a ledger of workflow triggers: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      );
    }
    return parsed.data;
  }

  /** Applies a change in memory and, when it changed something, writes the file. One write at a time. */
  #change(apply: (data: TriggersFile) => boolean): Promise<void> {
    const run = async (): Promise<void> => {
      const data = await this.#load();
      if (!apply(data)) return;
      await writePrivateFileAtomic(this.#file, `${JSON.stringify(data, null, 2)}\n`);
    };
    const result = this.#chain.then(run, run);
    this.#chain = result.catch(() => undefined);
    return result;
  }
}

function entryOf(data: TriggersFile, bindingId: string): BindingEntry {
  return (data.bindings[bindingId] ??= { seen: {}, pending: [] });
}
