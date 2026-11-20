// SPDX-License-Identifier: MPL-2.0
import {
  LAYOUT_VERSION,
  defaultLayout,
  type ApiEventEnvelope,
  type ApiSseMessage,
  type LayoutInterface,
  type LayoutPreferences,
} from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../client.js';
import { event as eventOf } from '../stores/fixtures.test-support.js';
import { startTestDaemon, type TestDaemon } from '../test-daemon.test-support.js';
import { ManualClock } from './manual-clock.test-support.js';
import {
  DaemonLayoutPersistence,
  LocalLayoutPersistence,
  layoutSettingsFromConfig,
  type LayoutFileStore,
  type LayoutPersistence,
} from './persistence.js';
import {
  LayoutStore,
  createLayoutStore,
  type LayoutEventSource,
  type LayoutProblem,
  type LayoutStoreOptions,
} from './store.js';

const open: TestDaemon[] = [];
afterEach(async () => {
  for (const started of open.splice(0)) await started.close();
});

async function daemon(): Promise<TestDaemon> {
  const started = await startTestDaemon();
  open.push(started);
  return started;
}

const clientOf = (started: TestDaemon): ApiClient =>
  new ApiClient({ url: started.url, token: started.token });

const SAVED: LayoutPreferences = {
  version: LAYOUT_VERSION,
  sidebarCollapsed: true,
  chatWidth: 90,
  openTabs: ['overview', 'plays'],
  collapsedSections: ['quotas'],
};

interface Rig {
  readonly store: LayoutStore;
  readonly clock: ManualClock;
  readonly problems: LayoutProblem[];
}

function rig(
  persistence: LayoutPersistence,
  which: LayoutInterface = 'tui',
  options: Partial<LayoutStoreOptions> = {},
): Rig {
  const clock = new ManualClock();
  const problems: LayoutProblem[] = [];
  const store = new LayoutStore({
    interface: which,
    persistence,
    clock,
    writeDelayMs: 300,
    onProblem: (problem) => problems.push(problem),
    ...options,
  });
  return { store, clock, problems };
}

/** A persistence that records the saves and lets a test hold or fail them. */
class StubPersistence implements LayoutPersistence {
  readonly mode = 'daemon';
  readonly saved: LayoutPreferences[] = [];
  loadResult: Promise<{ layout: LayoutPreferences }> = Promise.resolve({
    layout: defaultLayout('tui'),
  });
  failSaves = false;
  /** When set, a save waits for it. */
  gate: Promise<void> | undefined;

  load(): Promise<{ layout: LayoutPreferences }> {
    return this.loadResult;
  }

  async save(layout: LayoutPreferences): Promise<void> {
    await this.gate;
    if (this.failSaves) throw new Error('save refused');
    this.saved.push(layout);
  }
}

describe('LayoutStore with the daemon', () => {
  it('starts on the default, installs what the daemon has, and saves a change after the delay', async () => {
    const started = await daemon();
    started.layouts.set('tui', SAVED);
    const { store, clock } = rig(new DaemonLayoutPersistence(clientOf(started), 'tui'));
    expect(store.layout).toEqual(defaultLayout('tui'));
    expect(store.state.getState().loaded).toBe(false);
    await store.load();
    expect(store.layout).toEqual(SAVED);
    expect(store.state.getState().loaded).toBe(true);

    store.setSidebarCollapsed(false);
    expect(store.state.getState().dirty).toBe(true);
    await clock.advance(299);
    expect(started.layouts.get('tui')).toEqual(SAVED);
    await clock.advance(1);
    await store.whenSaved();
    expect(started.layouts.get('tui')).toEqual({ ...SAVED, sidebarCollapsed: false });
    expect(store.state.getState().dirty).toBe(false);
  });

  it('gives a new client what another one saved, for the same interface only', async () => {
    const started = await daemon();
    const first = rig(new DaemonLayoutPersistence(clientOf(started), 'web'), 'web');
    await first.store.load();
    first.store.setChatWidth(640);
    first.store.openTab('plays');
    first.store.setSectionCollapsed('quotas');
    await first.store.flush();

    const second = rig(new DaemonLayoutPersistence(clientOf(started), 'web'), 'web');
    await second.store.load();
    expect(second.store.layout).toMatchObject({
      chatWidth: 640,
      openTabs: ['overview', 'plays'],
      collapsedSections: ['quotas'],
    });
    const other = rig(new DaemonLayoutPersistence(clientOf(started), 'tui'));
    await other.store.load();
    expect(other.store.layout).toEqual(defaultLayout('tui'));
  });

  it('reports a daemon that cannot be reached and keeps the default', async () => {
    const started = await daemon();
    const client = clientOf(started);
    await started.close();
    open.splice(0);
    const { store, problems } = rig(new DaemonLayoutPersistence(client, 'tui'));
    await store.load();
    expect(store.layout).toEqual(defaultLayout('tui'));
    expect(store.state.getState()).toMatchObject({ loaded: true, dirty: false });
    expect(store.state.getState().error).toBeInstanceOf(Error);
    expect(problems.map((problem) => problem.kind)).toEqual(['load_failed']);
  });
});

