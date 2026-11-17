// SPDX-License-Identifier: MPL-2.0
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { AdapterUnavailable, type LaunchedProcess, type ProcessLauncher } from '@otheater/core';
import { chromium } from 'playwright-core';

/**
 * The command that downloads the Chromium this adapter drives. The adapter never runs it (the
 * daemon downloads nothing on its own); the message of a missing browser names it, and CI runs it
 * (N95). `playwright-core` is the only package of Playwright the project approved (N93).
 */
export const CHROMIUM_INSTALL_COMMAND = 'npx playwright-core@1.64.1 install chromium';

/**
 * Flags of the Chromium the daemon starts (architecture 5.19). [V] with Chromium 1248.
 * - `--headless=new` and `--remote-debugging-port=0`: no window; the port is chosen by Chromium and
 *   read from its stderr, so two browsers never fight for one.
 * - `--password-store=basic`: Chromium never talks to the desktop keyring (Secret Service).
 * - the rest turns off what a browser of a daemon has no use for (sync, extensions, default-app
 *   prompts, background networking) so it neither phones home nor waits on a first-run dialog.
 */
export const CHROMIUM_ARGS: readonly string[] = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--disable-extensions',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-background-networking',
  '--disable-component-update',
  '--mute-audio',
];

const WS_LINE = /DevTools listening on (ws:\/\/\S+)/;
/** How much of the end of stderr is kept for the message of a launch that failed. */
const STDERR_TAIL_BYTES = 4096;

/** The Chromium to run: the configured path, or the one `playwright-core` expects for its revision. */
export function chromiumPath(configured: string | undefined): string {
  return configured ?? chromium.executablePath();
}

/** Rejects with `AdapterUnavailable` (and the way to fix it) when there is no executable at `path`. */
export async function assertChromiumInstalled(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch (cause) {
    throw new AdapterUnavailable(
      `Chromium was not found at "${path}". Download it with \`${CHROMIUM_INSTALL_COMMAND}\` or set browser.executable_path.`,
      { cause },
    );
  }
}

/** What {@link launchChromium} needs. */
export interface ChromiumLaunchOptions {
  readonly executablePath: string;
  /** The profile (`--user-data-dir`): cookies and storage live here. */
  readonly userDataDir: string;
  /** `HOME` of the browser: a private directory, so it reads nothing of the user's own. */
  readonly homeDir: string;
  /** False adds `--no-sandbox`: only for a machine where the sandbox cannot start (a container). */
  readonly sandbox: boolean;
  readonly launchTimeoutMs: number;
  /** Absolute directory the process starts in. */
  readonly cwd: string;
  readonly memoryLimitBytes?: number | undefined;
}

/** A Chromium under the launcher whose DevTools endpoint is known. */
export interface RunningChromium {
  readonly process: LaunchedProcess;
  readonly wsUrl: string;
}

/**
 * The environment of the browser: the COMPLETE one (the launcher gives the child nothing else).
 * Only `PATH` and the locale come from the daemon; the daemon's secrets never reach the browser.
 */
export function chromiumEnv(homeDir: string, source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {
    HOME: homeDir,
    XDG_CONFIG_HOME: `${homeDir}/.config`,
    XDG_CACHE_HOME: `${homeDir}/.cache`,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
  };
  for (const name of ['PATH', 'LANG', 'LC_ALL']) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Starts Chromium under the process launcher (5.9) and waits for its DevTools endpoint, which it
 * prints on stderr. Both output streams are drained for as long as the process lives (a full pipe
 * would stop the browser). Rejects with `AdapterUnavailable` when the process cannot start, exits
 * before it announces the endpoint, or does not announce it within `launchTimeoutMs`; the tree is
 * ended in each case.
 */
export async function launchChromium(
  launcher: ProcessLauncher,
  options: ChromiumLaunchOptions,
  source: NodeJS.ProcessEnv = process.env,
): Promise<RunningChromium> {
  const args = [
    ...CHROMIUM_ARGS,
    `--user-data-dir=${options.userDataDir}`,
    ...(options.sandbox ? [] : ['--no-sandbox']),
    'about:blank',
  ];
  const child = await launcher.launch({
    cmd: options.executablePath,
    args,
    cwd: options.cwd,
    env: chromiumEnv(options.homeDir, source),
    ...(options.memoryLimitBytes === undefined
      ? {}
      : { memoryLimitBytes: options.memoryLimitBytes }),
  });
  void child.stdout.pipeTo(new WritableStream()).catch(() => undefined);

  let tail = '';
  const announced = new Promise<string>((resolve, reject) => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let found = false;
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail = (tail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_BYTES);
        if (!found) {
          const match = WS_LINE.exec(tail);
          if (match?.[1] !== undefined) {
            found = true;
            resolve(match[1]);
          }
        }
      }
      if (!found) reject(new Error('stderr ended before the DevTools endpoint'));
    })().catch((error: unknown) => {
      if (!found) reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      announced.then((wsUrl) => ({ process: child, wsUrl })),
      child.exited.then((exit) => {
        throw new Error(
          `Chromium exited (code ${String(exit.code)}, signal ${String(exit.signal)})`,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no DevTools endpoint within ${String(options.launchTimeoutMs)} ms`));
        }, options.launchTimeoutMs);
      }),
    ]);
  } catch (cause) {
    await child.killTree({ graceMs: 1000 }).catch(() => undefined);
    const detail = tail.trim().split('\n').slice(-3).join(' | ');
    const base = cause instanceof Error ? cause.message : String(cause);
    throw new AdapterUnavailable(
      `Chromium did not start: ${base}${detail === '' ? '' : ` (stderr: ${detail})`}.`,
      { cause },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
