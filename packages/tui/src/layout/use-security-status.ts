// SPDX-License-Identifier: MPL-2.0
import type { ApiClient, DaemonStores } from '@otheater/client';
import { API_ROUTES, type ApiSecurityStatus } from '@otheater/protocol';
import { useEffect, useEffectEvent, useState } from 'react';
import type { SecurityBannerMode } from '../settings.js';

/**
 * The fixed row about the protection (N334, 2026-11-26; [proposta]). It says one of two things, and
 * only when layer 3 (the sandbox) is missing:
 * - `refuse`: `security.unenforced` is `refuse`, so the Director does not open here;
 * - `reduced`: it is `warn` or `allow`, so the Director opens with the protection reduced.
 * With layer 3 there is no row. `ui.security.banner: off` turns the row off.
 */
export interface SecurityBanner {
  readonly kind: 'refuse' | 'reduced';
  readonly value: string;
}

export function bannerOf(
  status: ApiSecurityStatus | undefined,
  mode: SecurityBannerMode,
): SecurityBanner | undefined {
  if (mode === 'off' || status === undefined || status.layer3) return undefined;
  return { kind: status.unenforced === 'refuse' ? 'refuse' : 'reduced', value: status.unenforced };
}

/**
 * Reads what the daemon says of layer 3 and of `security.unenforced` when the link comes up and at
 * each `daemon.notice` event. A daemon that answers no `security` (an old one) or an error leaves
 * the screen without the row.
 */
export function useSecurityStatus(
  client: ApiClient | undefined,
  stores: Pick<DaemonStores, 'events'>,
  live: boolean,
): ApiSecurityStatus | undefined {
  const [status, setStatus] = useState<ApiSecurityStatus | undefined>(undefined);
  const load = useEffectEvent((): void => {
    if (client === undefined) return;
    void Promise.resolve()
      .then(() => client.call(API_ROUTES.getStatus))
      .then(
        (answer) => {
          setStatus(answer.security);
        },
        () => undefined,
      );
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
        if (event.type === 'daemon.notice') changed = true;
      }
      if (changed) load();
    });
  }, [stores]);
  return status;
}
