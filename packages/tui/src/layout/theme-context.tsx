// SPDX-License-Identifier: MPL-2.0
import { createContext, useContext, type ReactNode } from 'react';
import type { ThemeMode } from '../settings.js';
import { paletteOf, TERMINAL_PALETTE, type Palette } from './palette.js';

/**
 * The palette the screen draws with (`ui.theme`). Without a provider (a test of one component)
 * it is the one of the terminal, which is what the components drew before there was a theme.
 */
const ThemeContext = createContext<Palette>(TERMINAL_PALETTE);

export function ThemeProvider(props: {
  readonly mode: ThemeMode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ThemeContext.Provider value={paletteOf(props.mode)}>{props.children}</ThemeContext.Provider>
  );
}

/** The palette of the screen. */
export function useTheme(): Palette {
  return useContext(ThemeContext);
}
