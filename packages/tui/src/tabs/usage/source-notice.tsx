// SPDX-License-Identifier: MPL-2.0
import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fit } from '../../layout/text.js';
import { COLOR } from '../../layout/theme.js';
import type { SourceLoad } from './use-panels.js';

/** The value a section draws: what was read, or what it read before when the last read failed. */
export function shownOf<T>(
  load: SourceLoad<T>,
): { readonly value: T; readonly at: number } | undefined {
  return load.status === 'ready' ? load : load.status === 'error' ? load.kept : undefined;
}

/**
 * The line a panel shows when its source has no answer to draw, or failed after one: the reading in
 * progress, or why the read failed (the same codes as the totals of the tab). Nothing when the
 * source is ready, so a section draws it above its figures.
 */
export function SourceNotice(props: {
  readonly load: SourceLoad<unknown>;
  readonly width: number;
}): ReactNode {
  const { t } = useTranslation();
  const { load, width } = props;
  if (load.status === 'loading') {
    return (
      <Text dimColor wrap="truncate">
        {t('usage.loading')}
      </Text>
    );
  }
  if (load.status === 'error') {
    return (
      <Text color={COLOR.error} wrap="truncate">
        {fit(
          t(`usage.failed.${load.code}`, {
            defaultValue: t('usage.failed.other', { code: load.code }),
          }),
          width,
        )}
      </Text>
    );
  }
  return null;
}
