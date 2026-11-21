// SPDX-License-Identifier: MPL-2.0
import type { DaemonStores } from '@otheater/client';
import type { ReactNode } from 'react';
import type { UiSettings } from '../settings.js';
import type { ReadableStore } from '../use-store-value.js';
import { trajectoriesTab } from '../tabs/trajectories/index.js';
import type { SectionControl } from './section.js';

/** What a tab knows of the screen besides its size: the stores, the scenario the chat is about and the `ui` settings. [proposta] P14 */
export interface TabContext {
  readonly stores: DaemonStores;
  /** The scenario selected in the side bar (the one the chat is about); `undefined` when there is none. */
  readonly scenarioId: string | undefined;
  readonly settings: UiSettings;
}

/** What a tab is given to draw its content in the panel. */
export interface TabContentProps extends TabContext {
  /** Cells and rows of the content area (the tab bar and the footer are not in it). */
  readonly width: number;
  readonly height: number;
  /** The panel has the focus. */
  readonly focused: boolean;
  /** Lines the person scrolled (PageUp and PageDown in the panel). A tab that scrolls uses it. */
  readonly scroll: number;
  /** The sections it can fold (`Section` takes it). */
  readonly sections: SectionControl;
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

/**
 * The content of the tabs, by the id of the tab in the registry. [proposta] "The tabs come in
 * empty" (P9 of docs/18): this map starts empty, and the step that owns a tab fills it
 * (Overview, Trajectories, Usage, Directives, Settings). A tab with no entry shows the
 * placeholder of the panel.
 */
export const TAB_CONTENT: TabContentMap = {
  trajectories: trajectoriesTab,
};
