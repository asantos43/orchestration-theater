// SPDX-License-Identifier: MPL-2.0
import type { ApiClient, DaemonStores } from '@otheater/client';
import { API_ROUTES } from '@otheater/protocol';
import { useEffect, useEffectEvent, useState } from 'react';

/**
 * What the top row says about a new version (Phase 10, P7). [proposta] `found` is a version the daemon
 * saw; `ready` is one it already downloaded and checked. `apply` is true in the mode `notify`, where
 * the person will be able to say "apply"; the action itself is P8, so today it is only a label.
 */
export interface UpdateHint {
  readonly version: string;
  readonly ready: boolean;
  readonly apply: boolean;
}

/** What the header needs from `GET /v1/updates`. */
export interface UpdateStatusLike {
  readonly mode: string;
  readonly effectiveMode: string;
  readonly found: string | null;
  readonly ready: string | null;
}

export function hintOf(status: UpdateStatusLike | undefined): UpdateHint | undefined {
  if (status === undefined || status.effectiveMode === 'off') return undefined;
  const version = status.ready ?? status.found;
  if (version === null) return undefined;
  return {
    version,
    ready: status.ready !== null,
    apply: status.ready !== null && status.effectiveMode === 'notify',
  };
}

/**
 * Reads the state of the updates when the link comes up and again at each `daemon.update` event. A
 * daemon that answers an error (an old one, or the service off) leaves the header as it was.
 */
export function useUpdateHint(
  client: ApiClient | undefined,
  stores: Pick<DaemonStores, 'events'>,
  live: boolean,
): UpdateHint | undefined {
  const [status, setStatus] = useState<UpdateStatusLike | undefined>(undefined);
  const load = useEffectEvent((): void => {
    if (client === undefined) return;
    void Promise.resolve()
      .then(() => client.call(API_ROUTES.getUpdateStatus))
      .then(setStatus, () => undefined);
  });
  useEffect(() => {
    if (live) load();
  }, [live]);
  useEffect(() => {
    let last = stores.events.getState().events.reduce((top, event) => Math.max(top, event.id), 0);
    return stores.events.subscribe((state) => {
      let changed = false;
      for (const event of state.events) {
        if (event.id <= last) continue;
        last = event.id;
        if (event.type === 'daemon.update') changed = true;
      }
      if (changed) load();
    });
  }, [stores]);
  return hintOf(status);
}
