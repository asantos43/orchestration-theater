// SPDX-License-Identifier: MPL-2.0
import {
  LayoutChangedPayloadSchema,
  LayoutPreferencesSchema,
  defaultLayout,
  type ApiSseMessage,
  type LayoutInterface,
  type LayoutPreferences,
  type LayoutSync,
} from '@otheater/protocol';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ApiClient } from '../client.js';
import { systemClock, type Clock } from '../connection.js';
import {
  DEFAULT_LAYOUT_WRITE_DELAY_MS,
  DaemonLayoutPersistence,
  LocalLayoutPersistence,
  type LayoutAdjustment,
  type LayoutFileStore,
  type LayoutPersistence,
  type LayoutSettings,
} from './persistence.js';

/**
 * The layout of one interface in the client (P12 of docs/17): the preferences of the person
 * (side bar, width of the chat, open tabs, collapsed sections) in a zustand `vanilla` store, kept
 * by a {@link LayoutPersistence}. Browser-safe. [proposta] The rules:
 * - the first state is the default of the interface, so a screen can draw before the read ends;
 * - a change is made on the spot and saved after `writeDelayMs` of quiet: a drag of the edge of the
 *   chat is one write. The save is of the whole record, one at a time, the last one wins;
 * - `flush()` saves now what is waiting (for the close of the screen), `close()` stops for good;
 * - a failed read or save never throws at the screen: it goes to `onProblem` and to the state's
 *   `error`. A failed save is not tried again by itself: the next change saves the whole record,
 *   and `flush()` tries it again;
 * - a change that arrives before the read ends wins over the read (the person acted on what they
 *   saw), and is saved as the whole record;
 * - with `sync: live` (N174, 2026-11-20; `ui.layout.sync`) the store also follows the event
 *   `layout.changed`: a record another client saved is installed on the spot. A change of this
 *   client that is not saved yet (`dirty`) wins, as in the read, and the event is dropped; the
 *   echo of this client's own save is dropped by its `origin`. With `on_open` it follows nothing:
 *   the record is read once, by `load()`. In `ui.layout.store: local` the daemon keeps no record, so
 *   no event exists and there is nothing to follow.
 */

export interface LayoutState {
  readonly layout: LayoutPreferences;
  /** The saved layout was read (or the read failed and the default stands). */
  readonly loaded: boolean;
  /** A change is waiting for its save, or a save is in flight. */
  readonly dirty: boolean;
  /** The last failure to read or save, until the next one that works. */
  readonly error: Error | undefined;
}

/** Something the store tells `onProblem`: nothing here stops the client. */
export type LayoutProblem =
  | { readonly kind: 'load_failed'; readonly error: Error }
  | { readonly kind: 'save_failed'; readonly error: Error }
  /** The saved record was moved up a version or replaced by the default (the `local` mode). */
  | ({ readonly kind: 'adjusted'; readonly interface: LayoutInterface } & LayoutAdjustment)
  /** `ui.layout.store` is `local` but this client has no file: the daemon keeps the layout instead. */
  | { readonly kind: 'local_unavailable' }
  /** A change that would break the schema (a name too long, too many tabs) was not applied. */
  | { readonly kind: 'invalid_change'; readonly message: string };

/**
 * Where the `layout.changed` events come from: an {@link EventStream} of `types: 'layout.changed'`
 * fits. [proposta] The store owns it: it starts it in `load()`, before the read, and closes it in
 * `close()`. It is a stream of its own and not the one a screen opens to follow a scenario,
 * because the daemon's `scenario` filter drops the events that have no scenario, and a layout has
 * none.
 */
export interface LayoutEventSource {
  onMessage(listener: (message: ApiSseMessage) => void): () => void;
  start(): unknown;
  close(): void;
}

export interface LayoutStoreOptions {
  readonly interface: LayoutInterface;
  readonly persistence: LayoutPersistence;
  /** `ui.layout.sync`. Default `on_open`: without `events` the store follows nothing either way. */
  readonly sync?: LayoutSync | undefined;
  /** Used only with `sync: live`. */
  readonly events?: LayoutEventSource | undefined;
  /** Quiet time before a save, from `ui.layout.write_delay`. Default 300. */
  readonly writeDelayMs?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly onProblem?: ((problem: LayoutProblem) => void) | undefined;
}

/** What a change may set. `openTabs` and `collapsedSections` replace the list. */
export type LayoutChange = Partial<Omit<LayoutPreferences, 'version'>>;

