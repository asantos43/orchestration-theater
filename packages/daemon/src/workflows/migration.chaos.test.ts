// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRASHPOINT_LINE } from '../chaos/crash-points.js';
import { ChaosSlicer, resolveSeed, SeededRandom } from '../chaos/harness.js';
import {
  assertInvariants,
  checkI1,
  checkI2,
  checkI4,
  checkI5,
  checkI7,
  checkI8,
  CommitLedger,
  ONCE_EVENT_TYPES,
  type LedgerEntry,
} from '../chaos/invariants.js';
import {
  generateWorkflowPair,
  GENERATED_FROM_VERSION,
  GENERATED_TO_VERSION,
  type GeneratedEffect,
} from '../chaos/workflow-generator.test-support.js';
import { MIGRATION_CHILD_SCRIPT } from './workflow-migration-chaos-child-fixture.js';

/**
 * The `kill -9` acceptance of the migration at a safe point (N295; Phase 11b, P4; docs/24 §6). A
 * generated pair of workflow versions (`chaos/workflow-generator.test-support.ts`, from a seed) runs
 * in a process that is born in 1.0.0, asks its own migration to 1.1.0 from inside the gate step, and
 * is killed with `SIGKILL`: at the boundaries of an effect of the journal (before the gate, in 1.0.0,
 * and after it, in 1.1.0), at the commit of the very transaction that migrates the run, and inside the
 * gate right after the request is saved. Another process over the same on-disk store resumes the
 * run. Whatever the point, the run ends in 1.1.0, born in 1.0.0, migrated exactly once, with each
 * effect of the pair done exactly once, and the invariants of the harness hold after the kill and
 * after the restart. Runs over the build output (`pnpm build` first) and is part of `pnpm test:chaos`.
 *
 * Which invariants apply to a run of the generic engine (docs/23, docs/24 §6):
 * - I1 (the store is whole), I2 (a commit seen before the fall is there after), I5 (no effect left
 *   open without the Producer being asked), I7 (nothing temporary left) and I8 (no event lost, and
 *   `workflow.migrated`, `workflow.migration_refused` and `workflow.notified` written once) are
 *   checked with the functions of the harness;
 * - I4 (no external effect done twice) is checked on the world of the child, a file that holds one
 *   line per write, read as the journal of a code host would be;
 * - I3 (no process of the census alive) and I6 (the account of the reconciliation, `daemon.recovered`)
 *   are about the clients and the boot of the whole daemon, which this child does not have: what I6
 *   protects here, that the run ends and does not repeat what it told, is asserted directly (final
 *   state, one `workflow.migrated`, each message once).
 */

const DAEMON_DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const STORE_MODULE = pathToFileURL(
  fileURLToPath(new URL('../../../adapters/store-sqlite/dist/index.js', import.meta.url)),
).href;

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const SEED = resolveSeed();
const PAIR = generateWorkflowPair(SEED);

let dir = '';
beforeAll(() => {
  if (!existsSync(join(DAEMON_DIST, 'workflows', 'runtime.js'))) {
    throw new Error('The daemon is not built: run "pnpm build" before the chaos tests');
  }
  dir = mkdtempSync(join(tmpdir(), 'ot-wf-migration-chaos-'));
  writeFileSync(join(dir, 'child.mjs'), MIGRATION_CHILD_SCRIPT);
  writeFileSync(join(dir, 'definitions.json'), JSON.stringify({ from: PAIR.from, to: PAIR.to }));
});
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

const caseDir = (name: string): string => join(dir, name);
const storePath = (name: string): string => join(caseDir(name), 'store.sqlite');
const worldPath = (name: string): string => join(caseDir(name), 'world.txt');