describe('LayoutStore debounce and saves', () => {
  it('writes once for a drag: every change restarts the wait', async () => {
    const stub = new StubPersistence();
    const { store, clock } = rig(stub);
    await store.load();
    for (let width = 61; width <= 80; width += 1) {
      store.setChatWidth(width);
      await clock.advance(100);
    }
    expect(stub.saved).toHaveLength(0);
    await clock.advance(300);
    await store.whenSaved();
    expect(stub.saved).toHaveLength(1);
    expect(stub.saved[0]?.chatWidth).toBe(80);
    expect(clock.pending).toBe(0);
  });

  it('takes the delay from the option, and 0 saves at once', async () => {
    const stub = new StubPersistence();
    const { store, clock } = rig(stub, 'tui', { writeDelayMs: 0 });
    await store.load();
    store.setChatWidth(70);
    expect(clock.asked).toEqual([0]);
    await clock.advance(0);
    await store.whenSaved();
    expect(stub.saved).toHaveLength(1);
  });

  it('does not save a change that changes nothing', async () => {
    const stub = new StubPersistence();
    const { store, clock } = rig(stub);
    await store.load();
    store.setSidebarCollapsed(false);
    store.openTab('overview');
    store.setChatWidth(60);
    expect(store.state.getState().dirty).toBe(false);
    expect(clock.asked).toEqual([]);
  });

  it('saves one at a time and the last one wins, even when a change comes during a save', async () => {
    const stub = new StubPersistence();
    const { store, clock } = rig(stub);
    await store.load();
    let release: () => void = () => undefined;
    stub.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.setChatWidth(70);
    await clock.advance(300);
    // The first save is in flight; a second change arrives and its own timer runs out.
    store.setChatWidth(75);
    await clock.advance(300);
    expect(stub.saved).toHaveLength(0);
    release();
    await store.whenSaved();
    expect(stub.saved.map((layout) => layout.chatWidth)).toEqual([70, 75]);
    expect(store.state.getState().dirty).toBe(false);
  });

  it('flush saves what is waiting now, and a later timer finds nothing to do', async () => {
    const stub = new StubPersistence();
    const { store, clock } = rig(stub);
    await store.load();
    store.setSidebarCollapsed(true);
    await store.flush();
    expect(stub.saved).toHaveLength(1);
    await clock.advance(1000);
    await store.whenSaved();
    expect(stub.saved).toHaveLength(1);
    await store.flush();
    expect(stub.saved).toHaveLength(1);
  });

  it('a failed save is reported, the state keeps the change, and the next change or flush saves it', async () => {
    const stub = new StubPersistence();
    const { store, clock, problems } = rig(stub);
    await store.load();
    stub.failSaves = true;
    store.setChatWidth(66);
    await clock.advance(300);
    await store.whenSaved();
    expect(problems.map((problem) => problem.kind)).toEqual(['save_failed']);
    expect(store.layout.chatWidth).toBe(66);
    expect(store.state.getState()).toMatchObject({ dirty: true });
    expect(store.state.getState().error?.message).toBe('save refused');
    // No retry by itself.
    await clock.advance(10_000);
    await store.whenSaved();
    expect(problems).toHaveLength(1);
    stub.failSaves = false;
    await store.flush();
    expect(stub.saved).toHaveLength(1);
    expect(stub.saved[0]?.chatWidth).toBe(66);
    expect(store.state.getState()).toMatchObject({ dirty: false, error: undefined });
  });

  it('close drops the waiting save and refuses more changes', async () => {
    const stub = new StubPersistence();
    const { store, clock } = rig(stub);
    await store.load();
    store.setChatWidth(71);
    store.close();
    await clock.advance(1000);
    await store.whenSaved();
    expect(stub.saved).toHaveLength(0);
    expect(store.setChatWidth(72)).toBe(false);
  });

  it('keeps a change made before the read ends, and saves it as the whole record', async () => {
    const stub = new StubPersistence();
    let finish: (value: { layout: LayoutPreferences }) => void = () => undefined;
    stub.loadResult = new Promise((resolve) => {
      finish = resolve;
    });
    const { store, clock } = rig(stub);
    const loading = store.load();
    store.setChatWidth(55);
    finish({ layout: SAVED });
    await loading;
    expect(store.layout).toEqual({ ...defaultLayout('tui'), chatWidth: 55 });
    await clock.advance(300);
    await store.whenSaved();
    expect(stub.saved).toEqual([{ ...defaultLayout('tui'), chatWidth: 55 }]);
  });
});

