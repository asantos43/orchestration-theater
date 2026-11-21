// SPDX-License-Identifier: MPL-2.0
import type { ApiClient, DaemonStores } from '@otheater/client';
import { createContext, useContext, type ReactNode } from 'react';
import type { TuiKeymap } from '../keys/use-keymap.js';
import type { UiSettings } from '../settings.js';

/**
 * What a tab needs from the screen and that `TabContentProps` does not carry (P13): the stores,
 * the REST client and the settings. The Shell provides it; a tab reads it with {@link useTabHost}.
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