function runChild(
  name: string,
  mode: 'first' | 'resume',
  extra: Readonly<Record<string, string>> = {},
): Promise<Exit> {
  mkdirSync(caseDir(name), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, 'child.mjs')], {
      env: {
        PATH: process.env.PATH ?? '',
        OT_CHILD_MODE: mode,
        OT_CHILD_DB: storePath(name),
        OT_CHILD_WORLD: worldPath(name),
        OT_CHILD_DEFINITIONS: join(dir, 'definitions.json'),
        OT_CHILD_DAEMON_DIST: DAEMON_DIST,
        OT_CHILD_STORE_MODULE: STORE_MODULE,
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The child did not end in time.\n${stdout}\n${stderr}`));
    }, 60_000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const worldOf = (name: string): string[] =>
  existsSync(worldPath(name))
    ? readFileSync(worldPath(name), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];

interface StoreView {
  readonly events: readonly { id: number; type: string; payload: Record<string, unknown> }[];
  readonly effects: readonly { key: string; state: string }[];
  readonly play:
    | {
        state: string;
        workflowVersion: string;
        bornVersion: string;
        migration: unknown;
      }
    | undefined;
}

/** What the store holds, read from outside (the process that wrote it is dead or ended). */
function readStore(name: string): StoreView {
  const db = new DatabaseSync(storePath(name));
  db.exec('PRAGMA query_only = ON');
  try {
    const events = (
      db
        .prepare(
          "SELECT id, type, payload FROM events WHERE play_id = 'run-1' OR play_id IS NULL ORDER BY id",
        )
        .all() as {
        id: number;
        type: string;
        payload: string;
      }[]
    ).map((row) => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
    const effects = (
      db
        .prepare('SELECT idempotency_key, state FROM side_effects ORDER BY idempotency_key')
        .all() as {
        idempotency_key: string;
        state: string;
      }[]
    ).map((row) => ({ key: row.idempotency_key, state: row.state }));
    const row = db.prepare("SELECT state, snapshot FROM plays WHERE id = 'run-1'").get() as
      { state: string; snapshot: string } | undefined;
    if (row === undefined) return { events, effects, play: undefined };
    const snapshot = JSON.parse(row.snapshot) as {
      workflow: { version: string };
      born: { version: string };
      runtime: { migration: unknown };
    };
    return {
      events,
      effects,
      play: {
        state: row.state,
        workflowVersion: snapshot.workflow.version,
        bornVersion: snapshot.born.version,
        migration: snapshot.runtime.migration,
      },
    };
  } finally {
    db.close();
  }
}

const count = (view: StoreView, type: string): number =>
  view.events.filter((event) => event.type === type).length;

/** What the harness saw confirmed before the fall: the commits found in the store after the kill. */
function confirmFromStore(name: string, ledger: CommitLedger): void {
  const view = readStore(name);
  const entries: LedgerEntry[] = [
    ...view.events.map((event): LedgerEntry => ({ kind: 'event', id: event.id, type: event.type })),
    ...view.effects.map((effect): LedgerEntry => ({ kind: 'side_effect', key: effect.key })),
  ];
  ledger.confirm(entries);
}

/** The write world as the journal of a code host: one entry per write, so I4 sees a repeat. */
const worldAsJournal = (name: string) =>
  worldOf(name).map((id) => ({ op: 'mergeBranch', opts: { head: id, base: 'world' } }));

function afterTheKill(name: string): CommitLedger {
  const ledger = new CommitLedger(join(caseDir(name), 'ledger.jsonl'));
  confirmFromStore(name, ledger);
  assertInvariants([checkI1({ dataDir: caseDir(name) })]);
  // The files of the store are the only thing in the folder: a kill leaves WAL files, nothing else.
  assertInvariants([checkI7({ root: caseDir(name) })]);
  return ledger;
}

function afterTheRestart(name: string, ledger: CommitLedger): void {
  const store = storePath(name);
  assertInvariants([
    checkI1({ dataDir: caseDir(name) }),
    checkI2({ storePath: store, ledger }),
    checkI4(worldAsJournal(name)),
    checkI5({ storePath: store }),
    checkI7({ root: caseDir(name) }),
    checkI8({
      storePath: store,
      ledger,
      onceTypes: [
        ...ONCE_EVENT_TYPES,
        'workflow.migrated',
        'workflow.migration_refused',
        'workflow.notified',
      ],
    }),
  ]);
}

/** What a run of the pair must be at the end, whatever the kill. */
function expectEnded(name: string): void {
  const view = readStore(name);
  expect(view.play).toEqual({
    state: 'done',
    workflowVersion: GENERATED_TO_VERSION,
    bornVersion: GENERATED_FROM_VERSION,
    migration: null,
  });
  // Migrated exactly once, from the landing node of the old version to its image in the new one.
  const migrated = view.events.filter((event) => event.type === 'workflow.migrated');
  expect(migrated).toHaveLength(1);
  expect(migrated[0]?.payload).toMatchObject({
    runId: 'run-1',
    from: { version: GENERATED_FROM_VERSION },
    to: { version: GENERATED_TO_VERSION },
    fromState: PAIR.landing.from,
    toState: PAIR.landing.to,
  });
  expect(count(view, 'workflow.migration_refused')).toBe(0);
  // Each message once, in order; each write once, in order (an effect never done twice, never lost).
  expect(
    view.events
      .filter((event) => event.type === 'workflow.notified')
      .map((event) => String(event.payload.message)),
  ).toEqual(PAIR.expectedMessages);
  expect(worldOf(name)).toEqual(PAIR.expectedWrites);
  // Nothing is left open in the journal (`not_done` is a settled verdict: the verifier saw the effect
  // had not happened, and the step did it again).
  expect(
    view.effects.filter((effect) => effect.state === 'pending' || effect.state === 'ambiguous'),
  ).toEqual([]);
}

/** Kills a run, checks the dead store, resumes it, checks the end, and starts a third time. */
async function killAndResume(
  name: string,
  extra: Readonly<Record<string, string>>,
  point: string,
  afterKill: (view: StoreView) => void,
): Promise<void> {
  const killed = await runChild(name, 'first', extra);
  expect(killed.signal, killed.stderr).toBe('SIGKILL');
  expect(killed.stdout).toContain(`${CRASHPOINT_LINE}{"point":"${point}"`);
  const ledger = afterTheKill(name);
  afterKill(readStore(name));

  const resumed = await runChild(name, 'resume');
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(resumed.stdout).toContain('RESUMED {"resumed":["run-1"],"refused":[]}');
  expect(resumed.stdout).toContain('FINAL done');
  afterTheRestart(name, ledger);
  expectEnded(name);

  // A third start finds nothing open and changes nothing.
  const before = readStore(name);
  const again = await runChild(name, 'resume');
  expect(again.code, again.stderr).toBe(0);
  expect(again.stdout).toContain('RESUMED {"resumed":[],"refused":[]}');
  expect(readStore(name)).toEqual(before);
  expect(worldOf(name)).toEqual(PAIR.expectedWrites);
}

const slicer = new ChaosSlicer();
const random = new SeededRandom(SEED);

function oneOf(type: GeneratedEffect['type']): GeneratedEffect {
  return random.pick(PAIR.effects.filter((effect) => effect.type === type));
}

function firstOfNewVersion(): GeneratedEffect {
  const found = PAIR.effects.find((effect) => effect.version === GENERATED_TO_VERSION);
  if (found === undefined) throw new Error('the generated pair has no effect in the new version');
  return found;
}

/**
 * The effects a kill is aimed at: a write and a notify (either version), and the first of the new
 * version. The same effect aimed at twice is one target (a case has a folder of its own).
 */
const TARGETS: readonly { label: string; effect: GeneratedEffect }[] = [
  { label: 'a write', effect: oneOf('demo.write') },
  { label: 'a notify', effect: oneOf('workflow.notify') },
  {
    label: 'the first effect of 1.1.0',
    effect: firstOfNewVersion(),
  },
].filter(
  (target, index, all) =>
    all.findIndex((other) => other.effect.token === target.effect.token) === index,
);

const EFFECT_POINTS: readonly { point: string; done: boolean }[] = [
  { point: 'effects.after_intend', done: false },
  { point: 'effects.after_execute', done: true },
  { point: 'effects.after_resolve', done: true },
];

describe(`a generated pair (seed ${String(SEED)}) killed with SIGKILL at an effect`, () => {
  const cases = TARGETS.flatMap(({ label, effect }) =>
    EFFECT_POINTS.map(({ point, done }) => ({ label, effect, point, done })),
  );

  for (const { label, effect, point, done } of cases) {
    it.runIf(slicer.has())(
      `at ${point} of ${label} (${effect.type} ${effect.token}, ${effect.version}): the run ends in 1.1.0, once`,
      async () => {
        const name = `effect-${point.split('.')[1] ?? point}-${effect.token}`;
        await killAndResume(
          name,
          {
            OT_CHILD_CRASH: JSON.stringify([{ point, detail: effect.type, nth: effect.nth }]),
          },
          point,
          () => {
            if (effect.type !== 'demo.write') return;
            // The kill is on this write: it is in the world exactly when the point is after its execute.
            expect(worldOf(name).includes(effect.token)).toBe(done);
          },
        );
      },
    );
  }
});

describe(`a generated pair (seed ${String(SEED)}) killed at the commit that migrates the run`, () => {
  const cases = [
    { point: 'store.before_commit', migrated: false },
    { point: 'store.after_commit', migrated: true },
  ];

  for (const { point, migrated } of cases) {
    it.runIf(slicer.has())(
      `at ${point}: the migration is whole or not at all, and the restart ends the run in 1.1.0`,
      async () => {
        const name = point.replace('.', '-');
        await killAndResume(name, { OT_CHILD_STORE_CRASH: point }, point, (view) => {
          // The migration and its event are one transaction: both are there or neither is.
          expect(count(view, 'workflow.migrated')).toBe(migrated ? 1 : 0);
          expect(view.play?.workflowVersion).toBe(
            migrated ? GENERATED_TO_VERSION : GENERATED_FROM_VERSION,
          );
          expect(view.play?.bornVersion).toBe(GENERATED_FROM_VERSION);
          // Not migrated: the request is still saved with the run, so the restart makes it.
          expect(view.play?.migration !== null).toBe(!migrated);
          expect(worldOf(name).every((id) => PAIR.expectedWrites.includes(id))).toBe(true);
        });
      },
    );
  }
});

describe(`a generated pair (seed ${String(SEED)}) killed with a migration waiting`, () => {
  const cases = [{ name: 'request' }];

  for (const { name } of cases) {
    it.runIf(slicer.has())(
      'dies in 1.0.0 right after the request was saved: the restart makes the migration',
      async () => {
        await killAndResume(
          name,
          { OT_CHILD_KILL_AFTER_REQUEST: '1' },
          'workflow.after_request',
          (view) => {
            expect(view.play?.workflowVersion).toBe(GENERATED_FROM_VERSION);
            expect(view.play?.migration).toEqual({
              toVersion: GENERATED_TO_VERSION,
              trigger: 'request',
            });
            expect(count(view, 'workflow.migrated')).toBe(0);
          },
        );
      },
    );
  }
});

describe(`a generated pair (seed ${String(SEED)}) with no kill`, () => {
  const cases = [{ name: 'plain' }];

  for (const { name } of cases) {
    it.runIf(slicer.has())(
      'the same program migrates and ends the run in one process',
      async () => {
        const first = await runChild(name, 'first');
        expect(first.code, first.stderr).toBe(0);
        expect(first.stdout).toContain('FINAL done');
        expectEnded(name);
        assertInvariants([
          checkI1({ dataDir: caseDir(name) }),
          checkI4(worldAsJournal(name)),
          checkI5({ storePath: storePath(name) }),
          checkI7({ root: caseDir(name) }),
        ]);
      },
    );
  }
});
