// SPDX-License-Identifier: MPL-2.0
import { TELEMETRY_STORE_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

/** Identity of this adapter (architecture 5.18, "Versão dos contratos"). */
export const SQLITE_TELEMETRY_ADAPTER: Adapter = {
  id: 'sqlite',
  implements: { port: 'TelemetryStore', range: `^${TELEMETRY_STORE_PORT_VERSION}` },
};

/** The two SQLite drivers behind the same Kysely dialect (decision N49). */
export const SQLITE_DRIVERS = ['better-sqlite3', 'node-sqlite'] as const;
export type SqliteDriverName = (typeof SQLITE_DRIVERS)[number];

/** `PRAGMA synchronous` modes offered by the `telemetry.synchronous` key. */
export const SQLITE_SYNCHRONOUS_MODES = ['normal', 'full'] as const;
export type SqliteSynchronousMode = (typeof SQLITE_SYNCHRONOUS_MODES)[number];

const databasePath = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'path must not contain a NUL character')
  .refine(
    // Two connections (one writer, one reader) need a real file: in-memory and URI forms would
    // give each connection its own empty database.
    (value) => value !== ':memory:' && !value.startsWith('file:'),
    'path must be a file path (":memory:" and "file:" URIs are not supported)',
  );

/** Defaults of the write queue (the daemon keys `telemetry.write.*` are [proposta]). */
export const DEFAULT_WRITE_BATCH = 500;
export const DEFAULT_QUEUE_MAX = 20_000;
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;
export const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Configuration of the SQLite `TelemetryStore` adapter. The daemon composes it from the
 * `telemetry.*` keys and the `store.*` ones (driver, busy timeout) and validates at start-up.
 *
 * [proposta] every default is a configuration key with several modes (project rule).
 */
export const SqliteTelemetryConfigSchema = z.strictObject({
  /** Database file. Its parent directory is created when missing. */
  path: databasePath,
  /** SQLite driver. Default `better-sqlite3` (decision N49). */
  driver: z.enum(SQLITE_DRIVERS).default('better-sqlite3'),
  /**
   * Durability of each commit (`PRAGMA synchronous`). `normal` (default, N54): in WAL mode a power
   * failure may lose the last commits and never corrupts the file; telemetry is a mirror, so it
   * does not pay for `full` (the `Store` stays `full`).
   */
  synchronous: z.enum(SQLITE_SYNCHRONOUS_MODES).default('normal'),
  /** How long a connection waits for a lock before failing (`busy_timeout`). */
  busyTimeoutMs: z.int().min(0).max(600_000).default(5000),
  /** Records written per transaction; a queue that reaches it is written at once. */
  writeBatch: z.int().min(1).max(100_000).default(DEFAULT_WRITE_BATCH),
  /** Records the queue holds; when it is full the oldest are dropped (and counted). */
  queueMax: z.int().min(1).max(10_000_000).default(DEFAULT_QUEUE_MAX),
  /** A queue that did not fill up is written after this long. `0` writes on the next tick. */
  flushIntervalMs: z.int().min(0).max(3_600_000).default(DEFAULT_FLUSH_INTERVAL_MS),
  /** With no base, how long before the next write tries to open one again. */
  retryAfterMs: z.int().min(0).max(86_400_000).default(DEFAULT_RETRY_AFTER_MS),
});

/** What the caller may write (defaults optional). */
export type SqliteTelemetryConfigInput = z.input<typeof SqliteTelemetryConfigSchema>;
/** The validated configuration, every default filled in. */
export type SqliteTelemetryConfig = z.output<typeof SqliteTelemetryConfigSchema>;
