// SPDX-License-Identifier: MPL-2.0
import {
  ApiClient,
  DaemonStores,
  LayoutStore,
  LocalLayoutPersistence,
  type LayoutFileStore,
} from '@otheater/client';
import {
  API_VERSION,
  type ApiPlay,
  type ApiQuotaStatus,
  type ApiScenario,
} from '@otheater/protocol';
import type { ConnectResult, DaemonConnector, LiveDaemon } from './daemon-connection.js';
import { DEFAULT_UI_SETTINGS, type UiSettings } from './settings.js';

/**
 * What the tests of the layout need to put the TUI online without a daemon (N57): stores that
 * start with what the test gives them, and a `LayoutStore` over a file in memory, so "closing and
 * reopening" is a second app over the same file and the real folders of the person are never read.
 */

/** The file of `ui.layout.store: local`, in memory. */
export class MemoryLayoutFile implements LayoutFileStore {
  text: string | undefined;
  writes = 0;

  read(): Promise<string | undefined> {
    return Promise.resolve(this.text);
  }

  write(text: string): Promise<void> {
    this.text = text;
    this.writes += 1;
    return Promise.resolve();
  }

  setAside(): Promise<boolean> {
    this.text = undefined;
    return Promise.resolve(true);
  }
}

export interface FakeOnline {
  readonly connector: DaemonConnector;
  readonly stores: DaemonStores;
  readonly file: MemoryLayoutFile;
  /** The layout stores opened (one per app that connected). */
  readonly layouts: LayoutStore[];
  readonly closed: () => number;
}

export interface FakeOnlineOptions {
  readonly file?: MemoryLayoutFile | undefined;
  readonly address?: string | undefined;
  /** Whether the stream is live (the default) or still being read. */
  readonly live?: boolean | undefined;
}

/** A connector that is online with stores that no network feeds: the test fills them with `setState`. */
export function fakeOnline(options: FakeOnlineOptions = {}): FakeOnline {
  const file = options.file ?? new MemoryLayoutFile();
  // The client is never asked for anything: the stores are not started.
  const client = new ApiClient({ url: 'http://127.0.0.1:9', token: 'test' });
  const stores = new DaemonStores(client);
  stores.start = () => Promise.resolve();
  if (options.live !== false) {
    stores.status.setState({ phase: 'live', connection: 'open', cursor: 0, error: undefined });
  }
  const layouts: LayoutStore[] = [];
  let closes = 0;
  const daemon: LiveDaemon = {
    status: {
      pid: 1,
      startedAt: 0,
      version: '0.0.0-test',
      dataDir: '/data',
      state: 'running',
      daemonId: '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b',
      apiVersion: API_VERSION,
    },
    address: options.address ?? '127.0.0.1:7777',
    stores,
    readSettings: () => Promise.resolve(DEFAULT_UI_SETTINGS),
    openLayout: async () => {
      const layout = new LayoutStore({
        interface: 'tui',
        persistence: new LocalLayoutPersistence(file, 'tui'),
        writeDelayMs: 5,
      });
      await layout.load();
      layouts.push(layout);
      return layout;
    },
    close: () => {
      closes += 1;
      for (const layout of layouts) layout.close();
    },
  };
  const result: ConnectResult = { kind: 'online', daemon };
  return {
    connector: { connect: () => Promise.resolve(result) },
    stores,
    file,
    layouts,
    closed: () => closes,
  };
}

let sequence = 0;

/** A scenario as the store of the client keeps it (only what the layout reads is meaningful). */
export function scenario(name: string, overrides: Partial<ApiScenario> = {}): ApiScenario {
  sequence += 1;
  return {
    id: `S${String(sequence)}`,
    name,
    state: 'active',
    updatedAt: 1_000 - sequence,
    ...overrides,
  } as unknown as ApiScenario;
}

export function play(scenarioId: string, overrides: Partial<ApiPlay> = {}): ApiPlay {
  sequence += 1;
  return {
    id: `P${String(sequence)}`,
    scenarioId,
    need: 'a need',
    state: 'RUNNING',
    finishedAt: null,
    updatedAt: 1_000 + sequence,
    ...overrides,
  } as unknown as ApiPlay;
}

export function quota(
  profile: string,
  fiveHour: number | undefined,
  week: number | undefined,
  state: ApiQuotaStatus['state'] = 'ok',
): ApiQuotaStatus {
  return {
    profile,
    state,
    windows: [
      ...(fiveHour === undefined ? [] : [{ window: '5h', usedPercent: fiveHour }]),
      ...(week === undefined ? [] : [{ window: '7d', usedPercent: week }]),
    ],
  } as unknown as ApiQuotaStatus;
}

/** Fills the stores with a few scenarios, plays, a decision and two accounts. */
export function seedStores(stores: DaemonStores): { scenarios: ApiScenario[] } {
  const scenarios = [scenario('Billing API'), scenario('Mobile app'), scenario('Docs site')];
  const [first, second] = scenarios;
  stores.scenarios.setState({
    byId: Object.fromEntries(scenarios.map((item) => [item.id, item])),
  } as never);
  const running = play(first?.id ?? '');
  stores.plays.setState({ byId: { [running.id]: running } } as never);
  stores.decisions.setState({ byScenario: { [second?.id ?? '']: [{ id: 'D1' }] } } as never);
  stores.quotas.setState({
    byProfile: {
      'claude-main': quota('claude-main', 62, 31),
      'codex-work': quota('codex-work', 12, 8),
    },
  } as never);
  return { scenarios };
}

export function settingsWith(layout: Partial<UiSettings['tuiLayout']>): UiSettings {
  return { ...DEFAULT_UI_SETTINGS, tuiLayout: { ...DEFAULT_UI_SETTINGS.tuiLayout, ...layout } };
}
