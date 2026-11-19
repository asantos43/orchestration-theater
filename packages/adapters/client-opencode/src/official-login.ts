// SPDX-License-Identifier: MPL-2.0
// The same file lives in the three client adapters (`adapter-isolation` forbids sharing it and the
// core must not grow for it): keep the copies identical when one changes.
import {
  AdapterUnavailable,
  Cancelled,
  InvalidInput,
  PermissionDenied,
  type LaunchedProcess,
  type LoginFlow,
  type ProcessLauncher,
} from '@otheater/core';

/** A command of the client's own tool: what runs the official login, logout or status. */
export interface CommandSpec {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * The options of the official login of a client, one object under `clients.<id>.login`. The default
 * of each command comes from the help of the client (`--help`, read 2026-11-18) and is [proposta];
 * what each command prints and when it exits is [N]. Every field has more than one value.
 */
export interface LoginOptions extends LoginTiming {
  /** `clients.<id>.login.mode`: `browser`, `device_code` or `terminal`. Default depends on the client. */
  readonly mode?: LoginFlow['mode'];
  /** `clients.<id>.login.command`: the official login. */
  readonly command?: { readonly cmd: string; readonly args?: readonly string[] };
  /** `clients.<id>.login.logout_command`: the official logout. */
  readonly logoutCommand?: { readonly cmd: string; readonly args?: readonly string[] };
}

/** What the login probe found. `unknown` is a probe that could not tell; never a guess of `logged_in`. */
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';

/** Result of `probeLogin`: the state and the way it was read (never a token, never a credential file). */
export interface LoginProbeResult {
  readonly state: LoginState;
  /** `status_command`, `acp_session` or `account_list`. */
  readonly via: string;
}

/** The command of an option with its arguments filled in. */
export function commandOf(
  given: { readonly cmd: string; readonly args?: readonly string[] } | undefined,
  fallback: CommandSpec,
): CommandSpec {
  return given === undefined
    ? { cmd: fallback.cmd, args: [...fallback.args] }
    : { cmd: given.cmd, args: [...(given.args ?? [])] };
}

/** Where the login runs: the profile directory, with the environment that points the client at it. */
export interface LoginRun {
  readonly launcher: ProcessLauncher;
  readonly cwd: string;
  /** The COMPLETE environment of the process (`ProcessLauncher`), built from the profile. */
  readonly env: Readonly<Record<string, string>>;
}

/** Timing of an official login. [proposta] keys `clients.<id>.login.url_wait` and `.timeout`. */
export interface LoginTiming {
  /** How long `login()` waits for the client to print the URL or code before it hands the flow back anyway. Default 15 s. */
  readonly urlWaitMs?: number;
  /** How long the whole login may take before the client is ended. Default 10 min. */
  readonly timeoutMs?: number;
}

export const DEFAULT_URL_WAIT_MS = 15_000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** A status, logout or other short command that does not end in this time is ended. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** How much of the output is kept for the search of the URL and the code: the tail, never the whole. */
const OUTPUT_CAP = 16 * 1024;

// eslint-disable-next-line no-control-regex -- the escape character is what an ANSI sequence starts with
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/gu;
const URL_PATTERN = /https?:\/\/[^\s"'<>`\\]+/u;
/** A one-time device code: two groups of letters and digits, upper case. [N] shape, not confirmed in any client. */
const CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/u;

/** The first URL of `text`, without the punctuation that ends a sentence. */
export function firstUrl(text: string): string | undefined {
  const match = URL_PATTERN.exec(text.replaceAll(ANSI, ''));
  return match?.[0].replace(/[.,;:)\]}]+$/u, '');
}

const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/iu;

/** A URL on this machine (`localhost`, `127.0.0.1`, `[::1]`): the client's own callback server. */
export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_URL.test(url);
}

/**
 * The URL where the person signs in: the first URL of `text` that is not on this machine, else the
 * first URL. Codex prints its callback server (`Starting local login server on
 * http://localhost:1455`) before the sign-in URL [V: strings of the codex binary, 2026-11-19], and
 * opening the callback server signs nobody in.
 */
export function signInUrl(text: string): string | undefined {
  const plain = text.replaceAll(ANSI, '');
  let first: string | undefined;
  for (const match of plain.matchAll(new RegExp(URL_PATTERN, 'gu'))) {
    const url = match[0].replace(/[.,;:)\]}]+$/u, '');
    if (!isLoopbackUrl(url)) return url;
    first ??= url;
  }
  return first;
}

/** The first device code of `text`, looked for outside the URLs. */
export function firstCode(text: string): string | undefined {
  const plain = text.replaceAll(ANSI, '').replaceAll(new RegExp(URL_PATTERN, 'gu'), ' ');
  return CODE_PATTERN.exec(plain)?.[0];
}

/** Reads a stream to its end and hands each piece of text to `onText`; never rejects. */
async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onText(decoder.decode(value, { stream: true }));
    }
  } catch {
    // The stream broke with the process: whatever it said is all there is.
  }
}

/** How long the end of the output is waited for after the root process ended (a grandchild may hold the pipe). */
const DRAIN_MS = 500;

