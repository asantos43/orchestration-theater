// SPDX-License-Identifier: MPL-2.0
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { sweepTemporaries, temporaryPathOf } from '@otheater/client/node';
import { Conflict } from '@otheater/core';
import { z } from 'zod';

/** Who holds the lock; written beside it so a second process can say who is running. */
export const InstanceLockInfoSchema = z.strictObject({
  pid: z.int().min(1),
  startedAt: z.int().min(0),
  version: z.string().min(1),
});
export type InstanceLockInfo = z.infer<typeof InstanceLockInfoSchema>;

/** Lock files held by this process: a second acquire in the same process must fail by itself. */
const heldHere = new Set<string>();

/** The shape of the temporary of the info file: `<file>.<pid>.tmp`. */
const INFO_TEMPORARY_SHAPE = { hexLength: 0 } as const;

/**
 * One daemon per data directory (architecture 5.1). [proposta] The lock is an exclusive SQLite
 * lock on `daemon.lock` taken through `node:sqlite` (builtin, no dependency): `locking_mode =
 * EXCLUSIVE` plus `BEGIN EXCLUSIVE` with no waiting. It is an operating-system file lock that the
 * system drops by itself when the process ends, SIGKILL included, so there is no stale pid file
 * to guess about.
 *
 * Because the exclusive lock also blocks readers, the "who holds it" details (`pid`,
 * `startedAt`, `version`) live in `daemon.lock.json` beside it, written by the holder through
 * {@link InstanceLock.publish}.
 *
 * Rule for this file: nothing in this process may open `daemon.lock` with another file descriptor
 * while it is held (closing any descriptor of a file drops the POSIX locks the process has on
 * it). Hence the in-process set above and a separate info file.
 */
export class InstanceLock {
  readonly #lockPath: string;
  readonly #infoPath: string;
  #db: { close(): void; exec(sql: string): void } | undefined;

  private constructor(
    lockPath: string,
    infoPath: string,
    db: { close(): void; exec(sql: string): void },
  ) {
    this.#lockPath = lockPath;
    this.#infoPath = infoPath;
    this.#db = db;
  }

  /**
   * Takes the lock or rejects with `Conflict`, naming the holder when its info file says who.
   * Any info file found after winning is stale (left by a process that died) and is removed.
   */
  static async acquire(lockPath: string, infoPath: string): Promise<InstanceLock> {
    if (heldHere.has(lockPath)) {
      throw await alreadyRunning(lockPath, infoPath);
    }
    // Loaded here, not at the top: `node:sqlite` may print an ExperimentalWarning when imported.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(lockPath);
    try {
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      try {
        db.close();
      } catch {
        // Nothing more to do: the lock was never ours.
      }
      if (isBusy(error)) throw await alreadyRunning(lockPath, infoPath);
      throw error;
    }
    heldHere.add(lockPath);
    await rm(infoPath, { force: true });
    return new InstanceLock(lockPath, infoPath, db);
  }

  /** `true` until {@link release}. */
  get held(): boolean {
    return this.#db !== undefined;
  }

  /** Writes who holds the lock (atomically: a reader never sees half a file). */
  async publish(info: InstanceLockInfo): Promise<void> {
    if (this.#db === undefined) return;
    const parsed = InstanceLockInfoSchema.parse(info);
    const temporary = temporaryPathOf(this.#infoPath, INFO_TEMPORARY_SHAPE);
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await rename(temporary, this.#infoPath);
    // N306: a daemon killed between the write and the rename leaves `<file>.<pid>.tmp`.
    await sweepTemporaries(this.#infoPath, INFO_TEMPORARY_SHAPE);
  }

  /** Frees the lock. Idempotent. The info file goes first, while the lock still protects it. */
  async release(): Promise<void> {
    const db = this.#db;
    if (db === undefined) return;
    this.#db = undefined;
    try {
      await rm(this.#infoPath, { force: true });
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Closing releases the lock anyway.
      }
      db.close();
      heldHere.delete(this.#lockPath);
    }
  }
}

/**
 * Runs a set-up step while `lock` is held and frees the lock when the step fails, so a command whose
 * composition throws does not keep the data directory locked (nor the `daemon.lock` file open,
 * which Windows refuses to delete). The caller frees the lock itself when the step succeeds.
 */
export async function releaseOnFailure<T>(lock: InstanceLock, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}

/** The holder's info, or `undefined` when there is none (or it is unreadable). */
export async function readLockInfo(infoPath: string): Promise<InstanceLockInfo | undefined> {
  try {
    const parsed = InstanceLockInfoSchema.safeParse(JSON.parse(await readFile(infoPath, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function alreadyRunning(lockPath: string, infoPath: string): Promise<Conflict> {
  const info = await readLockInfo(infoPath);
  const who =
    info === undefined
      ? 'another process holds'
      : `pid ${String(info.pid)}, since ${new Date(info.startedAt).toISOString()}, holds`;
  return new Conflict(
    `A daemon is already running on this data directory (${who} ${lockPath}). Stop it first.`,
  );
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their extended variants (low byte).
  return typeof code === 'number' && (code & 0xff) <= 6 && (code & 0xff) >= 5;
}
