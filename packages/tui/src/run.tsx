// SPDX-License-Identifier: MPL-2.0
import { render, type Instance } from 'ink';
import type { Resource } from 'i18next';
import type { ReactNode } from 'react';
import { App } from './app.js';
import type { DaemonConnector } from './daemon-connection.js';
import type { InkPatchOutcome } from './ink-patch.js';
import type { HistoryStore } from './input/index.js';
import { kittyKeyboardOption } from './keyboard.js';
import { MOUSE_DISABLE_SEQUENCE } from './mouse/modes.js';
import {
  LocaleController,
  createTuiI18n,
  loadTuiCatalogs,
  resolveLocale,
  type SystemLocaleEnv,
} from './locale.js';
import type { UiSettings } from './settings.js';
import {
  SIGNAL_EXIT_CODES,
  installExitGuards,
  isTerminalGone,
  type ExitSignal,
  type ProcessHost,
} from './terminal.js';

export interface RunTuiOptions {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly connector: DaemonConnector;
  readonly settings: UiSettings;
  readonly patch?: InkPatchOutcome | undefined;
  /** The history of the text box (P12). */
  readonly history?: HistoryStore | undefined;
  readonly process?: ProcessHost | undefined;
  readonly env?: SystemLocaleEnv | undefined;
  readonly catalogs?: Resource | undefined;
  /** Forces Ink's interactive mode (it is detected from `stdout.isTTY` and the CI variable). For tests. */
  readonly interactive?: boolean | undefined;
}

/** What a running TUI lets the caller do. */
export interface RunningTui {
  /** Resolves with the exit code once the terminal is back as it was. */
  readonly done: Promise<number>;
  readonly locale: LocaleController;
  /** Unmounts the app, as if the person pressed Ctrl+Q. */
  stop(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shows the TUI on the alternate screen until it ends, and gives the terminal back in every way it
 * can end: Ctrl+Q, a signal, an error in a component or an error nobody caught. Ink does the
 * restoring (it leaves the alternate screen and shows the cursor when it unmounts); this function
 * makes sure every one of those ways unmounts it.
 */
export async function startTuiApp(options: RunTuiOptions): Promise<RunningTui> {
  const { settings } = options;
  const resources = options.catalogs ?? loadTuiCatalogs();
  const env = options.env ?? process.env;
  const i18n = await createTuiI18n(resolveLocale(settings.locale, env), resources);
  const locale = new LocaleController(i18n, settings.locale, env);

  const flush = (): void => {
    void running.waitUntilRenderFlush();
  };
  const tree: ReactNode = (
    <App
      connector={options.connector}
      i18n={i18n}
      locale={locale}
      settings={settings}
      patch={options.patch}
      history={options.history}
      flush={flush}
      mouseTerminal={options.stdout}
    />
  );
  const kittyKeyboard = kittyKeyboardOption(settings.keyboard.protocol);
  const running: Instance = render(tree, {
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: settings.render.maxFps,
    ...(kittyKeyboard === undefined ? {} : { kittyKeyboard }),
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  });

  const reportCrash = (error: unknown): void => {
    try {
      options.stderr.write(`${i18n.t('app.crash', { message: messageOf(error) })}\n`);
    } catch {
      // The terminal went away in the meantime: the message has nowhere to go.
    }
  };
  let exitCode = 0;
  const unmount = (): void => {
    running.unmount();
  };
  // The terminal is gone (the window closed, the connection dropped): there is nothing to give back
  // and nowhere to report. The app is unmounted once, with the code of a hang-up, and no more is
  // written: a write to a terminal that is gone fails, and an error nobody catches would start the
  // whole thing again.
  let terminalGone = false;
  const onTerminalGone = (): void => {
    if (terminalGone) return;
    terminalGone = true;
    exitCode = SIGNAL_EXIT_CODES.SIGHUP;
    try {
      unmount();
    } catch {
      // Ink wrote its last frames to the terminal that is gone.
    }
  };
  const onFatal = (error: unknown): void => {
    if (isTerminalGone(error)) {
      onTerminalGone();
      return;
    }
    exitCode = 1;
    unmount();
    reportCrash(error);
  };
  // The errors of the streams of the terminal would be uncaught exceptions without a listener.
  const terminalStreams = [options.stdin, options.stdout, options.stderr];
  const onStreamError = (error: Error): void => {
    onFatal(error);
  };
  for (const stream of terminalStreams) stream.on('error', onStreamError);
  const removeGuards =
    options.process === undefined
      ? () => undefined
      : installExitGuards(options.process, {
          onSignal: (signal: ExitSignal) => {
            exitCode = SIGNAL_EXIT_CODES[signal];
            unmount();
          },
          onFatal,
          onTerminalGone,
        });

  const done = running.waitUntilExit().then(
    () => exitCode,
    (error: unknown) => {
      // An error in a component: Ink already unmounted (and left the alternate screen).
      reportCrash(error);
      return 1;
    },
  );
  const finished = done.finally(() => {
    // However it ended, the terminal does not keep the mouse reports on (N34).
    if (settings.mouse !== 'off' && !terminalGone) {
      try {
        options.stdout.write(MOUSE_DISABLE_SEQUENCE);
      } catch {
        // The terminal is gone: the mouse reports went with it.
      }
    }
    removeGuards();
    for (const stream of terminalStreams) stream.off('error', onStreamError);
  });
  return { done: finished, locale, stop: unmount };
}
