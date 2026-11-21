// SPDX-License-Identifier: MPL-2.0
import type { SectionControl } from './section.js';

// Apart from tab-content.ts so a tab can name its props without importing the map that imports the tab.
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
}