describe('LayoutStore changes', () => {
  it('opens and closes tabs, and collapses and flips sections', async () => {
    const { store } = rig(new StubPersistence());
    await store.load();
    store.openTab('plays');
    store.openTab('plays');
    expect(store.layout.openTabs).toEqual(['overview', 'plays']);
    store.closeTab('overview');
    expect(store.layout.openTabs).toEqual(['plays']);
    store.setSectionCollapsed('quotas');
    store.setSectionCollapsed('events', true);
    store.setSectionCollapsed('events', true);
    expect(store.layout.collapsedSections).toEqual(['quotas', 'events']);
    store.setSectionCollapsed('quotas');
    expect(store.layout.collapsedSections).toEqual(['events']);
    store.reset();
    expect(store.layout).toEqual(defaultLayout('tui'));
  });

  it('keeps the width between 1 and 10000 and whole, and drops the oldest ids of a full list', async () => {
    const { store, problems } = rig(new StubPersistence());
    await store.load();
    store.setChatWidth(0);
    expect(store.layout.chatWidth).toBe(1);
    store.setChatWidth(99_999.4);
    expect(store.layout.chatWidth).toBe(10_000);
    store.setChatWidth(61.6);
    expect(store.layout.chatWidth).toBe(62);
    for (let tab = 0; tab < 40; tab += 1) store.openTab(`tab-${String(tab)}`);
    expect(store.layout.openTabs).toHaveLength(32);
    expect(store.layout.openTabs.at(-1)).toBe('tab-39');
    expect(store.layout.openTabs).not.toContain('overview');
    expect(problems).toHaveLength(0);
  });

  it('refuses a change that does not fit the schema and says so', async () => {
    const { store, problems } = rig(new StubPersistence());
    await store.load();
    expect(store.openTab('')).toBe(false);
    expect(store.openTab('x'.repeat(65))).toBe(false);
    expect(store.setChatWidth(Number.NaN)).toBe(false);
    expect(store.layout).toEqual(defaultLayout('tui'));
    expect(problems.map((problem) => problem.kind)).toEqual([
      'invalid_change',
      'invalid_change',
      'invalid_change',
    ]);
  });

  it('is not broken by a handler of problems that throws', async () => {
    const stub = new StubPersistence();
    stub.failSaves = true;
    const { store, clock } = rig(stub, 'tui', {
      onProblem: () => {
        throw new Error('handler');
      },
    });
    await store.load();
    store.setChatWidth(70);
    await clock.advance(300);
    await expect(store.whenSaved()).resolves.toBeUndefined();
    expect(store.state.getState().dirty).toBe(true);
  });
});

