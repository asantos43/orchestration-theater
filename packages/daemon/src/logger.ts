// SPDX-License-Identifier: MPL-2.0
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';
import type { Clock } from '@otheater/core';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { DaemonConfig } from './config.js';
import { RotatingFile, type LogRotation } from './log-rotation.js';

export type { Logger } from 'pino';

/**
 * Paths pino masks even when someone logs an object holding them. [proposta] A defence in depth:
 * the real protection is `Secret` from core, which writes `[REDACTED]` in JSON, so a `Secret`
 * never reaches the log in clear whatever its key is called.
 */
export const REDACT_PATHS: readonly string[] = [
  ...secretKeysAt(''),
  ...secretKeysAt('*.'),
  // One level deeper: the `err`/`error` of a log call, a `request`/`req` with its headers, a `details`.
  ...secretKeysAt('*.*.'),
  // The headers of a request or a response, where the token and the cookies travel (the keys of a
  // header object are in lower case in Node, but a client of the API may spell them otherwise).
  'headers["set-cookie"]',
  '*.headers["set-cookie"]',
  '*.*.headers["set-cookie"]',
  'headers["proxy-authorization"]',
  '*.headers["proxy-authorization"]',
  '*.*.headers["proxy-authorization"]',
];

/** The key names that hold a secret, under `prefix` (a wildcard path pino understands). */
function secretKeysAt(prefix: string): string[] {
  const keys = [
    'password',
    'passphrase',
    'token',
    'secret',
    'apiKey',
    'api_key',
    'authorization',
    'Authorization',
    'cookie',
    'Cookie',
    'cookies',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'bearer',
  ];
  return keys.map((key) => `${prefix}${key}`);
}

export interface CreateLoggerOptions {
  readonly level: DaemonConfig['log']['level'];
  readonly destination: DaemonConfig['log']['destination'];
  /** `<data>/logs/daemon.log`, used by the `file` and `both` destinations. */
  readonly logFile: string;
  /** Timestamps come from here, like every other time in the daemon. */
  readonly clock: Pick<Clock, 'now'>;
  /** Replaces the destinations (tests capture the lines here). */
  readonly stream?: Writable;
  /** Rotates the file by size (`log.rotate`, P8); without it the file grows. */
  readonly rotate?: LogRotation | undefined;
  /** Told when a rotation fails (the log goes on in the same file). */
  readonly onRotateError?: ((error: unknown) => void) | undefined;
  /** Told when a line could not be written (a full disk, P5 of Phase 11); the line is lost. */
  readonly onWriteError?: ((error: unknown) => void) | undefined;
}

export interface DaemonLogger {
  readonly logger: Logger;
  /** Flushes and closes the file; idempotent. */
  close(): void;
}

/**
 * The structured technical log (architecture section 8): one JSON line per entry, in English.
 * [proposta] The file is written synchronously: a daemon logs little, and nothing can be lost in
 * a crash or in a flush race at shutdown. With `rotate` the file is rotated by size (P8, see
 * `log-rotation.ts`).
 */
export function createLogger(options: CreateLoggerOptions): DaemonLogger {
  const closers: (() => void)[] = [];
  const streams: DestinationStream[] = [];
  if (options.stream !== undefined) {
    streams.push(options.stream);
  } else {
    if (options.destination === 'file' || options.destination === 'both') {
      mkdirSync(dirname(options.logFile), { recursive: true, mode: 0o700 });
      const file: DestinationStream & { end(): void } =
        options.rotate === undefined
          ? pino.destination({ dest: options.logFile, sync: true, mode: 0o600, append: true })
          : new RotatingFile({
              path: options.logFile,
              mode: 0o600,
              maxBytes: options.rotate.maxBytes,
              keep: options.rotate.keep,
              onError: options.onRotateError,
              onWriteError: options.onWriteError,
            });
      streams.push(file);
      closers.push(() => {
        file.end();
      });
    }
    if (options.destination === 'stderr' || options.destination === 'both') {
      streams.push(process.stderr);
    }
  }
  const [only] = streams;
  const destination: DestinationStream =
    streams.length === 1 && only !== undefined
      ? only
      : pino.multistream(streams.map((stream) => ({ stream })));
  const logger = pino(
    {
      level: options.level,
      redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
      // The clock is the daemon's, so a test with a fake clock gets deterministic lines.
      timestamp: () => `,"time":${String(options.clock.now())}`,
      base: { pid: process.pid },
    },
    destination,
  );
  let closed = false;
  return {
    logger,
    close: () => {
      if (closed) return;
      closed = true;
      for (const close of closers) close();
    },
  };
}

/** A logger that writes nothing: for a command that owns no log file (`ot backup` beside a daemon). */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
