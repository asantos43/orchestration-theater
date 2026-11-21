// SPDX-License-Identifier: MPL-2.0
import { Box, Text } from 'ink';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Frame } from './frame.js';
import { INPUT_ROWS } from './input-slot.js';
import { ScrollList, type ListLine } from './scroll-list.js';
import { wrapText } from './text.js';
import { COLOR } from './theme.js';

/**
 * One message of the chat as the layout draws it. [proposta] Provisional: P12 feeds the chat from
 * the daemon (`/v1/chat`); until then the app takes the messages as a prop, so the layout, the
 * scroll and the tests are about the same list the chat will be.
 */
export interface ChatMessage {
  readonly id: string;
  readonly who: 'you' | 'director' | 'system';
  /** `09:12`. */
  readonly at: string;
  readonly text: string;
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
  readonly input: ReactNode;
}

const WHO_COLOR: Readonly<Record<ChatMessage['who'], string>> = {
  you: 'cyanBright',
  director: COLOR.accent,
  system: 'magenta',
};

/** Rows left to the messages in a chat of `height` rows. */
export function chatMessageRows(height: number): number {
  return Math.max(0, height - 6 - INPUT_ROWS);
}

/** The chat in full height: title, state, the messages (a window over the list), and the input. */
export function Chat(props: ChatProps): ReactNode {
  const { t } = useTranslation();
  const inner = Math.max(1, props.width - 2);
  const rows = chatMessageRows(props.height);
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
          ...wrapText(message.text, width).map((text) => ({ text })),
          { text: '' },
        ];
      },
    [messages, t],
  );
  const handleRows = Math.min(6, Math.max(0, props.height - 2));
  return (
    <Frame
      width={props.width}
      height={props.height}
      active={props.focused}
      title={t('layout.chat.title')}
      bottomLabel={props.widthLabel}
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