/** The file of the `local` mode in memory. */
class MemoryFile implements LayoutFileStore {
  text: string | undefined;
  aside: string | undefined;
  failAside = false;
  writes = 0;

  constructor(text?: string) {
    this.text = text;
  }

  read(): Promise<string | undefined> {
    return Promise.resolve(this.text);
  }

  write(text: string): Promise<void> {
    this.text = text;
    this.writes += 1;
    return Promise.resolve();
  }

  setAside(): Promise<boolean> {
    if (this.failAside) return Promise.resolve(false);
    this.aside = this.text;
    this.text = undefined;
    return Promise.resolve(true);
  }
}

describe('LocalLayoutPersistence', () => {
  it('reads the default when there is no file, and saves and reads the whole record', async () => {
    const file = new MemoryFile();
    const first = rig(new LocalLayoutPersistence(file, 'tui'));
    await first.store.load();
    expect(first.store.layout).toEqual(defaultLayout('tui'));
    expect(first.problems).toHaveLength(0);
    first.store.update({ chatWidth: 77, openTabs: ['plays'] });
    await first.store.flush();
    expect(JSON.parse(file.text ?? '')).toMatchObject({ chatWidth: 77, openTabs: ['plays'] });
    const second = rig(new LocalLayoutPersistence(file, 'tui'));
    await second.store.load();
    expect(second.store.layout).toMatchObject({ chatWidth: 77, openTabs: ['plays'] });
    expect(second.problems).toHaveLength(0);
  });

  it.each([
    ['not JSON', '{ nope', 'invalid', null],
    [
      'a newer version',
      JSON.stringify({ ...SAVED, version: LAYOUT_VERSION + 1 }),
      'newer_version',
      LAYOUT_VERSION + 1,
    ],
    [
      'out of the schema',
      JSON.stringify({ ...SAVED, chatWidth: 'wide' }),
      'invalid',
      LAYOUT_VERSION,
    ],
  ])(
    'replaces a file that is %s by the default, sets it aside and warns',
    async (_name, text, reason, fromVersion) => {
      const file = new MemoryFile(text);
      const { store, problems } = rig(new LocalLayoutPersistence(file, 'web'), 'web');
      await store.load();
      expect(store.layout).toEqual(defaultLayout('web'));
      expect(file.aside).toBe(text);
      expect(file.text).toBeUndefined();
      expect(problems).toEqual([
        { kind: 'adjusted', interface: 'web', action: 'replaced', reason, fromVersion, kept: true },
      ]);
      expect(store.state.getState().loaded).toBe(true);
    },
  );

  it('says the copy was not kept when it could not be set aside', async () => {
    const file = new MemoryFile('[]');
    file.failAside = true;
    const local = new LocalLayoutPersistence(file, 'tui');
    expect((await local.load()).adjusted).toMatchObject({ kept: false });
  });

  it('a file that cannot be read at all is a failed read, and the default stands', async () => {
    const broken: LayoutFileStore = {
      read: () => Promise.reject(new Error('EACCES')),
      write: () => Promise.resolve(),
      setAside: () => Promise.resolve(false),
    };
    const { store, problems } = rig(new LocalLayoutPersistence(broken, 'tui'));
    await store.load();
    expect(store.layout).toEqual(defaultLayout('tui'));
    expect(problems.map((problem) => problem.kind)).toEqual(['load_failed']);
  });
});

