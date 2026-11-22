// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { isRemote, type ClipboardEnvironment } from './mouse/clipboard.js';

/**
 * Opening an address in the browser of the system (the sign-in panel of the tab Settings,
 * `ui.login.browser`). The command is the one the system offers for it: `xdg-open` on Linux,
 * `open` on macOS and, on Windows, `rundll32 url.dll,FileProtocolHandler` [proposta]. The address
 * is always one argument of the program and never goes through a shell. On Windows that is why
 * `cmd /c start "" <url>` was not taken: `cmd` reads the command line itself, so an `&` of a query
 * string (every OAuth address has them) would end the command, and the escape of `&`, `^` and `%`
 * for it is not something to trust on an address that came from a client. `rundll32` gets the line
 * as it is.
 */

export type OpenOutcome =
  | { readonly ok: true; readonly command: string }
  | {
      readonly ok: false;
      readonly reason: 'bad_url' | 'remote' | 'failed';
      readonly command?: string;
    };

export interface OpenCommand {
  readonly command: string;
  readonly args: readonly string[];
}

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\s\x00-\x1f\x7f-\x9f"]/;

/**
 * The address as it is when it is one the browser may be given: `http:` or `https:` with a host,
 * with no space, control character or quote (the last would end the argument on Windows). Anything
 * else is `undefined`: another scheme (`file:`, `javascript:`, an app handler) is never opened, and
 * an address with a control character is a terminal escape in disguise.
 */
export function webUrl(address: string): string | undefined {
  if (address === '' || UNSAFE_CHARS.test(address)) return undefined;
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.hostname === '') return undefined;
    return address;
  } catch {
    return undefined;
  }
}

/** The program and arguments that open `url` on `platform`; `url` must be the result of {@link webUrl}. */
export function openCommand(url: string, platform: NodeJS.Platform): OpenCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/** The side effects of opening, so a test runs it with none (and never opens a browser). */
export interface OpenPorts {
  /** Runs the command; resolves `true` when it started and did not end with a failure. */
  readonly run: (command: OpenCommand) => Promise<boolean>;
  readonly environment: ClipboardEnvironment;
}

/** How long a launcher that stays alive is waited for: it started, which is all that is asked. */
const LAUNCH_WAIT_MS = 3000;

/** Starts the command with no terminal and no shell; a missing program or a failure resolves `false`. */
export function runOpenCommand(command: OpenCommand): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(ok);
    };
    try {
      const child = spawn(command.command, [...command.args], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.once('error', () => {
        done(false);
      });
      child.once('close', (code) => {
        done(code === 0);
      });
      timer = setTimeout(() => {
        done(true);
      }, LAUNCH_WAIT_MS);
      child.unref();
    } catch {
      done(false);
    }
  });
}

/** Opens `address` in the browser of this machine; over SSH it does not (the browser would open on the other one). */
export async function openUrl(address: string, ports: OpenPorts): Promise<OpenOutcome> {
  const url = webUrl(address);
  if (url === undefined) return { ok: false, reason: 'bad_url' };
  if (isRemote(ports.environment)) return { ok: false, reason: 'remote' };
  const command = openCommand(url, ports.environment.platform);
  const ok = await ports.run(command).catch(() => false);
  return ok
    ? { ok: true, command: command.command }
    : { ok: false, reason: 'failed', command: command.command };
}

/**
 * The address as a hyperlink of the terminal (OSC 8: `ESC ] 8 ; params ; url ESC \ text ESC ] 8 ; ; ESC \`).
 * The same `id` ties the pieces of one address that sits on several rows into one link. An address
 * that {@link webUrl} does not accept is not made a link: its text goes as it is.
 */
export function hyperlink(text: string, url: string, id: string): string {
  if (webUrl(url) === undefined) return text;
  return `\x1b]8;id=${id};${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
