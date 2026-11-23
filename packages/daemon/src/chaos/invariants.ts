// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11, P1): test only, excluded from the build of the package.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { aliveEntries, commandOf, type Census, type CensusEntry } from './census.js';

/**
 * The invariants I1 to I8 of docs/23 as functions. Each one reads what the dead (or stopped) daemon
 * left on disk, or what the harness saw, and answers with the problems it found: an empty list is a
 * pass. They are checked after every kill and after every restart. A test never asserts on the
 * internals: it calls {@link assertInvariants} with the results it wants.
 */

export const INVARIANT_IDS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

export interface InvariantResult {
  readonly id: InvariantId;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

function result(id: InvariantId, problems: string[]): InvariantResult {
  return { id, ok: problems.length === 0, problems };
}

/** Throws one error naming every problem of the results that failed. */
export function assertInvariants(results: readonly InvariantResult[]): void {
  const failed = results.filter((entry) => !entry.ok);
  if (failed.length === 0) return;
  throw new Error(
    failed.map((entry) => `${entry.id} failed:\n  - ${entry.problems.join('\n  - ')}`).join('\n'),
  );
}

/** Opens a database for reading only (`query_only`). Opening it also lets SQLite recover its WAL. */
function openRead(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA query_only = ON');
  return db;
}

function pragmaRows(db: DatabaseSync, pragma: 'quick_check' | 'integrity_check'): string[] {
  const rows = db.prepare(`PRAGMA ${pragma}`).all() as Record<string, unknown>[];
  return rows.map((row) => String(Object.values(row)[0]));
}

/**
 * I1: `quick_check` of the store and of the telemetry passes; `integrity_check` of each backup
 * copy passes. A file that does not exist yet is not a failure (the daemon has not created it).
 */
export function checkI1(input: {
  readonly dataDir: string;
  /** Backup copies of the store; they get the heavier `integrity_check`. */
  readonly backups?: readonly string[];
}): InvariantResult {
  const problems: string[] = [];
  const run = (path: string, pragma: 'quick_check' | 'integrity_check'): void => {
    if (!existsSync(path)) return;
    try {
      const db = openRead(path);
      try {
        const rows = pragmaRows(db, pragma);
        if (rows.length !== 1 || rows[0] !== 'ok') {
          problems.push(`${pragma} of ${path}: ${rows.join('; ')}`);
        }
      } finally {
        db.close();
      }
    } catch (error) {
      problems.push(`${pragma} of ${path} could not run: ${String(error)}`);
    }
  };
  run(join(input.dataDir, 'store.sqlite'), 'quick_check');
  run(join(input.dataDir, 'telemetry.sqlite'), 'quick_check');
  for (const backup of input.backups ?? []) run(backup, 'integrity_check');
  return result('I1', problems);
}

/** A commit the harness saw confirmed: what it noted before telling the test about it. */
export type LedgerEntry =
  | { readonly kind: 'event'; readonly id: number; readonly type: string }
  | { readonly kind: 'side_effect'; readonly key: string };

/**
 * The ledger of confirmed commits (I2, I8): one JSON line per entry, written and `fsync`ed BEFORE
 * the harness counts the confirmation, so a kill right after never leaves a confirmed commit out of
 * the ledger.
 */
export class CommitLedger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  confirm(entries: readonly LedgerEntry[]): void {
    if (entries.length === 0) return;
    const fd = openSync(this.path, 'a');
    try {
      appendFileSync(fd, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LedgerEntry);
  }
}

function missingFromStore(
  storePath: string,
  ledger: CommitLedger,
): { events: string[]; effects: string[] } {
  const events: string[] = [];
  const effects: string[] = [];
  const entries = ledger.entries();
  if (entries.length === 0) return { events, effects };
  if (!existsSync(storePath)) {
    return { events: ['store.sqlite does not exist, and commits were confirmed'], effects: [] };
  }
  const db = openRead(storePath);
  try {
    const eventRow = db.prepare('SELECT type FROM events WHERE id = ?');
    const effectRow = db.prepare(
      'SELECT idempotency_key FROM side_effects WHERE idempotency_key = ?',
    );
    for (const entry of entries) {
      if (entry.kind === 'event') {
        const row = eventRow.get(entry.id) as { type: string } | undefined;
        if (row === undefined) events.push(`event ${String(entry.id)} (${entry.type}) is gone`);
        else if (row.type !== entry.type) {
          events.push(`event ${String(entry.id)} was ${entry.type} and is now ${row.type}`);
        }
      } else if (effectRow.get(entry.key) === undefined) {
        effects.push(`side effect ${entry.key} is gone`);
      }
    }
  } finally {
    db.close();
  }
  return { events, effects };
}

/** I2: every commit the harness saw confirmed before the fall is in the store after the start. */
export function checkI2(input: {
  readonly storePath: string;
  readonly ledger: CommitLedger;
}): InvariantResult {
  const missing = missingFromStore(input.storePath, input.ledger);
  return result('I2', [...missing.events, ...missing.effects]);
}

/** I3: no process of the census is alive (pass the census taken BEFORE the reconciliation). */
export function checkI3(census: Census): InvariantResult {
  const alive = aliveEntries(census);
  return result('I3', alive.map(describeEntry));
}

function describeEntry(entry: CensusEntry): string {
  return `pid ${String(entry.pid)} is alive (${entry.source}: ${entry.detail}): ${commandOf(entry.pid)}`;
}

export interface CodeHostJournalEntry {
  readonly op: string;
  readonly opts?: { readonly head?: string; readonly base?: string };
  readonly target?: { readonly repo?: string; readonly branch?: string };
  readonly sha?: string;
}

/** Reads the journal of the fake code host (one JSON line per change). */
export function readCodeHostJournal(path: string): CodeHostJournalEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as CodeHostJournalEntry);
}

