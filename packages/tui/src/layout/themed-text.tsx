// SPDX-License-Identifier: MPL-2.0
import { Text as InkText, type TextProps as InkTextProps } from 'ink';
import { createContext, useContext, type ReactNode } from 'react';
import { useTheme } from './theme-context.js';

/** `true` inside a `Text`: a nested text takes the colour of its parent, so it gets no default one. */
const InsideText = createContext(false);

export interface TextProps extends InkTextProps {
  /** The hint of a key (`otheater` paints it with the colour of the hints and not with the one of `dim`). */
  readonly hint?: boolean | undefined;
  /** The row under the cursor of a list: inverse in `terminal`, the background of the selection in `otheater`. */
  readonly selection?: boolean | undefined;
  /** The cursor of a text box: inverse in `terminal`, a light block in `otheater`. */
  readonly caret?: boolean | undefined;
}

/**
 * Ink's `Text` with the theme (`ui.theme`) applied: a colour that is a role (`TOKEN.warn`) becomes
 * the colour of the theme, and in `otheater` `dimColor` is the colour of `dim` and not the SGR `dim`
 * (a dim colour that has its own colour is the faded one of the seven-day bars). In `terminal`
 * nothing changes: the roles are the named colours and `dimColor` is the SGR `dim`.
 */
export function Text(props: TextProps): ReactNode {
  const palette = useTheme();
  const inside = useContext(InsideText);
  const { hint, selection, caret, color, backgroundColor, dimColor, bold, inverse, ...rest } =
    props;
  let foreground = palette.resolve(color);
  let background = palette.resolve(backgroundColor);
  let dim = dimColor;
  let invert = inverse;
  if (palette.paintsDim) {
    if (dimColor === true) {
      foreground =
        foreground === undefined
          ? palette.token(hint === true ? 'hint' : 'dim')
          : palette.fade(foreground);
      dim = false;
    }
    if (selection === true) {
      background = palette.token('selected');
      foreground ??= palette.token('selectedText');
    }
    if (caret === true) {
      background = palette.token('caret');
      foreground = palette.token('caretText');
    }
    if (foreground === undefined && !inside) {
      // The text of the screen, so that what the terminal draws in its own foreground is not the
      // only thing outside the palette. A nested text keeps the colour of its parent.
      foreground =
        background === palette.token('selected')
          ? palette.token('selectedText')
          : palette.token(bold === true ? 'strong' : 'text');
    }
  } else if (selection === true || caret === true) {
    invert = true;
  }
  const style: InkTextProps = {
    ...rest,
    ...(foreground === undefined ? {} : { color: foreground }),
    ...(background === undefined ? {} : { backgroundColor: background }),
    ...(dim === undefined ? {} : { dimColor: dim }),
    ...(bold === undefined ? {} : { bold }),
    ...(invert === undefined ? {} : { inverse: invert }),
  };
  return (
    <InsideText.Provider value={true}>
      <InkText {...style} />
    </InsideText.Provider>
  );
}
