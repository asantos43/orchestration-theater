// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Conflict,
  isOTheaterError,
  OTheaterError,
  Transient,
} from '@otheater/core';

/** The migrations of the base could not be applied (internal: the adapter recreates the base). */
export class TelemetryMigrationFailed extends OTheaterError<'TELEMETRY_MIGRATION_FAILED'> {
  constructor(message: string, options?: ErrorOptions) {
    super('TELEMETRY_MIGRATION_FAILED', message, options);
  }
}

/** SQLite primary result codes (https://sqlite.org/rescode.html) this adapter maps. */
const PRIMARY_CODES: Readonly<Record<string, number>> = {
  PERM: 3,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  IOERR: 10,
  CORRUPT: 11,
  FULL: 13,
  CANTOPEN: 14,
  CONSTRAINT: 19,
  NOTADB: 26,
};

/** Primary SQLite result code of an error from either driver, or `undefined` if it is not one. */
export function primaryCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  // node:sqlite: `errcode` is the extended result code; the primary one is its low byte.
  if (typeof errcode === 'number') return errcode & 0xff;
  // better-sqlite3: `code` is the name, e.g. SQLITE_BUSY_SNAPSHOT or SQLITE_CONSTRAINT_UNIQUE.
  if (typeof code === 'string' && code.startsWith('SQLITE_')) {
    const primary = code.split('_')[1];
    return primary === undefined ? undefined : PRIMARY_CODES[primary];
  }
  return undefined;
}

/** Why a base is thrown away and recreated. A base that merely cannot be opened is not one of these. */
export type ResetReason = 'corrupt' | 'disk_full' | 'migration_failed';

/**
 * The reason to recreate the base for this failure, or `undefined` when recreating would not
 * help (a lock, a permission, a path that cannot be opened: a new file would hit the same wall).
 * A `TelemetryMigrationFailed` (a file of a newer version, say) counts as
 * `migration_failed`: telemetry is a mirror, and the broken file is kept beside the new one.
 */
export function resetReasonOf(error: unknown): ResetReason | undefined {
  const code = primaryCode(
    error instanceof Error && error.cause !== undefined ? error.cause : error,
  );
  if (code === PRIMARY_CODES.CORRUPT || code === PRIMARY_CODES.NOTADB) return 'corrupt';
  if (code === PRIMARY_CODES.FULL) return 'disk_full';
  return error instanceof TelemetryMigrationFailed ? 'migration_failed' : undefined;
}

/**
 * Translates a SQLite error into the typed errors of the port contract (architecture 5.18, rule
 * 4); anything else, including errors that are already OTheater errors, is returned untouched.
 */
export function toTelemetryError(error: unknown): unknown {
  if (isOTheaterError(error)) return error;
  const code = primaryCode(error);
  if (code === undefined || !(error instanceof Error)) return error;
  const options = { cause: error };
  const message = `SQLite: ${error.message}`;
  switch (code) {
    case PRIMARY_CODES.BUSY:
    case PRIMARY_CODES.LOCKED:
      return new Transient(message, options);
    case PRIMARY_CODES.CONSTRAINT:
      return new Conflict(message, options);
    case PRIMARY_CODES.PERM:
    case PRIMARY_CODES.READONLY:
    case PRIMARY_CODES.IOERR:
    case PRIMARY_CODES.CORRUPT:
    case PRIMARY_CODES.FULL:
    case PRIMARY_CODES.CANTOPEN:
    case PRIMARY_CODES.NOTADB:
    case PRIMARY_CODES.NOMEM:
      return new AdapterUnavailable(message, options);
    default:
      return error;
  }
}