const MIN_WIDTH = 1;
const MAX_WIDTH = 10_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class LayoutStore {
  readonly interface: LayoutInterface;
  readonly state: StoreApi<LayoutState>;

  readonly #persistence: LayoutPersistence;
  readonly #delay: number;
  readonly #clock: Clock;
  readonly #onProblem: ((problem: LayoutProblem) => void) | undefined;
  readonly #closed = new AbortController();
  readonly #events: LayoutEventSource | undefined;
  /** A record another client saved that came before the read ended: installed over it after. */
  #remote: LayoutPreferences | undefined;
  /** Goes up with every accepted change; a save is of one revision. */
  #revision = 0;
  #savedRevision = 0;
  #timer: AbortController | undefined;
  /** Saves run one after the other. */
  #chain: Promise<void> = Promise.resolve();
  #loading: Promise<void> | undefined;

  constructor(options: LayoutStoreOptions) {
    this.interface = options.interface;
    this.#persistence = options.persistence;
    this.#delay = Math.max(0, options.writeDelayMs ?? DEFAULT_LAYOUT_WRITE_DELAY_MS);
    this.#clock = options.clock ?? systemClock;
    this.#onProblem = options.onProblem;
    this.#events = options.sync === 'live' ? options.events : undefined;
    this.state = createStore<LayoutState>(() => ({
      layout: defaultLayout(options.interface),
      loaded: false,
      dirty: false,
      error: undefined,
    }));
  }

  /** The current preferences. */
  get layout(): LayoutPreferences {
    return this.state.getState().layout;
  }

  /**
   * Reads the saved layout and installs it. Never rejects: when the read fails the default stands,
   * `loaded` becomes true and the failure goes to `onProblem`. Calling it again returns the same
   * promise.
   */
  load(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<void> {
    // The stream starts before the read so a change made in between is not missed.
    this.#follow();
    try {
      const { layout, adjusted } = await this.#persistence.load();
      if (this.#closed.signal.aborted) return;
      // A change made while the read was in flight stays: it is saved as the whole record.
      if (this.#revision === 0) this.state.setState({ layout, loaded: true, error: undefined });
      else this.state.setState({ loaded: true });
      if (adjusted !== undefined)
        this.#problem({ kind: 'adjusted', interface: this.interface, ...adjusted });
    } catch (error) {
      if (this.#closed.signal.aborted) return;
      this.state.setState({ loaded: true, error: asError(error) });
      this.#problem({ kind: 'load_failed', error: asError(error) });
    }
    if (this.#remote !== undefined) {
      const remote = this.#remote;
      this.#remote = undefined;
      this.#install(remote);
    }
  }

  /** Starts to follow `layout.changed` (`sync: live` only). */
  #follow(): void {
    const events = this.#events;
    if (events === undefined) return;
    const stop = events.onMessage((message) => {
      this.#onEvent(message);
    });
    this.#closed.signal.addEventListener(
      'abort',
      () => {
        stop();
        events.close();
      },
      { once: true },
    );
    try {
      events.start();
    } catch (error) {
      // No stream is a layout that follows nothing, like `on_open`: the read still works.
      this.#problem({ kind: 'load_failed', error: asError(error) });
    }
  }

  #onEvent(message: ApiSseMessage): void {
    if (this.#closed.signal.aborted || message.event !== 'layout.changed') return;
    const payload = LayoutChangedPayloadSchema.safeParse(message.data.payload);
    if (!payload.success || payload.data.interface !== this.interface) return;
    // The echo of this client's own save: nothing to apply, and no flicker if it has gone further.
    const own = this.#persistence.clientId;
    if (own !== undefined && payload.data.origin === own) return;
    if (this.state.getState().loaded) this.#install(payload.data.layout);
    else this.#remote = payload.data.layout;
  }

  /** Installs a record another client saved, unless this client has a change of its own not saved yet. */
  #install(layout: LayoutPreferences): void {
    if (this.#closed.signal.aborted || this.state.getState().dirty) return;
    if (JSON.stringify(layout) === JSON.stringify(this.layout)) return;
    this.state.setState({ layout });
  }

  /**
   * Changes the preferences. The values are made to fit the schema (the width is rounded and kept
   * between 1 and 10000, repeated ids are dropped, a list that is too long loses its oldest ids);
   * a change that still does not fit is refused with `onProblem` and the state is kept. Returns
   * whether it was applied.
   */
  update(change: LayoutChange): boolean {
    if (this.#closed.signal.aborted) return false;
    const current = this.layout;
    const next = {
      ...current,
      ...change,
      version: current.version,
    };
    next.chatWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next.chatWidth)));
    next.openTabs = tail([...new Set(next.openTabs)], 32);
    next.collapsedSections = tail([...new Set(next.collapsedSections)], 128);
    const parsed = LayoutPreferencesSchema.safeParse(next);
    if (!parsed.success) {
      this.#problem({
        kind: 'invalid_change',
        message: parsed.error.issues[0]?.message ?? 'The layout does not fit its schema',
      });
      return false;
    }
    if (JSON.stringify(parsed.data) === JSON.stringify(current)) return true;
    this.#revision += 1;
    this.state.setState({ layout: parsed.data, dirty: true });
    this.#schedule();
    return true;
  }

  setSidebarCollapsed(collapsed: boolean): boolean {
    return this.update({ sidebarCollapsed: collapsed });
  }

  setChatWidth(width: number): boolean {
    return this.update({ chatWidth: width });
  }

  /** Opens a tab at the end of the list (nothing changes if it is open). */
  openTab(id: string): boolean {
    const tabs = this.layout.openTabs;
    return tabs.includes(id) ? true : this.update({ openTabs: [...tabs, id] });
  }

  closeTab(id: string): boolean {
    return this.update({ openTabs: this.layout.openTabs.filter((tab) => tab !== id) });
  }

  /** Collapses or expands a section (`collapsed` omitted: flips it). */
  setSectionCollapsed(id: string, collapsed?: boolean): boolean {
    const sections = this.layout.collapsedSections;
    const shouldCollapse = collapsed ?? !sections.includes(id);
    const has = sections.includes(id);
    if (shouldCollapse === has) return true;
    return this.update({
      collapsedSections: shouldCollapse ? [...sections, id] : sections.filter((s) => s !== id),
    });
  }

  /** Goes back to the default of the interface, and saves it. */
  reset(): boolean {
    const fresh = defaultLayout(this.interface);
    return this.update({
      sidebarCollapsed: fresh.sidebarCollapsed,
      chatWidth: fresh.chatWidth,
      openTabs: fresh.openTabs,
      collapsedSections: fresh.collapsedSections,
    });
  }

  /** Saves now what is waiting, and resolves when the save is done (or failed: see `error`). */
  async flush(): Promise<void> {
    this.#timer?.abort();
    this.#timer = undefined;
    await this.#enqueue();
  }

  /** Resolves when nothing is waiting or in flight. */
  async whenSaved(): Promise<void> {
    await this.#chain;
  }

  /** Stops for good: the waiting save is dropped (call `flush()` first to keep it). */
  close(): void {
    if (this.#closed.signal.aborted) return;
    this.#closed.abort();
    this.#timer?.abort();
    this.#timer = undefined;
  }

  #schedule(): void {
    this.#timer?.abort();
    const timer = new AbortController();
    this.#timer = timer;
    const stop = (): void => {
      timer.abort();
    };
    this.#closed.signal.addEventListener('abort', stop, { once: true });
    void this.#clock.sleep(this.#delay, timer.signal).then(() => {
      this.#closed.signal.removeEventListener('abort', stop);
      // `sleep` also resolves when it is aborted: only a timer that ran its time saves.
      if (timer.signal.aborted || this.#timer !== timer) return;
      this.#timer = undefined;
      void this.#enqueue();
    });
  }

  #enqueue(): Promise<void> {
    const run = this.#chain.then(() => this.#save());
    this.#chain = run;
    return run;
  }

  async #save(): Promise<void> {
    if (this.#revision === this.#savedRevision) return;
    const revision = this.#revision;
    const layout = this.layout;
    try {
      await this.#persistence.save(layout);
      this.#savedRevision = revision;
      this.state.setState({
        dirty: this.#revision !== this.#savedRevision,
        ...(this.state.getState().error === undefined ? {} : { error: undefined }),
      });
    } catch (error) {
      this.state.setState({ error: asError(error) });
      this.#problem({ kind: 'save_failed', error: asError(error) });
    }
  }

  #problem(problem: LayoutProblem): void {
    try {
      this.#onProblem?.(problem);
    } catch {
      // A handler that throws must not break a save.
    }
  }
}

