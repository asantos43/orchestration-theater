// SPDX-License-Identifier: MPL-2.0
import {
  DaemonDirectoryError,
  LOCAL_DAEMON_NAME,
  DaemonStores,
  type ApiClient,
  type DaemonDirectory,
} from '@otheater/client';
import { API_ROUTES, type ApiStatus } from '@otheater/protocol';
import { parseUiSettings, type UiSettings } from './settings.js';

/** A daemon the TUI is connected to. */
export interface LiveDaemon {
  readonly status: ApiStatus;
  /** Starts the stores (REST snapshots and the event stream). Rejects when they cannot. */
  readonly stores: DaemonStores;
  /** Reads `ui` of the effective configuration again (`GET /v1/config`), tolerantly. */
  readSettings(): Promise<UiSettings>;
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

export function liveDaemon(client: ApiClient, status: ApiStatus): LiveDaemon {
  const stores = new DaemonStores(client);
  return {
    status,
    stores,
    readSettings: () => readUiSettings(client),
    close: () => {
      stores.close();
    },
  };
}

/** Connects to the daemon of this machine (`local`) through the directory of the client. */
export function directoryConnector(
  directory: DaemonDirectory,
  name: string = LOCAL_DAEMON_NAME,
): DaemonConnector {
  return {
    async connect(): Promise<ConnectResult> {
      try {
        const connected = await directory.connect(name);
        return { kind: 'online', daemon: liveDaemon(connected.client, connected.status) };
      } catch (error) {
        if (error instanceof DaemonDirectoryError && error.code === 'not_found') {
          return { kind: 'offline' };
        }
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
