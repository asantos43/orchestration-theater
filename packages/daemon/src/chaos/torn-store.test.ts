// SPDX-License-Identifier: MPL-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommitLedger, checkI1 } from './invariants.js';
import { parseWal, snapshotStore, tearStore } from './torn-store.js';

/** A real SQLite database in WAL mode, with a few commits that stay in the `-wal` (no checkpoint). */
const COMMITS = 6;

let dir: string;
let ledger: CommitLedger;

function writeStore(): DatabaseSync {
  const db = new DatabaseSync(join(dir, 'store.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA wal_autocheckpoint = 0');
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT NOT NULL)');
  db.exec('CREATE TABLE side_effects (idempotency_key TEXT PRIMARY KEY)');
  for (let n = 1; n <= COMMITS; n += 1) {
    db.prepare('INSERT INTO events (id, type) VALUES (?, ?)').run(n, 'test.event');
  }
  return db;
}

function eventCount(): number {
  const db = new DatabaseSync(join(dir, 'store.sqlite'));
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'otheater-torn-test-'));
  ledger = new CommitLedger(join(dir, 'ledger.jsonl'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseWal', () => {
  it('finds the page size and the end of every commit of a real WAL', () => {
    const db = writeStore();
    try {
      const wal = readFileSync(join(dir, 'store.sqlite-wal'));
      const layout = parseWal(wal);
      expect(layout.pageSize).toBe(4096);
      // Two for the tables and one for each insert, at least; the last one ends the file.
      expect(layout.commitEnds.length).toBeGreaterThanOrEqual(COMMITS);
      expect(layout.commitEnds.at(-1)).toBe(wal.length);
    } finally {
      db.close();
    }
  });

  it('is empty for a file that is not a WAL', () => {
    expect(parseWal(Buffer.alloc(10)).commitEnds).toEqual([]);
    expect(parseWal(Buffer.alloc(64)).commitEnds).toEqual([]);
  });
});

describe('tearStore', () => {
  it('keeps the commits the ledger saw and takes at most the last transaction', () => {
    const db = writeStore();
    let snapshot;
    try {
      snapshot = snapshotStore(dir);
    } finally {
      db.close();
    }
    if (snapshot === undefined) throw new Error('no snapshot');
    for (let id = 1; id <= COMMITS - 1; id += 1)
      ledger.confirm([{ kind: 'event', id, type: 'test.event' }]);
    const sizes = new Set<number>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const tear = tearStore({ dataDir: dir, snapshot, ledger, seed });
      expect(tear.hadWal).toBe(true);
      expect(tear.keptBytes).toBeGreaterThanOrEqual(tear.floorBytes);
      expect(tear.keptBytes).toBeLessThanOrEqual(tear.walBytes);
      expect(statSync(join(dir, 'store.sqlite-wal')).size).toBe(tear.keptBytes);
      expect(existsSync(join(dir, 'store.sqlite-shm'))).toBe(false);
      sizes.add(tear.keptBytes);
      // What the ledger saw is there, and the store is sound (a torn tail is ignored, not an error).
      expect(eventCount()).toBeGreaterThanOrEqual(COMMITS - 1);
      expect(checkI1({ dataDir: dir }).ok).toBe(true);
      // The harness opened the store, which may have checkpointed: start every round from the same files.
      rmSync(join(dir, 'store.sqlite-wal'), { force: true });
    }
    // Different seeds cut at different places, and some cuts really take bytes away.
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('cuts nothing when the ledger saw every commit of the WAL', () => {
    const db = writeStore();
    let snapshot;
    try {
      snapshot = snapshotStore(dir);
    } finally {
      db.close();
    }
    if (snapshot === undefined) throw new Error('no snapshot');
    ledger.confirm([{ kind: 'event', id: COMMITS, type: 'test.event' }]);
    const tear = tearStore({ dataDir: dir, snapshot, ledger, seed: 7 });
    expect(tear.keptBytes).toBe(tear.walBytes);
    expect(eventCount()).toBe(COMMITS);
  });

  it('can take the whole last transaction when the ledger did not see it', () => {
    const db = writeStore();
    let snapshot;
    try {
      snapshot = snapshotStore(dir);
    } finally {
      db.close();
    }
    if (snapshot === undefined) throw new Error('no snapshot');
    const wal = snapshot.wal;
    if (wal === undefined) throw new Error('no wal');
    const { commitEnds } = parseWal(wal);
    const counts = new Set<number>();
    for (let seed = 1; seed <= 60; seed += 1) {
      tearStore({ dataDir: dir, snapshot, ledger, seed });
      counts.add(eventCount());
      rmSync(join(dir, 'store.sqlite-wal'), { force: true });
    }
    expect(commitEnds.length).toBeGreaterThan(1);
    // The last insert is torn (the cut falls inside it): the ones before it are always there.
    expect(Math.min(...counts)).toBe(COMMITS - 1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(COMMITS);
  });

  it('without a WAL it writes back the database and removes the leftovers', () => {
    writeFileSync(join(dir, 'store.sqlite-shm'), 'x');
    writeFileSync(join(dir, 'store.sqlite-wal'), 'x');
    const tear = tearStore({
      dataDir: dir,
      snapshot: { db: Buffer.alloc(0), wal: undefined },
      ledger,
      seed: 1,
    });
    expect(tear.hadWal).toBe(false);
    expect(existsSync(join(dir, 'store.sqlite-wal'))).toBe(false);
    expect(existsSync(join(dir, 'store.sqlite-shm'))).toBe(false);
  });
});
