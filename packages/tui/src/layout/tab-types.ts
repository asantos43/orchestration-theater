// SPDX-License-Identifier: MPL-2.0
import type { DaemonStores } from '@otheater/client';
import type { ReactNode } from 'react';
import type { UiSettings } from '../settings.js';
import type { ReadableStore } from '../use-store-value.js';
import type { SectionControl } from './section.js';

/**
 * The contract of a tab of the panel (P9). [proposta] Kept apart from `tab-content.ts`, which imports
 * the tabs: a tab imports its types from here, so the registry and the tabs do not form a cycle.
 */

/** What a tab is given to draw its content in the panel. */
export interface TabContentProps {
  /** Cells and rows of the content area (the tab bar and the footer are not in it). */
  readonly width: number;
  readonly height: number;
  /** The panel has the focus and no overlay (palette, help, picker) is open: the tab may read keys. */
  readonly focused: boolean;
  /** Lines the person scrolled (PageUp and PageDown in the panel). A tab that scrolls uses it. */
  readonly scroll: number;
  /** The sections it can fold (`Section` takes it). */
  readonly sections: SectionControl;
  /** The scenario selected in the side bar (P13: the tabs of a play follow it). */
  readonly scenarioId?: string | undefined;
}

/** What the list of sections of a tab may depend on (P14): the stores, the scenario of the chat and the `ui` settings. */
export interface TabContext {
  readonly stores: DaemonStores;
  /** The scenario selected in the side bar (the one the chat is about); `undefined` when there is none. */
  readonly scenarioId: string | undefined;
  readonly settings: UiSettings;
}

/** The content of one tab of the panel. */
export interface TabDefinition {
  /**
   * The ids of its sections, top to bottom. The cursor of the panel walks them and Enter folds the
   * one it is on. [proposta] P14: a tab whose sections depend on data (the steps of a trajectory)
   * gives a function, and `watch` names the stores it reads so the screen asks it again.
   */
  readonly sections?:
    | readonly string[]
    | ((context: TabContext, folded: ReadonlySet<string>) => readonly string[])
    | undefined;
  /** The stores the list of `sections` depends on; the shell re-reads the list when one changes. */
  readonly watch?: ((stores: DaemonStores) => readonly ReadableStore<unknown>[]) | undefined;
  readonly render: (props: TabContentProps) => ReactNode;
}

export type TabContentMap = Readonly<Record<string, TabDefinition>>;
