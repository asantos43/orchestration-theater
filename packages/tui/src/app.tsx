// SPDX-License-Identifier: MPL-2.0
import { Box, Text, useApp, useWindowSize } from 'ink';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { i18n as I18nInstance } from 'i18next';
import type { DaemonConnector } from './daemon-connection.js';
import { SUPPORTED_INK_VERSION, type InkPatchOutcome } from './ink-patch.js';
import {
  useRawKeys,
  useTuiKeymap,
  type KeyEnvironment,
  type TuiKeymap,
} from './keys/use-keymap.js';
import type { ChatPanelConfig } from './chat/use-chat-panel.js';
import { Shell } from './layout/shell.js';
import type { TabContentMap } from './layout/tab-content.js';
import { KeyFeedProvider } from './input/key-feed.js';
import type { LocaleController } from './locale.js';
import { MouseLayer, type MouseLayerProps, type MouseTerminal } from './mouse/index.js';
import { RenderControlProvider, useRenderControl, type RenderControl } from './render-control.js';
import type { SetupGate } from './layout/shell.js';
import type { UiSettings, UiSetupSettings } from './settings.js';
import type { SetupApi } from './setup/index.js';
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
  /** How the chat opens its sockets (tests give a fake `WebSocket` and fast retries). */
  readonly chatSocket?: ChatPanelConfig['socket'];
  /** Where the history of the text box lives; in memory when absent. */
  readonly history?: ChatPanelConfig['history'];
  /** What each tab of the panel draws; they come in empty and each step fills its own. */
  readonly tabContent?: TabContentMap | undefined;
  /** The routes of the setup assistant (P17); default: the ones of the daemon's client. For tests. */
  readonly setupApi?: SetupApi | undefined;
  /** The system the keymap adapts to; default: this process (`process.platform` and its env). */
  readonly keyEnvironment?: KeyEnvironment | undefined;
  /**
   * Where the mouse modes and the OSC 52 copy are written (the terminal of the TUI, N34/N36). With
   * none the mouse layer does nothing, which is what the tests that do not look at it want.
   */
  readonly mouseTerminal?: MouseTerminal | undefined;
  /** The ports of the copy (the tool of the system, the environment); the real ones by default. For tests. */
  readonly mouseClipboard?: MouseLayerProps['clipboard'];
}

/**
 * Quits from the screens that are not the layout (connecting, offline, failed): the key of
 * `app.quit` and Ctrl+C, which is the terminal's own (Ink is told not to exit on it).
 */
function useQuitKeys(keymap: TuiKeymap, isActive: boolean): void {
  const { exit } = useApp();
  const { afterKey } = useRenderControl();
  useRawKeys(
    (event) => {
      if (
        event.data === '\x03' ||
        (event.combo !== undefined && keymap.match(event.combo) === 'app.quit')
      ) {
        exit();
        return;
      }
      afterKey();
    },
    { isActive },
  );
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
  const keymap = useTuiKeymap(props.settings.keymap, props.keyEnvironment);
  // The `ui.setup` of the daemon, once read: the gate of the assistant (P17) waits for it, because
  // the settings of this process do not know what the configuration of the daemon says.
  // [proposta] When the read fails the gate goes on with the settings of this process.
  const [daemonSetup, setDaemonSetup] = useState<UiSetupSettings | undefined>(undefined);
  const onSettings = useCallback(
    (settings: UiSettings): void => {
      void controller.apply(settings.locale);
      setDaemonSetup(settings.setup);
    },
    [controller],
  );
  const onSettingsFailed = useCallback((): void => {
    setDaemonSetup(props.settings.setup);
  }, [props.settings.setup]);
  const view = useDaemon(connector, { onSettings, onSettingsFailed });
  // `never` here closes the gate without waiting; otherwise the daemon has the last word.
  const setupGate: SetupGate =
    props.settings.setup.open === 'never' ? props.settings.setup : (daemonSetup ?? 'pending');
  useQuitKeys(keymap, view.kind !== 'online');
  const warning = patchWarning(props.patch);
  if (view.kind === 'online') {
    return (
      <Shell
        stores={view.stores}
        client={view.client}
        settings={props.settings}
        layout={view.layout}
        address={view.address}
        tuning={props.settings.tuiLayout}
        keymap={keymap}
        chat={{
          client: view.client,
          socket: props.chatSocket,
          chat: props.settings.chat,
          input: props.settings.input,
          history: props.history,
        }}
        tabContent={props.tabContent}
        setupApi={props.setupApi}
        setupGate={setupGate}
      />
    );
  }
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
        <MouseLayer
          mode={props.settings.mouse}
          copy={props.settings.clipboardCopy}
          tuning={props.settings.tuiMouse}
          terminal={props.mouseTerminal}
          clipboard={props.mouseClipboard}
        >
          <KeyFeedProvider>
            <Screen {...props} />
          </KeyFeedProvider>
        </MouseLayer>
      </RenderControlProvider>
    </I18nextProvider>
  );
}
