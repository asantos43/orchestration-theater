// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11, P3): test only, excluded from the build of the package.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeededRandom } from './harness.js';
import { checkI2, type CommitLedger } from './invariants.js';

/**
 * A power loss that tears the store (level ii of docs/23, P3). SQLite in WAL mode with
 * `synchronous = FULL` (the default of the daemon) has fsynced every commit it told the daemon about,
 * so a power loss can only take away the transaction that was being committed at that instant: its
 * frames may be missing in part or whole at the end of the `-wal` file, and the `-shm` (an index in
 * memory) is gone. {@link tearStore} does exactly that to the files a killed daemon left:
 *
 * 1. the `.db` and the `-wal` are copied at the instant of the kill ({@link snapshotStore}: it must
 *    come before anything opens the store, because the last connection to close checkpoints the WAL
 *    away);
 * 2. the WAL is cut at a seeded byte inside its LAST commit (never before the commit that came before
 *    it) and never so early that a commit the harness saw confirmed (the ledger of I2) is lost;
 * 3. the cut WAL and the copy of the `.db` are written back, and the `-shm` is deleted.
 *
 * The cut is allowed to fall in the middle of a frame: SQLite ignores a frame whose checksum does not
 * match and everything after it. Linux and macOS write the same file format (the Windows build is
 * [N]: the WAL format is the same, but this harness runs on Linux only).
 */

const WAL_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;

export interface StoreSnapshot {
  readonly db: Buffer;
  /** `undefined` when the daemon had no WAL (it had closed the store, or never wrote). */
  readonly wal: Buffer | undefined;
}

/** What {@link parseWal} found: where each commit of the WAL ends. */
export interface WalLayout {
  readonly pageSize: number;
  /** The end offset of every commit frame, in order (the cut points that keep whole commits). */
  readonly commitEnds: readonly number[];
}

/** Reads the frame headers of a WAL: the commit frames of the current generation (same salts as the header). */
export function parseWal(wal: Buffer): WalLayout {
  if (wal.length < WAL_HEADER_BYTES) return { pageSize: 0, commitEnds: [] };
  const pageSize = wal.readUInt32BE(8);
  if (pageSize === 0) return { pageSize, commitEnds: [] };
  const frame = FRAME_HEADER_BYTES + pageSize;
  const commitEnds: number[] = [];
  for (let start = WAL_HEADER_BYTES; start + frame <= wal.length; start += frame) {
    // The salts of a frame of this generation equal the ones of the header; an older generation
    // that the WAL was reset over has other salts, and so does a torn tail.
    if (wal.readUInt32BE(start + 8) !== wal.readUInt32BE(16)) break;
    if (wal.readUInt32BE(start + 12) !== wal.readUInt32BE(20)) break;
    if (wal.readUInt32BE(start + 4) !== 0) commitEnds.push(start + frame);
  }
  return { pageSize, commitEnds };
}

export function snapshotStore(dataDir: string): StoreSnapshot | undefined {
  const dbPath = join(dataDir, 'store.sqlite');
  if (!existsSync(dbPath)) return undefined;
  const walPath = `${dbPath}-wal`;
  return {
    db: readFileSync(dbPath),
    wal: existsSync(walPath) ? readFileSync(walPath) : undefined,
  };
}

/** Whether a copy of the store with the WAL cut at `bytes` still holds every commit the ledger saw. */
function keepsLedger(
  snapshot: StoreSnapshot,
  wal: Buffer,
  bytes: number,
  ledger: CommitLedger,
): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'otheater-torn-'));
  try {
    const path = join(scratch, 'store.sqlite');
    writeFileSync(path, snapshot.db);
    writeFileSync(`${path}-wal`, wal.subarray(0, bytes));
    return checkI2({ storePath: path, ledger }).ok;
  } catch {
    // The cut left a store without its tables (the first commits were still in the WAL).
    return false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface Tear {
  /** Whether there was a WAL to cut. */
  readonly hadWal: boolean;
  readonly commits: number;
  readonly walBytes: number;
  /** The size of the WAL after the cut (equal to `walBytes` when the cut took nothing). */
  readonly keptBytes: number;
  /** The smallest the cut was allowed to be. */
  readonly floorBytes: number;
}

/**
 * Writes back the `.db` and a cut `-wal`, and deletes the `-shm` (see the top of the file). The
 * cut is drawn from `seed`, so a failed run repeats with `OT_CHAOS_SEED`.
 */
export function tearStore(input: {
  readonly dataDir: string;
  readonly snapshot: StoreSnapshot;
  readonly ledger: CommitLedger;
  readonly seed: number;
}): Tear {
  const dbPath = join(input.dataDir, 'store.sqlite');
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const { snapshot, ledger } = input;
  writeFileSync(dbPath, snapshot.db);
  rmSync(shmPath, { force: true });
  const wal = snapshot.wal;
  if (wal === undefined) {
    rmSync(walPath, { force: true });
    return { hadWal: false, commits: 0, walBytes: 0, keptBytes: 0, floorBytes: 0 };
  }
  const { commitEnds } = parseWal(wal);
  // Never before the commit that came before the last one: a power loss takes the transaction that
  // was being committed, and nothing the daemon had already been told was safe.
  const beforeLast =
    commitEnds.length >= 2
      ? (commitEnds[commitEnds.length - 2] ?? WAL_HEADER_BYTES)
      : WAL_HEADER_BYTES;
  let floor = Math.max(WAL_HEADER_BYTES, beforeLast);
  if (floor < wal.length && !keepsLedger(snapshot, wal, floor, ledger)) {
    // The ledger saw commits past the floor: the smallest cut that keeps them, by bisection over the
    // commit ends (the more is cut the fewer commits are left, so the answer is monotone). If even
    // the whole WAL does not keep them, nothing is cut and I2 will say what is missing.
    const ends = commitEnds.filter((end) => end > floor);
    let low = 0;
    let high = ends.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (keepsLedger(snapshot, wal, ends[mid] ?? wal.length, ledger)) high = mid;
      else low = mid + 1;
    }
    floor = low < ends.length ? (ends[low] ?? wal.length) : wal.length;
  }
  const kept =
    floor >= wal.length ? wal.length : new SeededRandom(input.seed).int(floor, wal.length);
  writeFileSync(walPath, wal.subarray(0, kept));
  return {
    hadWal: true,
    commits: commitEnds.length,
    walBytes: wal.length,
    keptBytes: kept,
    floorBytes: floor,
  };
}
