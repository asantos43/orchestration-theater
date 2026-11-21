// SPDX-License-Identifier: MPL-2.0
import { render, type Instance } from 'ink';
import type { Resource } from 'i18next';
import type { ReactNode } from 'react';
import { App } from './app.js';
import type { DaemonConnector } from './daemon-connection.js';
import type { InkPatchOutcome } from './ink-patch.js';
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
      flush={flush}
    />
  );
  const running: Instance = render(tree, {
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: settings.render.maxFps,
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  });

  let exitCode = 0;
  const unmount = (): void => {
    running.unmount();
  };
  const removeGuards =
    options.process === undefined
      ? () => undefined
      : installExitGuards(options.process, {
          onSignal: (signal: ExitSignal) => {
            exitCode = SIGNAL_EXIT_CODES[signal];
            unmount();
          },
          onFatal: (error: unknown) => {
            exitCode = 1;
            unmount();
            options.stderr.write(`${i18n.t('app.crash', { message: messageOf(error) })}\n`);
          },
        });

  const done = running.waitUntilExit().then(
    () => exitCode,
    (error: unknown) => {
      // An error in a component: Ink already unmounted (and left the alternate screen).
      options.stderr.write(`${i18n.t('app.crash', { message: messageOf(error) })}\n`);
      return 1;
    },
  );
  const finished = done.finally(() => {
    removeGuards();
  });
  return { done: finished, locale, stop: unmount };
}
