// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from 'node:events';
import { cleanup, render } from 'ink-testing-library';
import type { i18n as I18nInstance } from 'i18next';
import type { ReactNode } from 'react';
import { App } from './app.js';
import type { ChatPanelConfig } from './chat/use-chat-panel.js';
import type { TabContentMap } from './layout/tab-content.js';
import type { KeyEnvironment } from './keys/use-keymap.js';
import type { ConnectResult, DaemonConnector } from './daemon-connection.js';
import type { InkPatchOutcome } from './ink-patch.js';
import type { MouseLayerProps } from './mouse/index.js';
import {
  LocaleController,
  createTuiI18n,
  loadTuiCatalogs,
  resolveLocale,
  type SystemLocaleEnv,
} from './locale.js';
import { DEFAULT_UI_SETTINGS, type LocaleSetting, type UiSettings } from './settings.js';
import type { SetupApi } from './setup/index.js';

/**
 * What the tests of the TUI share: a helper that writes keys and reads frames over
 * `ink-testing-library`, and a terminal that records what is written to it (N57: nothing real runs).
 */

/** The bytes of the keys the app listens for. */
export const KEYS = {
  ctrlQ: '\x11',
  ctrlC: '\x03',
  enter: '\r',
  escape: '\x1b',
} as const;

/** `text` without the terminal's color and cursor sequences. */
export function plain(text: string): string {
  // The colors and cursor moves (CSI) and the hyperlinks (OSC 8, ended by ST or BEL).
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

/** Waits (in real time, in short steps) until `read` gives a value, or fails with `what`. */
export async function waitFor<T>(
  read: () => T | undefined | false,
  what: string,
  timeoutMs = 4000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** A connector that always gives `result` (a daemon that is not there, a failure...). */
export function fixedConnector(result: ConnectResult): DaemonConnector {
  return { connect: () => Promise.resolve(result) };
}

export interface RenderedApp {
  readonly i18n: I18nInstance;
  readonly locale: LocaleController;
  /** The last frame, without color. */
  frame(): string;
  /** The last frame as Ink wrote it, with its colors and hyperlinks. */
  rawFrame(): string;
  /** Writes keys to the app, as the terminal would. */
  press(keys: string): void;
  /** Resizes the terminal and waits for the app to see it. */
  resize(columns: number, rows: number): void;
  /** Waits for the frame to contain the text, and for the effects of that frame (the key listeners) to run. */
  waitForText(text: string | RegExp): Promise<string>;
  /** Lets the pending renders and effects run, then returns the frame. */
  settle(): Promise<string>;
  /** How many times the app asked Ink to paint at once (`ui.render.keyRender: flush`). */
  readonly flushes: () => number;
  unmount(): void;
}

export interface RenderAppOptions {
  readonly connector: DaemonConnector;
  readonly settings?: UiSettings | undefined;
  readonly patch?: InkPatchOutcome | undefined;
  /** Ends up as `LANG` of the environment the locale is detected from. Default: English. */
  readonly systemLocale?: string | undefined;
  /** The size of the terminal (the test stdout has 100 columns and no rows). */
  readonly size?: { readonly columns: number; readonly rows: number } | undefined;
  /** How the chat opens its sockets, and where the history of the text box lives. */
  readonly chatSocket?: ChatPanelConfig['socket'];
  readonly history?: ChatPanelConfig['history'];
  readonly tabContent?: TabContentMap | undefined;
  /** The routes of the setup assistant (P17); default: the ones of the connected client. */
  readonly setupApi?: SetupApi | undefined;
  /** The system the keymap adapts to. Default: Linux with no terminal variables, on every OS. */
  readonly keyEnvironment?: KeyEnvironment | undefined;
  /**
   * Turns the mouse layer on: what it writes to the terminal (the mode sequences and the OSC 52
   * copy) goes to this list. Without it the layer does nothing, as in the tests that ignore it.
   */
  readonly mouseWrites?: string[] | undefined;
  /** The ports of the copy; the test one is Linux with no tool and no tmux, so only OSC 52 and `system` failing are reachable. */
  readonly mouseClipboard?: MouseLayerProps['clipboard'];
  /** The folder the TUI was opened in, where "new project" starts (P22). Default: the process's. */
  readonly cwd?: string | undefined;
}

/**
 * The settings the tests start from: the defaults, with the first-run assistant (P17) off. A real
 * daemon with no configuration says `firstRunNeeded`, which would take the screen of every test
 * that is not about the assistant; the tests that are about it ask for `open: 'auto'`. The sign-in
 * panel does not open the browser (`login.browser: off`): a test about that gives a fake opener.
 */
export const TEST_UI_SETTINGS: UiSettings = {
  ...DEFAULT_UI_SETTINGS,
  setup: { ...DEFAULT_UI_SETTINGS.setup, open: 'never' },
  // The sign-in panel would start the browser of the machine that runs the tests.
  login: { browser: 'off' },
};

/** The labels of the tests are the ones of Linux (`Alt+K`), whatever system runs them. */
const LINUX_KEYS: KeyEnvironment = { env: {}, platform: 'linux' };

/** A frame is on screen before its passive effects (the key listeners) have run. */
const SETTLE_MS = 20;

/** Mounts the app over `ink-testing-library`. */
export async function renderApp(options: RenderAppOptions): Promise<RenderedApp> {
  const settings = options.settings ?? TEST_UI_SETTINGS;
  const env: SystemLocaleEnv = { LANG: options.systemLocale ?? 'en_US.UTF-8' };
  const i18n = await createTuiI18n(resolveLocale(settings.locale, env), loadTuiCatalogs());
  const locale = new LocaleController(i18n, settings.locale, env);
  let flushes = 0;
  const tree: ReactNode = (
    <App
      connector={options.connector}
      i18n={i18n}
      locale={locale}
      settings={settings}
      patch={options.patch}
      chatSocket={options.chatSocket}
      history={options.history}
      tabContent={options.tabContent}
      setupApi={options.setupApi}
      keyEnvironment={options.keyEnvironment ?? LINUX_KEYS}
      cwd={options.cwd}
      mouseTerminal={
        options.mouseWrites === undefined
          ? undefined
          : { write: (text) => options.mouseWrites?.push(text) }
      }
      mouseClipboard={
        options.mouseClipboard ?? { environment: { platform: 'linux', env: {} }, tmux: false }
      }
      flush={() => {
        flushes += 1;
      }}
    />
  );
  const view = render(tree);
  const resize = (columns: number, rows: number): void => {
    Object.defineProperty(view.stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(view.stdout, 'rows', { value: rows, configurable: true });
    view.stdout.emit('resize');
  };
  if (options.size !== undefined) resize(options.size.columns, options.size.rows);
  const frame = (): string => plain(view.lastFrame() ?? '');
  return {
    i18n,
    locale,
    frame,
    rawFrame: () => view.lastFrame() ?? '',
    press: (keys) => {
      view.stdin.write(keys);
    },
    settle: async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return frame();
    },
    waitForText: async (text) => {
      await waitFor(
        () => {
          const current = frame();
          const found = typeof text === 'string' ? current.includes(text) : text.test(current);
          return found ? current : undefined;
        },
        `the text ${String(text)} (last frame: ${frame()})`,
      );
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return frame();
    },
    resize,
    flushes: () => flushes,
    unmount: () => {
      view.unmount();
    },
  };
}

/** Takes down every app mounted over `ink-testing-library`. Call it in `afterEach`. */
export function cleanupApps(): void {
  cleanup();
}

/** A standard input that is a terminal: what Ink asks of it to read keys. */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  #pending: string | null = null;
  setEncoding(): void {
    // Nothing to do.
  }
  setRawMode(): void {
    // Nothing to do.
  }
  resume(): void {
    // Nothing to do.
  }
  pause(): void {
    // Nothing to do.
  }
  ref(): void {
    // Nothing to do.
  }
  unref(): void {
    // Nothing to do.
  }
  read(): string | null {
    const data = this.#pending;
    this.#pending = null;
    return data;
  }
  /** Types `keys`. */
  write(keys: string): void {
    this.#pending = keys;
    this.emit('readable');
    this.emit('data', keys);
  }
}

/** A terminal that records every write: the escape sequences show how it was left. */
export class FakeTty extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  readonly writes: string[] = [];
  /** Like a stream: the callback says the chunk was handled (Ink waits for it when it exits). */
  write(chunk: string | Uint8Array, callback?: () => void): boolean {
    this.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (callback !== undefined) setImmediate(callback);
    return true;
  }
  /** All that was written, in one string. */
  get output(): string {
    return this.writes.join('');
  }
  /** True when `sequence` was written. */
  wrote(sequence: string): boolean {
    return this.output.includes(sequence);
  }
  /** The position of the last write of `sequence` (-1 when it was never written). */
  lastIndexOf(sequence: string): number {
    return this.output.lastIndexOf(sequence);
  }
}

/** Enter and leave the alternate screen, show and hide the cursor. */
export const TERMINAL = {
  alternateOn: '\x1b[?1049h',
  alternateOff: '\x1b[?1049l',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
} as const;

export type { LocaleSetting };
