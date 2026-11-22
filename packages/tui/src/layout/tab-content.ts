// SPDX-License-Identifier: MPL-2.0
import { createElement } from 'react';
import { directTab } from '../tabs/direct/index.js';
import { DirectivesTab, SECTION_IDS as DIRECTIVES_SECTIONS } from '../tabs/directives/index.js';
import { overviewTab } from '../tabs/overview/index.js';
import { pluginsTab } from '../tabs/plugins/index.js';
import { settingsTab } from '../tabs/settings/index.js';
import { trajectoriesTab } from '../tabs/trajectories/index.js';
import { usageTab } from '../tabs/usage/index.js';
import type { TabContentMap } from './tab-types.js';

export type { TabContentMap, TabContentProps, TabContext, TabDefinition } from './tab-types.js';

/**
 * The content of the tabs, by the id of the tab in the registry. [proposta] "The tabs come in
 * empty" (P9 of docs/18): this map starts empty, and the step that owns a tab fills it
 * (Overview, Trajectories, Usage, Directives, Settings, Plugins). A tab with no entry shows the
 * placeholder of the panel.
 */
export const TAB_CONTENT: TabContentMap = {
  overview: overviewTab, // P13
  trajectories: trajectoriesTab, // P14
  usage: usageTab, // P13
  direct: directTab, // P19
  directives: {
    sections: DIRECTIVES_SECTIONS,
    render: (props) => createElement(DirectivesTab, props),
  }, // P15
  settings: settingsTab, // P16
  plugins: pluginsTab, // Phase 9, P11
};