/** The last `max` items. */
function tail<Item>(items: readonly Item[], max: number): Item[] {
  return items.length > max ? items.slice(items.length - max) : [...items];
}

export interface CreateLayoutStoreOptions extends Omit<
  LayoutStoreOptions,
  'persistence' | 'writeDelayMs' | 'sync' | 'events'
> {
  readonly client: ApiClient;
  /** `ui.layout.*` of the effective configuration, see `layoutSettingsFromConfig`. */
  readonly settings: LayoutSettings;
  /** The file of the `local` mode, when this client has one. */
  readonly file?: LayoutFileStore | undefined;
  /**
   * Replaces the stream of `layout.changed` that `sync: live` opens (tests). Without it the store
   * opens `client.events({ types: 'layout.changed' })`, with no scenario filter.
   */
  readonly events?: LayoutEventSource | undefined;
}

/**
 * The store of an interface with the place the configuration chose: `daemon` (REST) or `local`
 * (the file). `local` with no file to use falls back to the daemon and says so to `onProblem`.
 */
export function createLayoutStore(options: CreateLayoutStoreOptions): LayoutStore {
  const { client, settings, file, events, ...rest } = options;
  let persistence: LayoutPersistence;
  if (settings.store === 'local' && file !== undefined) {
    persistence = new LocalLayoutPersistence(file, rest.interface);
  } else {
    persistence = new DaemonLayoutPersistence(client, rest.interface);
    if (settings.store === 'local') {
      try {
        rest.onProblem?.({ kind: 'local_unavailable' });
      } catch {
        // A handler that throws must not stop the store from being made.
      }
    }
  }
  // [proposta] Only the `daemon` place has anything to follow, and only `live` asks for it.
  const live = persistence.mode === 'daemon' && settings.sync === 'live';
  return new LayoutStore({
    ...rest,
    persistence,
    writeDelayMs: settings.writeDelayMs,
    sync: settings.sync,
    ...(live ? { events: events ?? client.events({ types: 'layout.changed' }) } : {}),
  });
}