/**
 * I4: no external effect was done twice. The journal of the fake code host shows at most one pull
 * request and one merge for each (head, base) pair, and at most one effective push per branch (a
 * push of the same commit again changes nothing and does not count).
 */
export function checkI4(journal: readonly CodeHostJournalEntry[]): InvariantResult {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const pushes = new Map<string, Set<string>>();
  for (const entry of journal) {
    if (entry.op === 'openPullRequest' || entry.op === 'mergeBranch') {
      bump(`${entry.op} ${entry.opts?.head ?? '?'} -> ${entry.opts?.base ?? '?'}`);
    }
    if (entry.op === 'pushRef') {
      const key = `${entry.target?.repo ?? '?'}#${entry.target?.branch ?? '?'}`;
      const shas = pushes.get(key) ?? new Set<string>();
      shas.add(entry.sha ?? '?');
      pushes.set(key, shas);
    }
  }
  for (const [key, count] of counts) {
    if (count > 1) problems.push(`${key} happened ${String(count)} times`);
  }
  for (const [key, shas] of pushes) {
    if (shas.size > 1)
      problems.push(`${key} was pushed with ${String(shas.size)} different commits`);
  }
  return result('I4', problems);
}

/**
 * I5: no side effect is left `pending` or `ambiguous` without the Producer being asked: each one
 * is settled (by the verifier) or has a `recovery_effect` decision that names its key.
 */
export function checkI5(input: { readonly storePath: string }): InvariantResult {
  const problems: string[] = [];
  if (!existsSync(input.storePath)) return result('I5', problems);
  const db = openRead(input.storePath);
  try {
    const open = db
      .prepare(
        "SELECT idempotency_key, type, state FROM side_effects WHERE state IN ('pending', 'ambiguous')",
      )
      .all() as { idempotency_key: string; type: string; state: string }[];
    const asked = (
      db.prepare("SELECT input FROM decisions WHERE kind = 'recovery_effect'").all() as {
        input: string;
      }[]
    ).map((row) => row.input);
    for (const row of open) {
      if (!asked.some((text) => text.includes(row.idempotency_key))) {
        problems.push(
          `${row.type} ${row.idempotency_key} is ${row.state} and the Producer was not asked`,
        );
      }
    }
  } finally {
    db.close();
  }
  return result('I5', problems);
}

