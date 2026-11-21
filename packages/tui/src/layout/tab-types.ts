// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
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
  /** The panel has the focus. */
  readonly focused: boolean;
  /** Lines the person scrolled (PageUp and PageDown in the panel). A tab that scrolls uses it. */
  readonly scroll: number;
  /** The sections it can fold (`Section` takes it). */
  readonly sections: SectionControl;
  /** The scenario selected in the side bar (P13: the tabs of a play follow it). */
  readonly scenarioId?: string | undefined;
}

/** The content of one tab of the panel. */
export interface TabDefinition {
  /** The ids of its sections, top to bottom. The cursor of the panel walks them and Enter folds the one it is on. */
  readonly sections?: readonly string[] | undefined;
  readonly render: (props: TabContentProps) => ReactNode;
}

export type TabContentMap = Readonly<Record<string, TabDefinition>>;
