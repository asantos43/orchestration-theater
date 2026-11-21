// SPDX-License-Identifier: MPL-2.0
import type { ApiClient, DaemonStores } from '@otheater/client';
import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import type { TuiKeymap } from '../keys/use-keymap.js';
import type { UiSettings } from '../settings.js';
import type { SetupFlow } from '../setup/api.js';

/**
 * What a tab needs from the screen and that `TabContentProps` does not carry (P13): the stores,
 * the REST client, the keymap (to know which action a key is), the settings and, for a tab that
 * reads text (P15), a way to take the keyboard. The Shell provides it; a tab reads it with
 * {@link useTabHost}.
 * [proposta] A context, so the contract of `TabContentProps` stays as P9 fixed it.
 */
export interface TabHost {
  readonly stores: DaemonStores;
  /** Absent in a screen that has no daemon client (a test of the Shell alone): the controls turn off. */
  readonly client: ApiClient | undefined;
  readonly keymap: TuiKeymap;
  readonly settings: UiSettings;
  /** The clock of the tab (epoch ms). The tests pass a fake one. */
  readonly now: () => number;
  /**
   * While `capture.current` is true the `Shell` leaves the keys alone (Ctrl+C still quits): the tab
   * is reading text in a form. The tab clears it after the `Shell` saw the key that closed the form
   * (in a microtask), so that key does not also act as a command of the panel.
   */
  readonly capture: RefObject<boolean>;
  /**
   * Opens the setup assistant (P17) on a flow, over the whole screen. Absent in a screen that has
   * no daemon client: the tab says the assistant needs the daemon.
   */
  readonly openAssistant?: ((flow: SetupFlow) => void) | undefined;
}

const TabHostContext = createContext<TabHost | undefined>(undefined);

export function TabHostProvider(props: {
  readonly host: TabHost;
  readonly children: ReactNode;
}): ReactNode {
  return <TabHostContext.Provider value={props.host}>{props.children}</TabHostContext.Provider>;
}

export function useTabHost(): TabHost {
  const host = useContext(TabHostContext);
  if (host === undefined) throw new Error('useTabHost outside the Shell');
  return host;
}
