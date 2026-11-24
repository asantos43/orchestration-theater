// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Census } from './census.js';
import {
  assertInvariants,
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  checkI8,
  CommitLedger,
  readCodeHostJournal,
  type CodeHostJournalEntry,
  type RunReportView,
} from './invariants.js';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ot-invariants-'));
  storePath = join(dir, 'store.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(sql: string): void {
  const db = new DatabaseSync(storePath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT, scenario_id TEXT, play_id TEXT, payload TEXT);
     CREATE TABLE IF NOT EXISTS side_effects (idempotency_key TEXT PRIMARY KEY, type TEXT, state TEXT);
     CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, kind TEXT, input TEXT);
     ${sql}`,
  );
  db.close();
}

describe('assertInvariants', () => {
  it('is silent when every result passed, and names each problem when not', () => {
    expect(() => {
      assertInvariants([checkI7({ root: dir })]);
    }).not.toThrow();
    writeFileSync(join(dir, 'a.partial'), '');
    expect(() => {
      assertInvariants([checkI7({ root: dir }), checkI1({ dataDir: dir })]);
    }).toThrow(/I7 failed:[\s\S]*a\.partial/);
  });
});

describe('I1: the database is whole', () => {
  it('passes for a good store and for a file that does not exist yet', () => {
    expect(checkI1({ dataDir: dir }).ok).toBe(true);
    store('');
    expect(checkI1({ dataDir: dir }).ok).toBe(true);
  });

  it('fails for a file that is not a database', () => {
    writeFileSync(storePath, 'this is not sqlite, it is only text that is long enough '.repeat(40));
    const verdict = checkI1({ dataDir: dir });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('store.sqlite');
  });

  it('checks the backups too', () => {
    const backup = join(dir, 'backup.sqlite');
    writeFileSync(backup, 'garbage '.repeat(500));
    expect(checkI1({ dataDir: dir, backups: [backup] }).ok).toBe(false);
  });
});

describe('I2 and I8: no confirmed commit is lost', () => {
  it('pass when the ledger is in the store, and fail naming what is gone or changed', () => {
    store(
      "INSERT INTO events VALUES (1, 'a.b', NULL, NULL, '{}'), (2, 'c.d', NULL, NULL, '{}'); INSERT INTO side_effects VALUES ('k1', 'git_push', 'done');",
    );
    const ledger = new CommitLedger(join(dir, 'ledger.jsonl'));
    ledger.confirm([
      { kind: 'event', id: 1, type: 'a.b' },
      { kind: 'side_effect', key: 'k1' },
    ]);
    expect(checkI2({ storePath, ledger }).ok).toBe(true);
    expect(checkI8({ storePath, ledger }).ok).toBe(true);

    ledger.confirm([
      { kind: 'event', id: 9, type: 'x.y' },
      { kind: 'event', id: 2, type: 'wrong.type' },
      { kind: 'side_effect', key: 'k2' },
    ]);
    const i2 = checkI2({ storePath, ledger });
    expect(i2.ok).toBe(false);
    expect(i2.problems).toEqual([
      'event 9 (x.y) is gone',
      'event 2 was wrong.type and is now c.d',
      'side effect k2 is gone',
    ]);
    expect(checkI8({ storePath, ledger }).problems).toHaveLength(2);
  });

  it('a missing store fails only when something was confirmed', () => {
    const ledger = new CommitLedger(join(dir, 'ledger.jsonl'));
    expect(checkI2({ storePath, ledger }).ok).toBe(true);
    ledger.confirm([{ kind: 'event', id: 1, type: 'a.b' }]);
    expect(checkI2({ storePath, ledger }).problems[0]).toContain('does not exist');
  });

  it('I8 also fails for the same one-time event written twice', () => {
    store(
      `INSERT INTO events VALUES
        (1, 'scenario.system_message', 's1', NULL, '{"t":"x"}'),
        (2, 'scenario.system_message', 's1', NULL, '{"t":"x"}'),
        (3, 'scenario.system_message', 's2', NULL, '{"t":"x"}'),
        (4, 'other.type', 's1', NULL, '{"t":"x"}'),
        (5, 'other.type', 's1', NULL, '{"t":"x"}');`,
    );
    const ledger = new CommitLedger(join(dir, 'ledger.jsonl'));
    const verdict = checkI8({ storePath, ledger });
    expect(verdict.problems).toEqual(['event 2 (scenario.system_message) repeats event 1']);
  });

  it('I8 allows the same message once per start (two crashes in a row resume the same play)', () => {
    store(
      `INSERT INTO events VALUES
        (1, 'daemon.recovered', NULL, NULL, '{}'),
        (2, 'scenario.system_message', 's1', NULL, '{"t":"x"}'),
        (3, 'daemon.recovered', NULL, NULL, '{}'),
        (4, 'scenario.system_message', 's1', NULL, '{"t":"x"}'),
        (5, 'scenario.system_message', 's1', NULL, '{"t":"x"}');`,
    );
    const ledger = new CommitLedger(join(dir, 'ledger.jsonl'));
    expect(checkI8({ storePath, ledger }).problems).toEqual([
      'event 5 (scenario.system_message) repeats event 4',
    ]);
  });
});

describe('I3: no process of the census is alive', () => {
  it('passes for a pid that is not there and fails for one that is', () => {
    const gone: Census = {
      entries: [{ pid: 2 ** 22 + 777, source: 'pid-file', detail: 'pids/x.pid' }],
    };
    expect(checkI3(gone).ok).toBe(true);
    const alive: Census = {
      entries: [{ pid: process.pid, source: 'proc', detail: 'command line' }],
    };
    const verdict = checkI3(alive);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toContain(`pid ${String(process.pid)} is alive`);
  });
});

describe('I4: no external effect twice', () => {
  const pr = (head: string): CodeHostJournalEntry => ({
    op: 'openPullRequest',
    opts: { head, base: 'main' },
  });
  const push = (branch: string, sha: string): CodeHostJournalEntry => ({
    op: 'pushRef',
    target: { repo: '/r', branch },
    sha,
  });

  it('passes for one PR, one merge and a push repeated with the same commit', () => {
    expect(
      checkI4([
        pr('a'),
        pr('b'),
        { op: 'mergeBranch', opts: { head: 'a', base: 'main' } },
        push('a', '1'),
        push('a', '1'),
      ]).ok,
    ).toBe(true);
  });

  it('fails for a second PR, a second merge and a branch pushed with two commits', () => {
    const verdict = checkI4([
      pr('a'),
      pr('a'),
      { op: 'mergeBranch', opts: { head: 'a', base: 'main' } },
      { op: 'mergeBranch', opts: { head: 'a', base: 'main' } },
      push('a', '1'),
      push('a', '2'),
    ]);
    expect(verdict.problems).toEqual([
      'openPullRequest a -> main happened 2 times',
      'mergeBranch a -> main happened 2 times',
      '/r#a was pushed with 2 different commits',
    ]);
  });

  it('reads the journal file, line by line', () => {
    const path = join(dir, 'journal.jsonl');
    writeFileSync(path, `${JSON.stringify(pr('a'))}\n\n${JSON.stringify(pr('b'))}\n`);
    expect(readCodeHostJournal(path)).toHaveLength(2);
    expect(readCodeHostJournal(join(dir, 'none.jsonl'))).toEqual([]);
  });
});

describe('I5: an open effect has a question for the Producer', () => {
  it('passes when settled or asked, and fails when open and not asked', () => {
    store(
      `INSERT INTO side_effects VALUES ('k-done', 'git_push', 'done'), ('k-asked', 'open_pr', 'ambiguous'), ('k-lost', 'git_push', 'pending');
       INSERT INTO decisions VALUES ('d1', 'recovery_effect', 'The effect k-asked is ambiguous');`,
    );
    const verdict = checkI5({ storePath });
    expect(verdict.problems).toEqual(['git_push k-lost is pending and the Producer was not asked']);
    expect(checkI5({ storePath: join(dir, 'none.sqlite') }).ok).toBe(true);
  });
});

describe('I6: the play ends and the account came out once per start', () => {
  const good: RunReportView = {
    timedOut: false,
    plays: [{ id: 'p1', state: 'DONE' }],
    recovered: [{}, {}],
    systemMessages: [{ scenarioId: 's1', payload: { a: 1 } }],
  };

  it('passes for a play that ended and one account per start', () => {
    expect(checkI6(good, { boots: 2 }).ok).toBe(true);
    expect(
      checkI6(
        { ...good, plays: [{ id: 'p1', state: 'DELIVERING' }] },
        { boots: 2, explainedStates: ['DELIVERING'] },
      ).ok,
    ).toBe(true);
  });

  it('fails for a timeout, an unexplained state, a missing or repeated account and a repeated message', () => {
    const verdict = checkI6(
      {
        timedOut: true,
        plays: [{ id: 'p1', state: 'DELIVERING' }],
        recovered: [{}],
        systemMessages: [
          { scenarioId: 's1', payload: { a: 1 } },
          { scenarioId: 's1', payload: { a: 1 } },
        ],
      },
      { boots: 2 },
    );
    expect(verdict.problems).toHaveLength(4);
  });

  it('allows the same message once per start, and fails for a repeat within one start', () => {
    const base = { timedOut: false, plays: [{ id: 'p1', state: 'DONE' }], recovered: [{}, {}] };
    const message = { scenarioId: 's1', payload: { a: 1 } };
    expect(
      checkI6(
        {
          ...base,
          systemMessages: [
            { ...message, boot: 1 },
            { ...message, boot: 2 },
          ],
        },
        { boots: 2 },
      ).ok,
    ).toBe(true);
    expect(
      checkI6(
        {
          ...base,
          systemMessages: [
            { ...message, boot: 2 },
            { ...message, boot: 2 },
          ],
        },
        { boots: 2 },
      ).problems,
    ).toEqual(['the scenario s1 got the same message twice in one start']);
  });
});

describe('I7: nothing temporary is left', () => {
  it('allows the WAL files and fails for the rest, skipping .git and node_modules', () => {
    writeFileSync(join(dir, 'store.sqlite-wal'), '');
    writeFileSync(join(dir, 'store.sqlite-shm'), '');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'x.tmp'), '');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'copy.new'), '');
    writeFileSync(join(dir, 'sub', 'db-journal'), '');
    writeFileSync(join(dir, 'update.partial'), '');
    const verdict = checkI7({ root: dir });
    expect(verdict.problems.map((problem) => problem.replace(dir, ''))).toEqual(
      expect.arrayContaining([
        'leftover: /sub/copy.new',
        'leftover: /sub/db-journal',
        'leftover: /update.partial',
      ]),
    );
    expect(verdict.problems).toHaveLength(3);
    expect(checkI7({ root: dir, allowed: [/\.partial$/, /\.new$/, /-journal$/] }).ok).toBe(true);
  });
});
