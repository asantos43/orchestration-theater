// SPDX-License-Identifier: MPL-2.0
import type { SqliteDatabase, SqliteStatement } from 'kysely';
import type { SQLInputValue } from 'node:sqlite';
import type { SqliteDriverName } from './config.js';

/**
 * What the adapter needs from a SQLite driver beyond what Kysely's `SqliteDialect` already asks of
 * it (`prepare` + `close`). Both drivers hide behind this, so the rest of the package is
 * driver-agnostic (decision N49: same conformance suite on both).
 */
export interface RawDatabase extends SqliteDatabase {
  /** Runs one or more statements, ignoring any rows. */
  exec(sql: string): void;
  /**
   * Online copy of the main database into `destPath` with SQLite's backup API (a consistent
   * snapshot), `pagesPerStep` pages per `sqlite3_backup_step`; the event loop is free between
   * steps. A step that finds the source changed by another connection since the previous step
   * **restarts the whole copy**; a single step covering every page cannot be interrupted, so it
   * always finishes. `onProgress` runs after each step (the first one reports the page count); if
   * it throws, the copy stops and the error is what `backupTo` rejects with.
   */
  backupTo(destPath: string, options: BackupToOptions): Promise<void>;
}

export interface BackupProgress {
  readonly totalPages: number;
  readonly remainingPages: number;
}

export interface BackupToOptions {
  /** Pages per step; any value >= the page count means "all in one step". */
  readonly pagesPerStep: number;
  readonly onProgress?: (progress: BackupProgress) => void;
}

export interface OpenRawOptions {
  readonly readonly: boolean;
  readonly busyTimeoutMs: number;
}

/** Opens `path` with the chosen driver. Drivers are imported on demand: only the used one loads. */
export async function openRawDatabase(
  driver: SqliteDriverName,
  path: string,
  options: OpenRawOptions,
): Promise<RawDatabase> {
  switch (driver) {
    case 'better-sqlite3':
      return openBetterSqlite3(path, options);
    case 'node-sqlite':
      return openNodeSqlite(path, options);
  }
}

async function openBetterSqlite3(path: string, options: OpenRawOptions): Promise<RawDatabase> {
  const { default: Database } = await import('better-sqlite3');
  // `fileMustExist` for read-only: opening must never create an empty database by accident.
  const db = new Database(path, {
    readonly: options.readonly,
    fileMustExist: options.readonly,
    timeout: options.busyTimeoutMs,
  });
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => {
      if (db.open) db.close();
    },
    backupTo: async (destPath, { pagesPerStep, onProgress }) => {
      // better-sqlite3 runs a first step of 0 pages, then asks the callback for the size of every
      // next step; it removes the partial file when the callback throws.
      await db.backup(destPath, {
        progress: (progress) => {
          onProgress?.(progress);
          return pagesPerStep;
        },
      });
    },
  };
}

async function openNodeSqlite(path: string, options: OpenRawOptions): Promise<RawDatabase> {
  // `node:sqlite` still prints an ExperimentalWarning on Node 24: load it only when asked for.
  const { DatabaseSync, backup } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: options.readonly, timeout: options.busyTimeoutMs });
  let open = true;
  return {
    // Kysely hands parameters as one array; `node:sqlite` takes them spread. It also tells a
    // statement that returns rows from one that does not by its columns (what `reader` means).
    prepare: (sql): SqliteStatement => {
      const statement = db.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...(parameters as SQLInputValue[])),
        run: (parameters) => statement.run(...(parameters as SQLInputValue[])),
        iterate: (parameters) => statement.iterate(...(parameters as SQLInputValue[])),
      };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => {
      if (open) {
        open = false;
        db.close();
      }
    },
    backupTo: async (destPath, { pagesPerStep, onProgress }) => {
      // A throwing `progress` rejects the promise but leaves the partial file: the caller removes it.
      await backup(db, destPath, {
        rate: pagesPerStep,
        ...(onProgress === undefined ? {} : { progress: onProgress }),
      });
    },
  };
}

/** First column of the first row of `PRAGMA <name>`, or `undefined` when it returns no row. */
export function readPragma(db: RawDatabase, name: string): unknown {
  const [row] = db.prepare(`PRAGMA ${name}`).all([]) as Record<string, unknown>[];
  return row === undefined ? undefined : Object.values(row)[0];
}

/** `PRAGMA integrity_check`: `['ok']` for a healthy database, else the problems it found. */
export function integrityCheck(db: RawDatabase): string[] {
  const rows = db.prepare('PRAGMA integrity_check').all([]) as Record<string, unknown>[];
  return rows.map((row) => String(Object.values(row)[0]));
}
