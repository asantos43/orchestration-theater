// SPDX-License-Identifier: MPL-2.0
import type { ThemeMode } from '../settings.js';

/**
 * The colours of the screen, by what they mean. The components name a role (`TOKEN.warn`) and the
 * theme (`ui.theme`) says which colour that is: `terminal` gives the 16 named colours of the
 * terminal, as the screen always had, and `otheater` gives the palette of the mockup
 * (`docs/framework-ideas/mockup/tui.html`) in hex. Ink hands a hex colour to chalk, which brings
 * it down to 256 or 16 colours when the terminal has no true colour.
 */

/** The roles. A role that has no colour in a theme is not painted (the terminal's own text). */
export const TOKEN_NAMES = [
  /** The text of the screen. */
  'text',
  /** A bold text that has no colour of its own. */
  'strong',
  /** What is secondary (replaces the SGR `dim` in `otheater`). */
  'dim',
  /** The hint after a key of the shortcut bar. */
  'hint',
  'border',
  'borderActive',
  /** The title of a frame, and of the frame that has the focus. */
  'title',
  'titleActive',
  'accent',
  'ok',
  'warn',
  'error',
  /** A system message of the chat. */
  'sys',
  /** The author "you" of the chat. */
  'you',
  /** A neutral highlight (a marker, a heading). */
  'info',
  /** A key (`F5`) inside a text. */
  'key',
  'keyBackground',
  'header',
  'headerText',
  'headerKey',
  /** The row under the cursor: its background and its text. */
  'selected',
  'selectedText',
  /** The tab that is open. */
  'tabText',
  /** The background of an overlay (a menu, a prompt). */
  'overlay',
  /** The cursor of the text box. */
  'caret',
  'caretText',
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

/** `TOKEN.warn` is `'@warn'`: a colour the themed `Text` replaces with the one of the theme. */
export const TOKEN = Object.fromEntries(TOKEN_NAMES.map((name) => [name, `@${name}`])) as {
  readonly [K in TokenName]: `@${K}`;
};

type Colors = Readonly<Record<TokenName, string | undefined>>;

/** What the screen has always been: Ink's named colours (they follow the theme of the terminal). */
const TERMINAL: Colors = {
  text: undefined,
  strong: undefined,
  dim: undefined,
  hint: undefined,
  border: 'gray',
  borderActive: 'blueBright',
  title: 'gray',
  titleActive: 'blueBright',
  accent: 'blueBright',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  sys: 'magenta',
  you: 'cyanBright',
  info: 'cyan',
  key: 'yellow',
  keyBackground: '#2b3140',
  header: '#3a46a8',
  headerText: 'white',
  headerKey: '#ffd479',
  selected: '#232a44',
  selectedText: undefined,
  tabText: 'white',
  overlay: '#14171d',
  caret: undefined,
  caretText: undefined,
};

/** The palette of the mockup (the CSS of `tui.html`). */
const OTHEATER: Colors = {
  text: '#c9ced6',
  strong: '#e6e8ec',
  dim: '#6b7380',
  hint: '#9aa3af',
  border: '#3a4150',
  borderActive: '#7d8cff',
  title: '#e6e8ec',
  titleActive: '#aab4ff',
  accent: '#8f9cff',
  ok: '#4fc98f',
  warn: '#e8a948',
  error: '#ef6b6b',
  sys: '#b4a6ff',
  you: '#7cc4ff',
  info: '#8f9cff',
  key: '#ffd479',
  keyBackground: '#2b3140',
  header: '#3a46a8',
  headerText: '#ffffff',
  headerKey: '#ffd479',
  selected: '#232a44',
  selectedText: '#ffffff',
  tabText: '#ffffff',
  overlay: '#14171d',
  caret: '#c9ced6',
  caretText: '#11141a',
};

/** The background of the mockup's terminal, which the seven-day bars (`.wk`, opacity .6) fade into. */
const MOCKUP_BACKGROUND = '#11141a';
const WEEK_OPACITY = 0.6;

function channels(hex: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) return undefined;
  return [
    parseInt(match[1] ?? '0', 16),
    parseInt(match[2] ?? '0', 16),
    parseInt(match[3] ?? '0', 16),
  ];
}

/** `color` at `opacity` over `background`, as `#rrggbb`; a colour that is not a hex is returned as it is. */
export function blendHex(color: string, background: string, opacity: number): string {
  const top = channels(color);
  const bottom = channels(background);
  if (top === undefined || bottom === undefined) return color;
  const mixed = top.map((value, index) =>
    Math.round(value * opacity + (bottom[index] ?? 0) * (1 - opacity)),
  );
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** A theme: the colours of the roles, and what to do with the SGR `dim` of the terminal. */
export interface Palette {
  readonly mode: ThemeMode;
  /** The colour of a role; `undefined` when the theme leaves it to the terminal. */
  token(name: TokenName): string | undefined;
  /** A colour as given to a component: a role (`'@warn'`) becomes its colour, anything else stays. */
  resolve(value: string | undefined): string | undefined;
  /** `true` when `dimColor` is drawn with the colour of `dim` and not with the SGR `dim`. */
  readonly paintsDim: boolean;
  /** The colour of a seven-day bar (the same colour, faded as in the mockup). */
  fade(color: string): string;
}

function makePalette(mode: ThemeMode, colors: Colors): Palette {
  const token = (name: TokenName): string | undefined => colors[name];
  return {
    mode,
    token,
    resolve: (value) => {
      if (value?.startsWith('@') !== true) return value;
      const name = value.slice(1);
      return (TOKEN_NAMES as readonly string[]).includes(name) ? token(name as TokenName) : value;
    },
    paintsDim: mode === 'otheater',
    fade: (color) =>
      mode === 'otheater' ? blendHex(color, MOCKUP_BACKGROUND, WEEK_OPACITY) : color,
  };
}

export const TERMINAL_PALETTE: Palette = makePalette('terminal', TERMINAL);
export const OTHEATER_PALETTE: Palette = makePalette('otheater', OTHEATER);

/** The palette of a `ui.theme` mode. */
export function paletteOf(mode: ThemeMode): Palette {
  return mode === 'terminal' ? TERMINAL_PALETTE : OTHEATER_PALETTE;
}
