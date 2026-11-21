// SPDX-License-Identifier: MPL-2.0
import { useSyncExternalStore } from 'react';

/** What the TUI needs of a store of the client (they are zustand stores; this package does not depend on it). */
export interface ReadableStore<State> {
  getState(): State;
  subscribe(listener: (state: State, previous: State) => void): () => void;
}

/** Reads one value of a store; `select` must return a primitive (or a stable reference). */
export function useStoreValue<State, Value>(
  store: ReadableStore<State>,
  select: (state: State) => Value,
): Value {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => select(store.getState()),
  );
}
