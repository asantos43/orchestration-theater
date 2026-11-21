// SPDX-License-Identifier: MPL-2.0
import type { UiTranslate } from '@otheater/client';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** The `t` of the screen in the shape the derivations of the client ask for. */
export function useUiTranslate(): UiTranslate {
  const { t } = useTranslation();
  return useMemo(
    (): UiTranslate =>
      (key, params) =>
        params === undefined ? t(key) : t(key, params),
    [t],
  );
}
