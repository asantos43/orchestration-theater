// SPDX-License-Identifier: MPL-2.0
import {
  API_ROUTES,
  LAYOUT_ORIGIN_HEADER,
  LAYOUT_SYNCS,
  readLayoutText,
  defaultLayout,
  type LayoutAdjustedPayload,
  type LayoutInterface,
  type LayoutPreferences,
  type LayoutStore as LayoutStoreMode,
  type LayoutSync,
} from '@otheater/protocol';
import { z } from 'zod';
import type { ApiClient } from '../client.js';

/**
 * Where the layout of one interface is kept (P12 of docs/17, decision N170, key `ui.layout.store`).
 * Two places, the same shape to the store above them. Browser-safe: the file of the `local` mode
 * is behind {@link LayoutFileStore}, and Node's implementation is in `@otheater/client/node`.
 */

/** What a record had to go through to be read, as the event of the daemon says it (no interface). */
export type LayoutAdjustment = Omit<LayoutAdjustedPayload, 'interface'>;

export interface LayoutLoad {
  readonly layout: LayoutPreferences;
  /** Set when the record was moved up a version or replaced by the default. */
  readonly adjusted?: LayoutAdjustment | undefined;
}

export interface LayoutPersistence {
  /** Which place this is: `daemon` or `local`. */
  readonly mode: LayoutStoreMode;
  /**
   * What names this client in the saves it makes (N174): the daemon puts it in the `origin` of the
   * `layout.changed` event, so the client knows its own echo. Only the `daemon` place has one: a
   * local file is seen by no other client.
   */
  readonly clientId?: string | undefined;
  /** Reads the layout; the default when nothing was saved. */
  load(): Promise<LayoutLoad>;
  /** Saves the whole record. */
  save(layout: LayoutPreferences): Promise<void>;
}

/** The layout in the record of the interface in the daemon, by REST (`getLayout`, `putLayout`). */
export class DaemonLayoutPersistence implements LayoutPersistence {
  readonly mode = 'daemon';
  /** [proposta] A fresh random id for each instance: two stores of one interface in a process differ. */
  readonly clientId: string;
  readonly #client: ApiClient;
  readonly #interface: LayoutInterface;

  constructor(client: ApiClient, layoutInterface: LayoutInterface, clientId?: string) {
    this.#client = client;
    this.#interface = layoutInterface;
    this.clientId = clientId ?? globalThis.crypto.randomUUID();
  }

  async load(): Promise<LayoutLoad> {
    // The daemon already read, migrated and replaced the record: what comes is the current one.
    const layout = await this.#client.call(API_ROUTES.getLayout, {
      params: { interface: this.#interface },
    });
    return { layout };
  }

  async save(layout: LayoutPreferences): Promise<void> {
    await this.#client.call(API_ROUTES.putLayout, {
      params: { interface: this.#interface },
      headers: { [LAYOUT_ORIGIN_HEADER.toLowerCase()]: this.clientId },
      body: layout,
    });
  }
}

/**
 * The file of the `local` mode, as text: reading and writing it is the platform's (a file in the
 * client folder in Node; the storage of the browser in the web). [proposta] The text is JSON of a
 * {@link LayoutPreferences}; what to do with a bad one is {@link LocalLayoutPersistence}'s.
 */
export interface LayoutFileStore {
  /** The text of the file, or `undefined` when there is none. Rejects when it cannot be read. */
  read(): Promise<string | undefined>;
  /** Replaces the file, atomically where the platform can. */
  write(text: string): Promise<void>;
  /**
   * Keeps the unusable file aside, so a copy of what the person had is not lost, and frees its
   * place. Resolves `false` when nothing could be kept.
   */
  setAside(): Promise<boolean>;
}

/**
 * The layout in a local file (`ui.layout.store: local`). The same rules as the daemon's record: an
 * old version is moved up and written back, one that cannot be used is set aside and replaced by
 * the default; either way {@link LayoutLoad.adjusted} says so, for the store to warn about it.
 * Reading never rejects for a bad record, only when the file cannot be read at all.
 */
export class LocalLayoutPersistence implements LayoutPersistence {
  readonly mode = 'local';
  readonly #file: LayoutFileStore;
  readonly #interface: LayoutInterface;

  constructor(file: LayoutFileStore, layoutInterface: LayoutInterface) {
    this.#file = file;
    this.#interface = layoutInterface;
  }

  async load(): Promise<LayoutLoad> {
    const text = await this.#file.read();
    if (text === undefined) return { layout: defaultLayout(this.#interface) };
    const reading = readLayoutText(this.#interface, text);
    if (reading.outcome === 'ok') return { layout: reading.layout };
    if (reading.outcome === 'migrated') {
      // Written back so the next read is current; the migrated record serves even if this fails.
      await this.save(reading.layout).catch(() => undefined);
      return {
        layout: reading.layout,
        adjusted: {
          action: 'migrated',
          reason: null,
          fromVersion: reading.fromVersion,
          kept: false,
        },
      };
    }
    const kept = await this.#file.setAside().catch(() => false);
    return {
      layout: reading.layout,
      adjusted: {
        action: 'replaced',
        reason: reading.reason,
        fromVersion: reading.fromVersion,
        kept,
      },
    };
  }

  async save(layout: LayoutPreferences): Promise<void> {
    await this.#file.write(`${JSON.stringify(layout, null, 2)}\n`);
  }
}

/** Default of `ui.layout.write_delay` (300 ms), the same as the daemon's. */
export const DEFAULT_LAYOUT_WRITE_DELAY_MS = 300;

/** What the client reads from the effective configuration to know how to keep its layout. */
export interface LayoutSettings {
  readonly store: LayoutStoreMode;
  /** How long to wait after the last change before saving, in milliseconds. */
  readonly writeDelayMs: number;
  /** `ui.layout.sync`: `live` applies a change another client made, `on_open` only reads when it opens. */
  readonly sync: LayoutSync;
}

const ConfigLayoutSchema = z.object({
  store: z.enum(['daemon', 'local']).catch('daemon'),
  // The daemon's effective configuration carries a duration as milliseconds.
  write_delay: z.number().int().min(0).catch(DEFAULT_LAYOUT_WRITE_DELAY_MS),
  sync: z.enum(LAYOUT_SYNCS).catch('live'),
});

/**
 * `ui.layout.store`, `ui.layout.write_delay` and `ui.layout.sync` from what `getConfig` answered (`config`). A missing
 * or odd value is the default: a client of a daemon that has no such key still works.
 */
export function layoutSettingsFromConfig(config: unknown): LayoutSettings {
  const ui = (config as { ui?: { layout?: unknown } } | null | undefined)?.ui;
  const parsed = ConfigLayoutSchema.safeParse(ui?.layout ?? {});
  const value = parsed.success
    ? parsed.data
    : {
        store: 'daemon' as const,
        write_delay: DEFAULT_LAYOUT_WRITE_DELAY_MS,
        sync: 'live' as const,
      };
  return { store: value.store, writeDelayMs: value.write_delay, sync: value.sync };
}
