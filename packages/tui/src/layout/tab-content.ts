// SPDX-License-Identifier: MPL-2.0
import { overviewTab } from '../tabs/overview/index.js';
import { usageTab } from '../tabs/usage/index.js';
import type { TabContentMap } from './tab-types.js';

export type { TabContentMap, TabContentProps, TabDefinition } from './tab-types.js';

/**
 * The content of the tabs, by the id of the tab in the registry. [proposta] "The tabs come in
 * empty" (P9 of docs/18): this map starts empty, and the step that owns a tab fills it
 * (Overview, Trajectories, Usage, Directives, Settings). A tab with no entry shows the
 * placeholder of the panel.
 */
export const TAB_CONTENT: TabContentMap = {
  overview: overviewTab, // P13
  usage: usageTab, // P13
};
