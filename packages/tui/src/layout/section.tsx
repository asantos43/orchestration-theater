// SPDX-License-Identifier: MPL-2.0
import { Box, Text, type DOMElement } from 'ink';
import { useRef, type ReactNode } from 'react';
import { useMouseTarget } from '../mouse/index.js';
import { fit, fitRight } from './text.js';
import { COLOR, paint } from './theme.js';

/**
 * What a tab of the panel is given to fold its sections. `folded` is the set the `LayoutStore`
 * keeps (`collapsedSections`), `cursor` is the section the cursor is on while the panel has the
 * focus. Enter (`panel.activate`) folds or unfolds the one under the cursor.
 */
export interface SectionControl {
  readonly folded: ReadonlySet<string>;
  readonly cursor: string | undefined;
  /** A click on the header folds or unfolds the section (N34); without it the header is not clickable. */
  readonly toggle?: ((id: string) => void) | undefined;
}

export interface SectionProps {
  /** The id the `LayoutStore` keeps; it names the tab, so two tabs never share one (`overview.pipeline`). */
  readonly id: string;
  readonly title: string;
  /** Right side of the header (a count, a time). */
  readonly right?: string | undefined;
  readonly width: number;
  readonly control: SectionControl;
  readonly children?: ReactNode;
}

/** `▾ title ........ right` and, when it is not folded, its content. */
export function Section(props: SectionProps): ReactNode {
  const { id, width, control } = props;
  const folded = control.folded.has(id);
  const onCursor = control.cursor === id;
  const headRef = useRef<DOMElement>(null);
  useMouseTarget(
    headRef,
    {
      onClick: () => {
        control.toggle?.(id);
      },
    },
    { enabled: control.toggle !== undefined },
  );
  const rightText = props.right ?? '';
  const head = `${folded ? '▸' : '▾'} ${props.title}`;
  const line =
    rightText === ''
      ? fit(head, width)
      : `${fit(head, Math.max(1, width - rightText.length - 1))} ${fitRight(rightText, rightText.length)}`;
  return (
    <Box flexDirection="column" width={width}>
      <Box ref={headRef} width={width} height={1}>
        <Text
          bold
          inverse={onCursor}
          {...paint(onCursor ? COLOR.accent : undefined)}
          wrap="truncate"
        >
          {fit(line, width)}
        </Text>
      </Box>
      {!folded && props.children}
    </Box>
  );
}
