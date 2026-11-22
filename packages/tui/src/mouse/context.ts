// SPDX-License-Identifier: MPL-2.0
import { createContext } from 'react';
import type { CopyOutcome } from './clipboard.js';
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

/**
 * Puts a text in the clipboard as `ui.clipboard.copy` says (the same copy a selection of the mouse
 * makes). Given by the layer whatever `ui.mouse` is: a screen that copies a text on a key (the
 * address of a sign-in) does not need the mouse reports on. Absent where there is no layer.
 */
export type CopyToClipboard = (text: string) => Promise<CopyOutcome>;

export const CopyContext = createContext<CopyToClipboard | undefined>(undefined);
