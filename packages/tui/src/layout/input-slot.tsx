// SPDX-License-Identifier: MPL-2.0
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The line where the person types to the Director. [proposta] Provisional: P12 replaces it with the
 * text box of P10 (`packages/tui/src/input/`), which grows to more than one line. It takes the
 * slot's height (`INPUT_ROWS`) so the chat is laid out for a box that is one line tall.
 */
export const INPUT_ROWS = 2;

export function InputSlot(props: { readonly width: number }): ReactNode {
  const { t } = useTranslation();
  return (
    <Box flexDirection="column" width={props.width}>
      <Text wrap="truncate">
        <Text bold color="blueBright">
          {'› '}
        </Text>
        <Text dimColor>{t('layout.chat.placeholder')}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {t('layout.chat.inputHint')}
      </Text>
    </Box>
  );
}
