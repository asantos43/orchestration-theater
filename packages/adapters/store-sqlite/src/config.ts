// SPDX-License-Identifier: MPL-2.0
import { STORE_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

/** Identity of this adapter (architecture 5.18, "Versão dos contratos"). */
export const SQLITE_STORE_ADAPTER: Adapter = {
  id: 'sqlite',
  implements: { port: 'Store', range: `^${STORE_PORT_VERSION}` },
};

/** The two SQLite drivers behind the same Kysely dialect (decision N49, key `store.driver`). */
export const SQLITE_DRIVERS = ['better-sqlite3', 'node-sqlite'] as const;
export type SqliteDriverName = (typeof SQLITE_DRIVERS)[number];

/** `PRAGMA synchronous` modes offered by the `store.synchronous` key. */
export const SQLITE_SYNCHRONOUS_MODES = ['full', 'normal'] as const;
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

/**
 * Configuration of the SQLite `Store` adapter. Every adapter contributes the schema of its own
 * keys; the daemon composes them under `store.*` and validates at start-up (architecture 5.18).
 *
 * [proposta] every default is a configuration key with several modes (project rule), so
 * `synchronous` and `busyTimeoutMs` are keys even though the architecture only fixes `full`.
 */
export const SqliteStoreConfigSchema = z.strictObject({
  /** Database file. Its parent directory is created when missing. */
  path: databasePath,
  /** SQLite driver. Default `better-sqlite3` (decision N49). */
  driver: z.enum(SQLITE_DRIVERS).default('better-sqlite3'),
  /**
   * Durability of each commit (`PRAGMA synchronous`). `full` (default, architecture 5.21): a
   * committed transaction survives a power failure. `normal`: faster, but in WAL mode the last
   * transactions may be lost on power failure (the file stays consistent).
   */
  synchronous: z.enum(SQLITE_SYNCHRONOUS_MODES).default('full'),
  /** How long a connection waits for a lock before failing with `Transient` (`busy_timeout`). */
  busyTimeoutMs: z.int().min(0).max(600_000).default(5000),
});

/** What the user may write (defaults optional). */
export type SqliteStoreConfigInput = z.input<typeof SqliteStoreConfigSchema>;
/** The validated configuration, every default filled in. */
export type SqliteStoreConfig = z.output<typeof SqliteStoreConfigSchema>;
