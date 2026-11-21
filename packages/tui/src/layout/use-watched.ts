// SPDX-License-Identifier: MPL-2.0
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ReadableStore } from '../use-store-value.js';

/**
 * A number that changes whenever one of the stores changes: a re-render for a tab that names the
 * stores its list of sections depends on (`TabDefinition.watch`). One hook for any number of stores,
 * so the hooks of the shell stay the same from one tab to the next.
 */
export function useWatched(stores: readonly ReadableStore<unknown>[]): number {
  const version = useRef(0);
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      const stops = stores.map((store) =>
        store.subscribe(() => {
          version.current += 1;
          listener();
        }),
      );
      return () => {
        for (const stop of stops) stop();
      };
    },
    [stores],
  );
  return useSyncExternalStore(subscribe, () => version.current);
}
