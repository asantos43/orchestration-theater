// SPDX-License-Identifier: MPL-2.0
import type { DaemonStores } from '@otheater/client';
import type { ApiStatus } from '@otheater/protocol';
import { useEffect, useState } from 'react';
import type { DaemonConnector, LiveDaemon } from './daemon-connection.js';
import type { UiSettings } from './settings.js';

export type DaemonView =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'online'; readonly status: ApiStatus; readonly stores: DaemonStores };

export interface UseDaemonOptions {
  /** Called with `ui` read from the daemon each time it is live (the first time and after a reconnection). */
  readonly onSettings?: ((settings: UiSettings) => void) | undefined;
}

/**
 * Connects to the daemon and keeps it connected while the component is mounted. The stores are
 * started here; their own state (`stores.status`, the counters) is read by the components that
 * show it.
 */
export function useDaemon(connector: DaemonConnector, options: UseDaemonOptions = {}): DaemonView {
  const [view, setView] = useState<DaemonView>({ kind: 'connecting' });
  const { onSettings } = options;

  useEffect(() => {
    const life = { cancelled: false };
    let daemon: LiveDaemon | undefined;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const result = await connector.connect();
      if (life.cancelled) {
        if (result.kind === 'online') result.daemon.close();
        return;
      }
      if (result.kind !== 'online') {
        setView(result);
        return;
      }
      daemon = result.daemon;
      const live = daemon;
      setView({ kind: 'online', status: live.status, stores: live.stores });
      let wasLive = false;
      unsubscribe = live.stores.status.subscribe((sync) => {
        const isLive = sync.phase === 'live' && sync.connection === 'open';
        if (isLive && !wasLive && onSettings !== undefined) {
          live
            .readSettings()
            .then((settings) => {
              if (!life.cancelled) onSettings(settings);
            })
            .catch(() => undefined);
        }
        wasLive = isLive;
      });
      live.stores.start().catch(() => undefined);
    })();

    return () => {
      life.cancelled = true;
      unsubscribe?.();
      daemon?.close();
    };
  }, [connector, onSettings]);

  return view;
}
