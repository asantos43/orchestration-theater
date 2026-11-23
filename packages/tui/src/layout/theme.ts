// SPDX-License-Identifier: MPL-2.0

export { TOKEN } from './palette.js';

/**
 * The colours the layout had before `ui.theme`: Ink's names (the terminal's own palette), plus the
 * header's blue. Use `TOKEN` and the themed `Text` instead; this one is left for the tab Settings,
 * which moves to the theme in its own step.
 */
export const COLOR = {
  border: 'gray',
  borderActive: 'blueBright',
  accent: 'blueBright',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  header: '#3a46a8',
  headerText: 'white',
  headerKey: '#ffd479',
  key: 'yellow',
  keyBackground: '#2b3140',
  selected: '#232a44',
  overlay: '#14171d',
} as const;

/** `color` and `backgroundColor` as props, leaving out what is not set (Ink does not take `undefined`). */
export function paint(
  color?: string,
  background?: string,
): { color?: string; backgroundColor?: string } {
  return {
    ...(color === undefined ? {} : { color }),
    ...(background === undefined ? {} : { backgroundColor: background }),
  };
}
