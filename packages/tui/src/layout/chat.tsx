// SPDX-License-Identifier: MPL-2.0
import { Box, Text, type DOMElement } from 'ink';
import { useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMouseTarget, type DragInfo } from '../mouse/index.js';
import { Frame } from './frame.js';
import { ScrollList, type ListLine } from './scroll-list.js';
import { breakLine, wrapText } from './text.js';
import { COLOR } from './theme.js';

/** A line under the output of a command: how it ended, what was left out, what became of it. */
export interface ChatTerminalNote {
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'error' | 'dim';
}

/**
 * A `!` command as a block (P18): the command, its output as the `terminal_snippet` holds it and a
 * few notes. `ChatMessage.text` has the same things as plain text, for what is not drawn as a block.
 */
export interface ChatTerminal {
  readonly header: string;
  readonly output: readonly string[];
  readonly notes: readonly ChatTerminalNote[];
}

/** One message of the chat as the layout draws it; `chat/lines.ts` makes them from the chat state. */
export interface ChatMessage {
  readonly id: string;
  readonly who: 'you' | 'director' | 'system';
  /** `09:12`. */
  readonly at: string;
  readonly text: string;
  /** The message is a `!` command: drawn as a block, not as wrapped text. */
  readonly terminal?: ChatTerminal | undefined;
}

export interface ChatProps {
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  /** The border has the focus (Tab, then the arrows). */
  readonly edgeFocused: boolean;
  /** The handle of the border is drawn: there is a panel beside the chat. */
  readonly resizable: boolean;
  /** Bottom label of the frame (`◂ 56 col ▸ ^←/^→`), when the width can be changed. */
  readonly widthLabel: string | undefined;
  readonly title: string;
  readonly stateLine: string;
  readonly messages: readonly ChatMessage[];
  readonly offset: number;
  readonly onOffset: (offset: number) => void;
  /** The border is dragged with the mouse (N34): the same width action as the keys of the border. */
  readonly onResizeDrag?: ((drag: DragInfo) => void) | undefined;
  /** The chat is pressed with the mouse: it takes the focus. */
  readonly onFocus?: (() => void) | undefined;
  readonly input: ReactNode;
  /** Rows the input region takes (the text box, the decision card, the suggestions). */
  readonly inputRows?: number | undefined;
}

/** Rows of the input region when nothing is open: the text box of one line, and its status line. */
export const INPUT_ROWS = 2;

const NOTE_COLOR: Readonly<Record<ChatTerminalNote['tone'], string | undefined>> = {
  ok: COLOR.ok,
  warn: COLOR.warn,
  error: COLOR.error,
  dim: undefined,
};

/** The rows of a `!` command: its line, the output behind a bar, then the notes. */
export function terminalLines(terminal: ChatTerminal, width: number): readonly ListLine[] {
  const bar = '│ ';
  const room = Math.max(1, width - bar.length);
  return [
    ...wrapText(terminal.header, width).map((text) => ({ text, bold: true, color: COLOR.accent })),
    ...terminal.output.flatMap((line) =>
      breakLine(line, room).map((text) => ({ text: `${bar}${text}` })),
    ),
    ...terminal.notes.flatMap((note) =>
      wrapText(note.text, width).map((text) => ({
        text,
        color: NOTE_COLOR[note.tone],
        dim: note.tone === 'dim',
      })),
    ),
  ];
}

const WHO_COLOR: Readonly<Record<ChatMessage['who'], string>> = {
  you: 'cyanBright',
  director: COLOR.accent,
  system: 'magenta',
};

/** Rows left to the messages in a chat of `height` rows. */
export function chatMessageRows(height: number, inputRows: number = INPUT_ROWS): number {
  return Math.max(0, height - 6 - inputRows);
}

/** The chat in full height: title, state, the messages (a window over the list), and the input. */
export function Chat(props: ChatProps): ReactNode {
  const { t } = useTranslation();
  const inner = Math.max(1, props.width - 2);
  const rows = chatMessageRows(props.height, props.inputRows);
  const { messages } = props;
  const lines = useMemo(
    () =>
      (index: number, width: number): readonly ListLine[] => {
        const message = messages[index];
        if (message === undefined) return [{ text: '' }];
        return [
          {
            text: `${t(`layout.chat.who.${message.who}`)} · ${message.at}`,
            color: WHO_COLOR[message.who],
            bold: true,
          },
          ...(message.terminal === undefined
            ? wrapText(message.text, width).map((text) => ({ text }))
            : terminalLines(message.terminal, width)),
          { text: '' },
        ];
      },
    [messages, t],
  );
  // The right border is what the mouse drags to widen or narrow the chat.
  const edgeRef = useRef<DOMElement>(null);
  useMouseTarget(
    edgeRef,
    { onDrag: props.onResizeDrag },
    { enabled: props.resizable && props.onResizeDrag !== undefined },
  );
  const handleRows = Math.min(6, Math.max(0, props.height - 2));
  return (
    <Frame
      width={props.width}
      height={props.height}
      active={props.focused}
      title={t('layout.chat.title')}
      bottomLabel={props.widthLabel}
      edgeRef={edgeRef}
      onPress={props.onFocus}
      handle={
        props.resizable
          ? {
              from: Math.max(0, Math.floor((props.height - 2 - handleRows) / 2)),
              rows: handleRows,
              active: props.edgeFocused,
            }
          : undefined
      }
    >
      <Text bold wrap="truncate">
        {props.title}
      </Text>
      <Text dimColor wrap="truncate">
        {props.stateLine}
      </Text>
      <Text dimColor>{'─'.repeat(inner)}</Text>
      {messages.length === 0 ? (
        <Box height={rows} flexDirection="column">
          <Text dimColor wrap="truncate">
            {t('layout.chat.empty')}
          </Text>
        </Box>
      ) : (
        <ScrollList
          count={messages.length}
          width={inner}
          height={rows}
          offset={props.offset}
          lines={lines}
          onOffset={props.onOffset}
        />
      )}
      <Text dimColor>{'─'.repeat(inner)}</Text>
      {props.input}
    </Frame>
  );
}
