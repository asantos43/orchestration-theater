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
    handlers.onFatal(error);
  };
  const onRejection = (reason: unknown): void => {
    handlers.onFatal(reason);
  };
  host.on('uncaughtException', onError);
  host.on('unhandledRejection', onRejection);
  return () => {
    for (const [signal, listener] of signalListeners) host.off(signal, listener);
    host.off('uncaughtException', onError);
    host.off('unhandledRejection', onRejection);
  };
}