describe('createLayoutStore and layoutSettingsFromConfig', () => {
  it('reads ui.layout from the effective configuration, with the defaults for what is missing', () => {
    expect(
      layoutSettingsFromConfig({ ui: { layout: { store: 'local', write_delay: 1000 } } }),
    ).toEqual({
      store: 'local',
      writeDelayMs: 1000,
      sync: 'live',
    });
    expect(layoutSettingsFromConfig({ ui: { layout: { sync: 'on_open' } } }).sync).toBe('on_open');
    for (const config of [
      undefined,
      null,
      {},
      { ui: {} },
      { ui: { layout: 7 } },
      { ui: { layout: { store: 'cloud', write_delay: 'soon', sync: 'never' } } },
    ]) {
      expect(layoutSettingsFromConfig(config)).toEqual({
        store: 'daemon',
        writeDelayMs: 300,
        sync: 'live',
      });
    }
    expect(layoutSettingsFromConfig({ ui: { layout: { write_delay: 0 } } }).writeDelayMs).toBe(0);
  });

  it('keeps the layout where the settings say: the daemon, or the local file', async () => {
    const started = await daemon();
    const client = clientOf(started);
    const viaDaemon = createLayoutStore({
      client,
      interface: 'tui',
      settings: { store: 'daemon', writeDelayMs: 0, sync: 'on_open' },
      clock: new ManualClock(),
    });
    viaDaemon.setChatWidth(70);
    await viaDaemon.flush();
    expect(started.layouts.get('tui')?.chatWidth).toBe(70);

    const file = new MemoryFile();
    const viaFile = createLayoutStore({
      client,
      interface: 'tui',
      settings: { store: 'local', writeDelayMs: 0, sync: 'on_open' },
      file,
      clock: new ManualClock(),
    });
    viaFile.setChatWidth(80);
    await viaFile.flush();
    expect(file.writes).toBe(1);
    expect(started.layouts.get('tui')?.chatWidth).toBe(70);
  });

  it('falls back to the daemon, with a problem, when local is asked and there is no file', async () => {
    const started = await daemon();
    const problems: LayoutProblem[] = [];
    const store = createLayoutStore({
      client: clientOf(started),
      interface: 'web',
      settings: { store: 'local', writeDelayMs: 0, sync: 'on_open' },
      clock: new ManualClock(),
      onProblem: (problem) => problems.push(problem),
    });
    expect(problems).toEqual([{ kind: 'local_unavailable' }]);
    store.setChatWidth(500);
    await store.flush();
    expect(started.layouts.get('web')?.chatWidth).toBe(500);
  });
});

/** A stream of `layout.changed` the test drives by hand. */
class FakeEvents implements LayoutEventSource {
  started = 0;
  closed = 0;
  readonly #listeners = new Set<(message: ApiSseMessage) => void>();
  #id = 0;

