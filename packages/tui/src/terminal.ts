// SPDX-License-Identifier: MPL-2.0

/** Signals that end the TUI: the terminal must be given back as it was before it exits. */
export const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type ExitSignal = (typeof EXIT_SIGNALS)[number];

/** The exit code a shell shows for a process ended by the signal (128 + number). */
export const SIGNAL_EXIT_CODES: Readonly<Record<ExitSignal, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * The codes of a write or a read on a terminal that is gone (the window was closed, the connection
 * dropped, the pty was torn down): `EIO` and `ENXIO` from a pty with no one on the other side, `EPIPE`
 * from a closed pipe.
 */
export const TERMINAL_GONE_CODES: readonly string[] = ['EIO', 'EPIPE', 'ENXIO'];

/** Whether `error` says the terminal is gone: nothing can be shown or read there any more. */
export function isTerminalGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && TERMINAL_GONE_CODES.includes(code);
}

/** The part of `process` the guards use, so a test can pass a fake one. */
export interface ProcessHost {
  on(event: ExitSignal, listener: () => void): unknown;
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: ExitSignal, listener: () => void): unknown;
  off(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

export interface ExitGuardHandlers {
  /** A signal asked the process to end. The handler unmounts the app (which restores the terminal). */
  onSignal(signal: ExitSignal): void;
  /** An error nobody caught. The handler unmounts the app and reports the error. */
  onFatal(error: unknown): void;
  /**
   * An error nobody caught that says the terminal is gone (`isTerminalGone`). Reporting it would be a
   * write to that same terminal, which fails the same way and raises the same error again, so the
   * handler only unmounts the app.
   */
  onTerminalGone(): void;
}

/**
 * Listens for the signals and the uncaught errors that would end the process with the alternate
 * screen still on and the cursor hidden. Returns the function that takes the listeners off.
 */
export function installExitGuards(host: ProcessHost, handlers: ExitGuardHandlers): () => void {
  const signalListeners = EXIT_SIGNALS.map((signal) => {
    const listener = (): void => {
      handlers.onSignal(signal);
    };
    host.on(signal, listener);
    return [signal, listener] as const;
  });
  const onError = (error: Error): void => {
    if (isTerminalGone(error)) handlers.onTerminalGone();
    else handlers.onFatal(error);
  };
  const onRejection = (reason: unknown): void => {
    if (isTerminalGone(reason)) handlers.onTerminalGone();
    else handlers.onFatal(reason);
  };
  host.on('uncaughtException', onError);
  host.on('unhandledRejection', onRejection);
  return () => {
    for (const [signal, listener] of signalListeners) host.off(signal, listener);
    host.off('uncaughtException', onError);
    host.off('unhandledRejection', onRejection);
  };
}

/** What `endProcess` needs from the process and the timers, so a test passes fake ones. */
export interface EndHost {
  exit(code: number): void;
  setExitCode(code: number): void;
}

export interface EndTimers {
  set(callback: () => void, ms: number): { unref(): unknown };
}

/**
 * Ends the process once the TUI is done. The exit code is set first, so a natural end (nothing
 * holds the event loop) keeps it. A handle that does stay open (the socket to the daemon, a timer)
 * would keep a process alive for ever, and with no terminal that is an orphan, so the exit is also
 * forced after `graceMs`, which gives the last async work (the layout save of the unmount) time to
 * finish. The timer is unref'd: it never delays a natural end. With 0 the exit is at once.
 */
export function endProcess(
  code: number,
  graceMs: number,
  host: EndHost,
  timers: EndTimers = {
    set: (callback, ms) => {
      return setTimeout(callback, ms);
    },
  },
): void {
  host.setExitCode(code);
  if (graceMs <= 0) {
    host.exit(code);
    return;
  }
  timers
    .set(() => {
      host.exit(code);
    }, graceMs)
    .unref();
}
