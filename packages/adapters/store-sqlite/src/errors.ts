// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Conflict,
  isOTheaterError,
  OTheaterError,
  Transient,
} from '@otheater/core';

/**
 * A backup could not be made (the copy failed or did not pass `PRAGMA integrity_check`). Adapter
 * specific code, as architecture 5.18 allows ("adapters may add their own subclasses").
 */
export class BackupFailed extends OTheaterError<'BACKUP_FAILED'> {
  constructor(message: string, options?: ErrorOptions) {
    super('BACKUP_FAILED', message, options);
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
function primaryCode(error: unknown): number | undefined {
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

/**
 * Translates a SQLite error into the typed errors of the port contract (architecture 5.18, rule
 * 4); anything else, including errors that are already OTheater errors, is returned untouched.
 *
 * - BUSY / LOCKED: `Transient` (retry with backoff);
 * - CONSTRAINT: `Conflict` (duplicate, broken foreign key...);
 * - PERM / READONLY / IOERR / CORRUPT / FULL / CANTOPEN / NOTADB / NOMEM: `AdapterUnavailable`;
 * - other SQLite errors (a bug in a query, say) pass through unchanged.
 */
export function toStoreError(error: unknown): unknown {
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
