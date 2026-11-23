// SPDX-License-Identifier: MPL-2.0
import { createContext, useContext, type ReactNode } from 'react';
import type { Density } from '../settings.js';

/**
 * The density of the screen (`ui.tuiLayout.density`, N258). `comfortable` has the margins and the
 * alignment of the mockup: a column of margin inside each frame, a blank row and an indent in the
 * sections of the panel. `compact` is the screen as it was before the margins: the content touches
 * the border.
 */
export interface DensityValue {
  readonly mode: Density;
  /** Columns of margin inside a frame, on each side: 1 in `comfortable`, 0 in `compact`. */
  readonly pad: number;
  /** The tabs of the panel with the sections in the mockup's way: a blank row between them, content indented. */
  readonly sections: boolean;
}

/** Columns of margin inside a frame, on each side, in this mode. */
export const FRAME_PAD: Readonly<Record<Density, number>> = { comfortable: 1, compact: 0 };

/** The value of a mode. */
export function densityOf(mode: Density): DensityValue {
  return { mode, pad: FRAME_PAD[mode], sections: mode === 'comfortable' };
}

/** Cells of content a frame of `width` has once its two borders and its margins are taken. */
export function frameInner(width: number, pad: number): number {
  return Math.max(0, width - 2 - 2 * pad);
}

const COMPACT = densityOf('compact');
const COMFORTABLE = densityOf('comfortable');

/**
 * Without a provider (a test of one component) it is `compact`, which is what the components drew
 * before there was a density; the shell provides the one of `ui.tuiLayout.density`.
 */
const DensityContext = createContext<DensityValue>(COMPACT);

export function DensityProvider(props: {
  readonly mode: Density;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <DensityContext.Provider value={props.mode === 'comfortable' ? COMFORTABLE : COMPACT}>
      {props.children}
    </DensityContext.Provider>
  );
}

/** The density of the screen. */
export function useDensity(): DensityValue {
  return useContext(DensityContext);
}

/**
 * A row that goes from border to border inside a frame that has a margin: the box takes the margin
 * back (a negative `marginX`) and the text is given it again as blank cells, so a separator or the
 * highlight of a selected line spans the whole width while the text stays inside the margin.
 * `pad` is the margin of the frame; with 0 it is a plain box.
 */
export function edgeMargin(pad: number): { readonly marginX: number } {
  return { marginX: pad === 0 ? 0 : -pad };
}
