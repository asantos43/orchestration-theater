// SPDX-License-Identifier: MPL-2.0
import { createContext } from 'react';
import type { MouseRegistry } from './registry.js';

/** What the areas of the screen get from the mouse layer. Absent when there is no layer (a test, `ui.mouse: off`). */
export interface MouseContextValue {
  readonly registry: MouseRegistry;
  /** Runs `run` with the mouse reports off (the terminal belongs to another program meanwhile). */
  readonly suspend: <T>(run: () => Promise<T>) => Promise<T>;
}

export const MouseContext = createContext<MouseContextValue | undefined>(undefined);

/** The targets inside an overlay are modal: while one is open, the ones outside do not answer. */
export const MouseModalContext = createContext(false);
