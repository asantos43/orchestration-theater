// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LAYOUT_INTERFACES,
  defaultLayout,
  readLayoutText,
  type LayoutInterface,
  type LayoutReading,
  type LayoutPreferences,
} from '@otheater/protocol';
import { writePrivateFile } from '../api/files.js';
import type { Logger } from '../logger.js';
import type { SituationSink } from '../situations.js';

/**
 * The layout preferences the daemon keeps for the interfaces (architecture 5.13, decision N170;
 * P12 of docs/17): one record per interface (`tui`, `web`), read and written by REST
 * (`GET`/`PUT /v1/layout/:interface`). [proposta] The rules:
 * - one JSON file per interface, `<data>/layout/<interface>.json`, written atomically (a temporary
 *   file, then a rename). A table in the store would ask for a migration of every store adapter
 *   for what is a few hundred bytes of preference, so a file is the simpler place;
 * - the records are read once, at the start, and then kept in memory: a read of the REST never
 *   touches the disk, and a file edited by hand while the daemon runs is not seen;
 * - a record in an old version is moved up and written back; one that cannot be used (a newer
 *   version, damaged, outside the schema) is moved aside as `<interface>.json.bad` and the default
 *   serves until the next write. Both are recorded as the event `layout.adjusted`. Nothing here
 *   stops the start: a layout is a preference;
 * - a write is the whole record, one after the other; the memory changes only after the file does;
 * - a normal write is not an event: dragging the edge of the chat would fill the log with it.
 */

/** The suffix of the copy of a record that was replaced. */
export const LAYOUT_KEPT_SUFFIX = '.bad';

export interface LayoutPreferencesOptions {
  /** `<data>/layout`. */
  readonly dir: string;
  readonly situations: SituationSink;
  readonly logger: Pick<Logger, 'warn'>;
  /**
   * How the text of a record is read: the protocol's own unless a test brings another, because no
   * version older than the current one exists yet to be moved up for real.
   */
  readonly read?: (layoutInterface: LayoutInterface, text: string) => LayoutReading;
}

function fileOf(dir: string, layoutInterface: LayoutInterface): string {
  return join(dir, `${layoutInterface}.json`);
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT';
}

export class LayoutPreferencesStore {
  readonly #dir: string;
  readonly #records = new Map<LayoutInterface, LayoutPreferences>();
  /** Writes run one at a time: the rename of one must not meet the rename of the next. */
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Reads the record of every interface. Never rejects. */
  static async open(options: LayoutPreferencesOptions): Promise<LayoutPreferencesStore> {
    const store = new LayoutPreferencesStore(options.dir);
    await Promise.all(LAYOUT_INTERFACES.map((which) => store.#load(which, options)));
    return store;
  }

  async #load(which: LayoutInterface, options: LayoutPreferencesOptions): Promise<void> {
    const path = fileOf(this.#dir, which);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      this.#records.set(which, defaultLayout(which));
      if (isNotFound(error)) return;
      options.logger.warn(
        { interface: which },
        'the layout record could not be read: default used',
      );
      options.situations.record('layout.adjusted', {
        interface: which,
        action: 'replaced',
        reason: 'invalid',
        fromVersion: null,
        kept: false,
      });
      return;
    }
    const reading = (options.read ?? readLayoutText)(which, text);
    this.#records.set(which, reading.layout);
    if (reading.outcome === 'ok') return;
    if (reading.outcome === 'migrated') {
      try {
        await this.#write(which, reading.layout);
      } catch {
        // The migrated record serves from memory; the old file stays and is migrated again next start.
        options.logger.warn(
          { interface: which },
          'the migrated layout record could not be written',
        );
      }
      options.logger.warn(
        { interface: which, fromVersion: reading.fromVersion },
        'the layout record was moved up to the current version',
      );
      options.situations.record('layout.adjusted', {
        interface: which,
        action: 'migrated',
        reason: null,
        fromVersion: reading.fromVersion,
        kept: false,
      });
      return;
    }
    let kept = true;
    try {
      await rename(path, `${path}${LAYOUT_KEPT_SUFFIX}`);
    } catch {
      kept = false;
    }
    options.logger.warn(
      { interface: which, reason: reading.reason, fromVersion: reading.fromVersion },
      'the layout record could not be used: default used',
    );
    options.situations.record('layout.adjusted', {
      interface: which,
      action: 'replaced',
      reason: reading.reason,
      fromVersion: reading.fromVersion,
      kept,
    });
  }

  /** The preferences of an interface: the saved ones, or the default when none was saved. */
  get(which: LayoutInterface): LayoutPreferences {
    return this.#records.get(which) ?? defaultLayout(which);
  }

  /** Saves the whole record of an interface and returns it. Rejects if the file cannot be written. */
  put(which: LayoutInterface, layout: LayoutPreferences): Promise<LayoutPreferences> {
    const run = async (): Promise<LayoutPreferences> => {
      await this.#write(which, layout);
      this.#records.set(which, layout);
      return layout;
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #write(which: LayoutInterface, layout: LayoutPreferences): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await writePrivateFile(fileOf(this.#dir, which), `${JSON.stringify(layout, null, 2)}\n`);
  }
}
