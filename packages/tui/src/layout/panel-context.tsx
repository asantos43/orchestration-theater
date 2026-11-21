// SPDX-License-Identifier: MPL-2.0
import type { DaemonStores } from '@otheater/client';
import { createContext, useContext } from 'react';
import type { TuiKeymap } from '../keys/use-keymap.js';

/**
 * What the content of a tab can reach beyond what `TabContentProps` draws (P16 of Phase 7). [proposta]
 * A tab that only draws needs none of it. A tab that sends commands (settings) needs the stores (and
 * through them the client), the keymap (its own actions, in the context `panel`) and a way to take
 * every key for a text field: while `capture(true)` is on, the shell handles Ctrl+C and nothing else,
 * so Enter, the letters and the arrows reach the field.
 */
export interface PanelServices {
  readonly stores: DaemonStores;
  readonly keymap: TuiKeymap;
  /** Takes (`true`) or gives back (`false`) the keys the shell would act on. */
  readonly capture: (on: boolean) => void;
  /** The scenario the chat is about (the one the header shows); `undefined` when there is none. */
  readonly scenarioId: string | undefined;
}

export const PanelContext = createContext<PanelServices | undefined>(undefined);

/** The services of the panel; throws outside the shell, where a tab that sends commands has no place. */
export function usePanelServices(): PanelServices {
  const services = useContext(PanelContext);
  if (services === undefined) throw new Error('usePanelServices: the tab is not inside the shell');
  return services;
}