/** Ends what is left of the tree of an exited process and waits briefly for its output to end. */
async function drain(process: LaunchedProcess, pumps: Promise<unknown>): Promise<void> {
  await process.killTree().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pumps,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DRAIN_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** Closes the standard input of `process`: a command that reads it sees the end at once. */
async function closeStdin(process: LaunchedProcess): Promise<void> {
  try {
    await process.stdin.getWriter().close();
  } catch {
    // Already closed or gone.
  }
}

/**
 * Runs a short command of the client to its end and returns its exit code and the tail of its
 * output (a status, a logout). Never prints or logs the output; the caller reads from it only what
 * it needs. A command that does not end in `timeoutMs` is ended with its tree and rejects with
 * `AdapterUnavailable`.
 */
export async function runCommand(
  where: LoginRun,
  command: CommandSpec,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<{ readonly code: number | null; readonly output: string }> {
  const process = await where.launcher.launch({
    cmd: command.cmd,
    args: [...command.args],
    cwd: where.cwd,
    env: where.env,
  });
  let output = '';
  const collect = (text: string): void => {
    output = (output + text).slice(-OUTPUT_CAP);
  };
  const pumps = Promise.all([pump(process.stdout, collect), pump(process.stderr, collect)]);
  await closeStdin(process);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([process.exited, timedOut]);
    if (result === 'timeout') {
      throw new AdapterUnavailable(`${command.cmd} did not end in ${String(timeoutMs)} ms`);
    }
    await drain(process, pumps);
    return { code: result.code, output };
  } finally {
    clearTimeout(timer);
    await process.killTree().catch(() => undefined);
  }
}

/**
 * Starts the official login of the client (`<client> login`...) in the profile directory and
 * returns the flow. The adapter only runs the client's own command and watches what it prints for
 * the URL and the code to show the Producer; the client writes the token where it keeps it, and
 * nothing here opens that place (architecture 5.6).
 *
 * `login()` returns when the client printed what the mode needs (the URL, and the code for
 * `device_code`), when it ended, or after `urlWaitMs`; `terminal` does not wait. `complete()`
 * resolves when the client exits with code 0, rejects with `PermissionDenied` for another exit or
 * a login that outlived `timeoutMs`, and with `Cancelled` after `cancel()`. `submitCode()` writes
 * the code the browser shows to the standard input of the login, one line (P27, N158): the client
 * reads it where it asks for it (Claude Code: `Paste code here if prompted >`), and the code is
 * never logged or kept here.
 */
export async function startOfficialLogin(
  where: LoginRun,
  command: CommandSpec,
  mode: LoginFlow['mode'],
  timing: LoginTiming = {},
): Promise<LoginFlow> {
  const process = await where.launcher.launch({
    cmd: command.cmd,
    args: [...command.args],
    cwd: where.cwd,
    env: where.env,
  });
  let seen = '';
  let url: string | undefined;
  let code: string | undefined;
  let cancelled = false;
  let timedOut = false;
  let ended = false;
  const hasEnded = (): boolean => ended;
  let wake = (): void => undefined;
  // A callback server on this machine is not what the person opens: wait for the sign-in URL, and
  // fall back to the callback server only when `urlWaitMs` passes without one.
  const hasUrl = (): boolean => url !== undefined && !isLoopbackUrl(url);
  const hasWhatItNeeds = (): boolean =>
    mode === 'terminal' || (mode === 'device_code' ? hasUrl() && code !== undefined : hasUrl());
  const watch = (text: string): void => {
    seen = (seen + text).slice(-OUTPUT_CAP);
    if (!hasUrl()) url = signInUrl(seen) ?? url;
    code ??= firstCode(seen);
    if (hasWhatItNeeds()) wake();
  };
  const pumps = Promise.all([pump(process.stdout, watch), pump(process.stderr, watch)]);
  const timer = setTimeout(() => {
    timedOut = true;
    void process.killTree();
  }, timing.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  timer.unref();

  const completion = process.exited.then(async (exit) => {
    ended = true;
    clearTimeout(timer);
    await drain(process, pumps);
    if (cancelled) throw new Cancelled(`${command.cmd}: the login was cancelled`);
    if (timedOut) throw new PermissionDenied(`${command.cmd}: the login did not end in time`);
    if (exit.code !== 0) {
      throw new PermissionDenied(
        `${command.cmd}: the login ended with ${exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${String(exit.code)}`}`,
      );
    }
  });
  // The flow may end (cancelled, timed out) while nobody awaits `complete()`.
  completion.catch(() => undefined);

  // Wait for what the mode shows, but no longer than `urlWaitMs`, and not past the end of the process.
  if (!hasWhatItNeeds()) {
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
      new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, timing.urlWaitMs ?? DEFAULT_URL_WAIT_MS);
      }),
      completion.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    clearTimeout(waitTimer);
  }
  if (hasEnded() && url === undefined) {
    // It ended before saying anything to show: a refusal is told now, a success is the flow already done.
    await completion;
  }

  return {
    mode,
    ...(url === undefined ? {} : { url }),
    ...(code === undefined ? {} : { code }),
    submitCode: async (given: string) => {
      const line = given.trim();
      if (line === '' || /[\r\n]/u.test(line)) {
        throw new InvalidInput('the login code must be one non-empty line');
      }
      if (ended) throw new AdapterUnavailable(`${command.cmd}: the login already ended`);
      const writer = process.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(`${line}\n`));
      } catch {
        throw new AdapterUnavailable(`${command.cmd}: the login no longer reads its input`);
      } finally {
        writer.releaseLock();
      }
    },
    complete: () => completion,
    cancel: async () => {
      if (ended) return;
      cancelled = true;
      await process.killTree().catch(() => undefined);
      await completion.catch(() => undefined);
    },
  };
}
