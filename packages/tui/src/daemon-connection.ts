// SPDX-License-Identifier: MPL-2.0
import {
  DaemonDirectoryError,
  LOCAL_DAEMON_NAME,
  DaemonStores,
  createLayoutStore,
  layoutSettingsFromConfig,
  type ApiClient,
  type DaemonDirectory,
  type LayoutFileStore,
  type LayoutProblem,
  type LayoutStore,
} from '@otheater/client';
import { API_ROUTES, type ApiStatus } from '@otheater/protocol';
import { parseUiSettings, type UiSettings } from './settings.js';

/** A daemon the TUI is connected to. */
export interface LiveDaemon {
  readonly status: ApiStatus;
  /** `host:port` of the API, for the screen (never carries the token). */
  readonly address: string;
  /**
   * The REST client of this daemon: the chat opens its sockets and reads the commands with it (P12),
   * and the tabs use it for the controls and the reads that have no store (P13).
   */
  readonly client: ApiClient;
  /** Starts the stores (REST snapshots and the event stream). Rejects when they cannot. */
  readonly stores: DaemonStores;
  /** Reads `ui` of the effective configuration again (`GET /v1/config`), tolerantly. */
  readSettings(): Promise<UiSettings>;
  /**
   * The layout of this interface (`ui.layout.*`, N170): the store of the place the configuration
   * chose, already read. It never rejects: a failure to read the configuration or the saved
   * layout leaves the defaults and goes to `onProblem`.
   */
  openLayout(): Promise<LayoutStore>;
  close(): void;
}

export type ConnectResult =
  | { readonly kind: 'online'; readonly daemon: LiveDaemon }
  /** No local daemon is running (nothing found by discovery). */
  | { readonly kind: 'offline' }
  /** The daemon is there but the connection failed (a wrong id, a version this client does not speak...). */
  | { readonly kind: 'failed'; readonly message: string };

/** Where the TUI gets its daemon: the real one is {@link directoryConnector}; a test passes another. */
export interface DaemonConnector {
  connect(): Promise<ConnectResult>;
}

/** Reads `ui` from `GET /v1/config`. A failure is an error for the caller to ignore or show. */
export async function readUiSettings(client: ApiClient): Promise<UiSettings> {
  const view = await client.call(API_ROUTES.getConfig);
  return parseUiSettings(view.config.ui);
}

/** What `liveDaemon` needs besides the client and the status. */
export interface LiveDaemonOptions {
  readonly address?: string | undefined;
  /** The file of `ui.layout.store: local` (the client folder in the real TUI). */
  readonly layoutFile?: LayoutFileStore | undefined;
  readonly onLayoutProblem?: ((problem: LayoutProblem) => void) | undefined;
}

export function liveDaemon(
  client: ApiClient,
  status: ApiStatus,
  options: LiveDaemonOptions = {},
): LiveDaemon {
  const stores = new DaemonStores(client);
  let layout: LayoutStore | undefined;
  return {
    status,
    address: options.address ?? '',
    client,
    stores,
    readSettings: () => readUiSettings(client),
    openLayout: async () => {
      if (layout !== undefined) return layout;
      const config = await client.call(API_ROUTES.getConfig).then(
        (view) => view.config,
        () => undefined,
      );
      layout = createLayoutStore({
        client,
        settings: layoutSettingsFromConfig(config),
        file: options.layoutFile,
        interface: 'tui',
        onProblem: options.onLayoutProblem,
      });
      await layout.load();
      return layout;
    },
    close: () => {
      layout?.close();
      stores.close();
    },
  };
}

/** The `host:port` of a daemon URL; an empty text when it is not one. */
export function addressOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Connects to the daemon of this machine (`local`) through the directory of the client. */
export function directoryConnector(
  directory: DaemonDirectory,
  name: string = LOCAL_DAEMON_NAME,
  options: Pick<LiveDaemonOptions, 'layoutFile' | 'onLayoutProblem'> = {},
): DaemonConnector {
  return {
    async connect(): Promise<ConnectResult> {
      try {
        const connected = await directory.connect(name);
        return {
          kind: 'online',
          daemon: liveDaemon(connected.client, connected.status, {
            ...options,
            address: addressOf(connected.entry.url),
          }),
        };
      } catch (error) {
        if (error instanceof DaemonDirectoryError && error.code === 'not_found') {
          return { kind: 'offline' };
        }
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
