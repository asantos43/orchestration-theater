// SPDX-License-Identifier: MPL-2.0
import type { DaemonStores } from '@otheater/client';
import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import type { TuiKeymap } from '../keys/use-keymap.js';

/**
 * What the content of a tab needs from the screen beyond `TabContentProps` (a tab that acts, not
 * only shows): the stores of the client, to read and to send commands, the keymap, to know which
 * action a key is, and a way to take the keyboard while a form is open. [proposta] The `Shell`
 * provides it around the tab it draws; a tab reads it with `useTabEnvironment`.
 */
export interface TabEnvironment {
  readonly stores: DaemonStores;
  readonly keymap: TuiKeymap;
  /**
   * While `capture.current` is true the `Shell` leaves the keys alone (Ctrl+C still quits): the tab
   * is reading text in a form. The tab clears it after the `Shell` saw the key that closed the form
   * (in a microtask), so that key does not also act as a command of the panel.
   */
  readonly capture: RefObject<boolean>;
}

const TabEnvironmentContext = createContext<TabEnvironment | undefined>(undefined);

export function TabEnvironmentProvider(props: {
  readonly value: TabEnvironment;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <TabEnvironmentContext.Provider value={props.value}>
      {props.children}
    </TabEnvironmentContext.Provider>
  );
}

export function useTabEnvironment(): TabEnvironment {
  const environment = useContext(TabEnvironmentContext);
  if (environment === undefined) throw new Error('A tab was drawn outside the Shell.');
  return environment;
}
