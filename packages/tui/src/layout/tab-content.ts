// SPDX-License-Identifier: MPL-2.0
import { createElement, type ReactNode } from 'react';
import { DirectivesTab, SECTION_IDS as DIRECTIVES_SECTIONS } from '../tabs/directives/index.js';
import type { TabContentProps } from './tab-props.js';

export type { TabContentProps } from './tab-props.js';

/** The content of one tab of the panel. */
export interface TabDefinition {
  /** The ids of its sections, top to bottom. The cursor of the panel walks them and Enter folds the one it is on. */
  readonly sections?: readonly string[] | undefined;
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
  directives: {
    sections: DIRECTIVES_SECTIONS,
    render: (props) => createElement(DirectivesTab, props),
  },
};
