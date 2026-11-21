// SPDX-License-Identifier: MPL-2.0
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useMemo, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { i18n as I18nInstance } from 'i18next';
import type { DaemonConnector } from './daemon-connection.js';
import { SUPPORTED_INK_VERSION, type InkPatchOutcome } from './ink-patch.js';
import type { LocaleController } from './locale.js';
import { RenderControlProvider, useRenderControl, type RenderControl } from './render-control.js';
import type { UiSettings } from './settings.js';
import { StatusScreen } from './status-screen.js';
import { useDaemon } from './use-daemon.js';

export interface AppProps {
  readonly connector: DaemonConnector;
  readonly i18n: I18nInstance;
  readonly locale: LocaleController;
  readonly settings: UiSettings;
  /** What happened to the patches of Ink, to warn about a refusal nobody asked for. */
  readonly patch?: InkPatchOutcome | undefined;
  /** Makes Ink paint the frame at once (`ui.render.keyRender: flush`). */
  readonly flush?: (() => void) | undefined;
}

/** Ctrl+Q quits. Ctrl+C is the terminal's: Ink is told not to exit on it, so it quits here too. */
function useQuitKeys(): void {
  const { exit } = useApp();
  const { afterKey } = useRenderControl();
  useInput((input, key) => {
    if (key.ctrl && (input === 'q' || input === 'c')) {
      exit();
      return;
    }
    afterKey();
  });
}

function patchWarning(patch: InkPatchOutcome | undefined): string | undefined {
  if (patch === undefined || patch.applied) return undefined;
  switch (patch.reason) {
    case 'version_mismatch':
    case 'ink_not_found':
    case 'hook_unavailable':
      return `app.patch.${patch.reason}`;
    case 'disabled':
      return undefined;
  }
}

function Screen(props: AppProps): ReactNode {
  const { t } = useTranslation();
  const { columns, rows } = useWindowSize();
  const { locale: controller, connector } = props;
  useQuitKeys();
  const onSettings = useCallback(
    (settings: UiSettings): void => {
      void controller.apply(settings.locale);
    },
    [controller],
  );
  const view = useDaemon(connector, { onSettings });
  const warning = patchWarning(props.patch);
  return (
    <Box flexDirection="column" width={columns} height={rows} borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        {t('app.title')}
      </Text>
      <StatusScreen view={view} />
      {warning !== undefined && (
        <Box marginTop={1}>
          <Text color="yellow">
            {t(warning, { version: props.patch?.version ?? '?', supported: SUPPORTED_INK_VERSION })}
          </Text>
        </Box>
      )}
      <Box flexGrow={1} />
      <Text dimColor>{t('app.quit_hint')}</Text>
    </Box>
  );
}

/** The root of the TUI: providers and the screen. */
export function App(props: AppProps): ReactNode {
  const { render } = props.settings;
  const control = useMemo<RenderControl>(
    () => ({
      memo: render.memo,
      afterKey: () => {
        if (render.keyRender === 'flush') props.flush?.();
      },
    }),
    [render.memo, render.keyRender, props.flush],
  );
  return (
    <I18nextProvider i18n={props.i18n}>
      <RenderControlProvider value={control}>
        <Screen {...props} />
      </RenderControlProvider>
    </I18nextProvider>
  );
}