  onMessage(listener: (message: ApiSseMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    this.started += 1;
  }

  close(): void {
    this.closed += 1;
  }

  get listening(): number {
    return this.#listeners.size;
  }

  /** The daemon announces that `layout` was saved by `origin` for `which`. */
  changed(layout: unknown, origin: string | null = 'other-client', which = 'tui'): void {
    this.#id += 1;
    const envelope = eventOf(this.#id, 'layout.changed', {
      interface: which,
      origin,
      layout,
    } as ApiEventEnvelope['payload']);
    const message = { id: String(envelope.id), event: envelope.type, data: envelope };
    for (const listener of [...this.#listeners]) listener(message);
  }
}

describe('LayoutStore following layout.changed (N174)', () => {
  const live = (
    persistence: LayoutPersistence = new StubPersistence(),
    sync: 'live' | 'on_open' = 'live',
  ): Rig & { events: FakeEvents } => {
    const events = new FakeEvents();
    return { ...rig(persistence, 'tui', { sync, events }), events };
  };

  it('with live, installs the record another client saved, with no read and no save', async () => {
    const stub = new StubPersistence();
    const { store, events, clock } = live(stub);
    await store.load();
    expect(events.started).toBe(1);
    events.changed(SAVED);
    expect(store.layout).toEqual(SAVED);
    expect(store.state.getState().dirty).toBe(false);
    await clock.advance(1000);
    expect(stub.saved).toHaveLength(0);
  });

  it('with on_open, does not subscribe and does not apply', async () => {
    const { store, events } = live(new StubPersistence(), 'on_open');
    await store.load();
    expect(events.started).toBe(0);
    expect(events.listening).toBe(0);
    events.changed(SAVED);
    expect(store.layout).toEqual(defaultLayout('tui'));
  });

  it('a change of this client not saved yet wins over the event', async () => {
    const stub = new StubPersistence();
    const { store, events, clock } = live(stub);
    await store.load();
    store.setChatWidth(55);
    expect(store.state.getState().dirty).toBe(true);
    events.changed(SAVED);
    expect(store.layout.chatWidth).toBe(55);
    expect(store.layout.sidebarCollapsed).toBe(false);
    await clock.advance(300);
    await store.whenSaved();
    expect(stub.saved).toEqual([{ ...defaultLayout('tui'), chatWidth: 55 }]);
    // Once saved, the next record of another client is followed again.
    events.changed(SAVED);
    expect(store.layout).toEqual(SAVED);
  });

  it('ignores the echo of its own save, even when the layout has gone further', async () => {
    const started = await daemon();
    const persistence = new DaemonLayoutPersistence(clientOf(started), 'tui', 'me');
    const { store, events, clock } = live(persistence);
    await store.load();
    store.setChatWidth(70);
    await clock.advance(300);
    await store.whenSaved();
    store.setChatWidth(80);
    await clock.advance(300);
    await store.whenSaved();
    // The first echo arrives when the layout is already at 80 and saved: it must not move it back.
    events.changed({ ...defaultLayout('tui'), chatWidth: 70 }, 'me');
    expect(store.layout.chatWidth).toBe(80);
    // Another client's record is applied.
    events.changed(SAVED, 'someone-else');
    expect(store.layout).toEqual(SAVED);
    // A record with no origin is not this client's either.
    events.changed({ ...SAVED, chatWidth: 33 }, null);
    expect(store.layout.chatWidth).toBe(33);
  });

  it('names itself in its saves, so the daemon can say who wrote', async () => {
    const started = await daemon();
    const persistence = new DaemonLayoutPersistence(clientOf(started), 'tui', 'me');
    await persistence.save(SAVED);
    const put = started.requests.find((request) => request.method === 'PUT');
    expect(put?.headers['x-ot-client-id']).toBe('me');
    expect(new DaemonLayoutPersistence(clientOf(started), 'tui').clientId).toMatch(
      /^[\x21-\x7e]+$/,
    );
  });

  it('ignores the events of the other interface, and of a record that does not fit', async () => {
    const { store, events } = live();
    await store.load();
    events.changed(SAVED, 'x', 'web');
    events.changed({ ...SAVED, version: 2 });
    events.changed({ ...SAVED, chatWidth: 0 });
    expect(store.layout).toEqual(defaultLayout('tui'));
  });

  it('an event that comes before the read ends is installed over the read, once it ends', async () => {
    const stub = new StubPersistence();
    let finish: (value: { layout: LayoutPreferences }) => void = () => undefined;
    stub.loadResult = new Promise((resolve) => {
      finish = resolve;
    });
    const { store, events } = live(stub);
    const loading = store.load();
    // The stream is started before the read.
    expect(events.started).toBe(1);
    events.changed({ ...SAVED, chatWidth: 77 });
    expect(store.layout).toEqual(defaultLayout('tui'));
    finish({ layout: SAVED });
    await loading;
    expect(store.layout).toEqual({ ...SAVED, chatWidth: 77 });
  });

  it('close stops following and closes the stream', async () => {
    const { store, events } = live();
    await store.load();
    store.close();
    expect(events.closed).toBe(1);
    expect(events.listening).toBe(0);
    events.changed(SAVED);
    expect(store.layout).toEqual(defaultLayout('tui'));
  });

  it('createLayoutStore opens the stream only for the daemon place with sync live', async () => {
    const started = await daemon();
    const client = clientOf(started);
    const make = (
      settings: { store: 'daemon' | 'local'; sync: 'live' | 'on_open' },
      file?: MemoryFile,
    ): FakeEvents => {
      const events = new FakeEvents();
      const store = createLayoutStore({
        client,
        interface: 'tui',
        settings: { ...settings, writeDelayMs: 0 },
        ...(file === undefined ? {} : { file }),
        events,
        clock: new ManualClock(),
      });
      void store.load();
      return events;
    };
    expect(make({ store: 'daemon', sync: 'live' }).started).toBe(1);
    expect(make({ store: 'daemon', sync: 'on_open' }).started).toBe(0);
    expect(make({ store: 'local', sync: 'live' }, new MemoryFile()).started).toBe(0);
  });
});