/** What the child daemon prints at the end of a run (`REPORT <json>`); only what I6 needs. */
export interface RunReportView {
  readonly timedOut: boolean;
  readonly plays: readonly { readonly id: string; readonly state: string }[];
  readonly recovered: readonly unknown[];
  readonly systemMessages: readonly {
    readonly scenarioId: string | null;
    readonly payload: unknown;
  }[];
}

/**
 * I6: the play ends (or is in a state the test says is explained), and the account of the
 * reconciliation came out once per start: `daemon.recovered` once for each of the `boots`, and no
 * two equal messages in one scenario.
 */
export function checkI6(
  report: RunReportView,
  options: { readonly boots: number; readonly explainedStates?: readonly string[] },
): InvariantResult {
  const problems: string[] = [];
  const explained = options.explainedStates ?? ['DONE'];
  if (report.timedOut) problems.push('the run did not end before its deadline');
  for (const play of report.plays) {
    if (!explained.includes(play.state)) {
      problems.push(`play ${play.id} is ${play.state} (expected ${explained.join(' or ')})`);
    }
  }
  if (report.recovered.length !== options.boots) {
    problems.push(
      `daemon.recovered came out ${String(report.recovered.length)} times for ${String(options.boots)} starts`,
    );
  }
  const seen = new Set<string>();
  for (const message of report.systemMessages) {
    const key = `${message.scenarioId ?? ''} ${JSON.stringify(message.payload)}`;
    if (seen.has(key))
      problems.push(`the scenario ${message.scenarioId ?? '?'} got the same message twice`);
    seen.add(key);
  }
  return result('I6', problems);
}

/** Names the harness allows to stay: the files SQLite keeps while a database is open or after a kill. */
export const DEFAULT_ALLOWED_LEFTOVERS: readonly RegExp[] = [/-wal$/, /-shm$/];

const LEFTOVER_PATTERNS: readonly RegExp[] = [/\.partial$/, /\.tmp$/, /\.new$/, /-journal$/];
const SKIPPED_DIRECTORIES = new Set(['.git', 'remote.git', 'node_modules']);

/**
 * I7: nothing temporary is left under `root`: no `.partial`, `.tmp`, `.new` or rollback journal
 * (`-journal`), except what `allowed` lists (by default the WAL files of SQLite).
 */
export function checkI7(input: {
  readonly root: string;
  readonly allowed?: readonly RegExp[];
}): InvariantResult {
  const allowed = input.allowed ?? DEFAULT_ALLOWED_LEFTOVERS;
  const problems: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (LEFTOVER_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        if (!allowed.some((pattern) => pattern.test(entry.name)))
          problems.push(`leftover: ${path}`);
      }
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
    }
  };
  if (existsSync(input.root)) walk(input.root);
  return result('I7', problems);
}

/** The types the reconciliation may write only once for the same scenario, play and payload. */
export const ONCE_EVENT_TYPES: readonly string[] = [
  'scenario.system_message',
  'delivery.completed',
];

/**
 * I8: the event log lost no event the harness saw confirmed (same id, same type), and the
 * reconciliation did not write the same event twice (`onceTypes`: same type, scenario, play and
 * payload).
 */
export function checkI8(input: {
  readonly storePath: string;
  readonly ledger: CommitLedger;
  readonly onceTypes?: readonly string[];
}): InvariantResult {
  const problems = [...missingFromStore(input.storePath, input.ledger).events];
  if (!existsSync(input.storePath)) return result('I8', problems);
  const once = input.onceTypes ?? ONCE_EVENT_TYPES;
  const db = openRead(input.storePath);
  try {
    const rows = db
      .prepare('SELECT id, type, scenario_id, play_id, payload FROM events ORDER BY id')
      .all() as {
      id: number;
      type: string;
      scenario_id: string | null;
      play_id: string | null;
      payload: string;
    }[];
    const first = new Map<string, number>();
    for (const row of rows) {
      if (!once.includes(row.type)) continue;
      const key = `${row.type}|${row.scenario_id ?? ''}|${row.play_id ?? ''}|${row.payload}`;
      const earlier = first.get(key);
      if (earlier === undefined) first.set(key, row.id);
      else problems.push(`event ${String(row.id)} (${row.type}) repeats event ${String(earlier)}`);
    }
  } finally {
    db.close();
  }
  return result('I8', problems);
}
