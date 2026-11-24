// SPDX-License-Identifier: MPL-2.0
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposeTestGitIsolation } from '@otheater/sdk';
import {
  assertHarnessBuilt,
  ChaosRig,
  resolveSeed,
  SeededRandom,
  type RunReport,
} from './harness.js';
import { dataPaths } from '../paths.js';
import { aliveEntries, isAlive } from './census.js';
import { checkI3 } from './invariants.js';
import {
  API_LINE,
  ChatSocket,
  chaosInstants,
  crashDaemon,
  playCount,
  recentEvents,
  restartDaemon,
  startDaemon,
  SCENARIO_A_CHILD_SCRIPT,
  SCENARIO_LINE,
  waitForFile,
  type Crashed,
  verdictAfter,
} from './scenario-a-fixture.js';

/**
 * Chaos A, the daemon killed in the middle of a play (Phase 11, P3; docs/23). Each test starts the
 * daemon as a process (the P1 harness, with the fake agent and the fake code host), kills it, starts
 * another on the same folder, and checks the invariants I1 to I8: at the named points of the
 * catalogue, at 50 random instants, in the window between a client being launched and its pid being
 * written, with the chat connected through the API, and with wakeups waiting. The seed is printed
 * (`OT_CHAOS_SEED` repeats it) and the number of instants is `OT_CHAOS_INSTANTS` (default 50).
 * The runs use the build output of the daemon: `pnpm build` comes first.
 */

beforeAll(assertHarnessBuilt);
afterAll(disposeTestGitIsolation);

const SEED = resolveSeed(process.env, 20_261_124);
const MINUTE = 60_000;
const STEP_MS = 150_000;
let instantsMs = 0;
let instantsRun = 0;
let instantsWithoutPlay = 0;

/** The kills in the first start of a play: the point is reached by the first run. */
const FIRST_START_POINTS: readonly string[] = [
  'effects.before_intend:open_pr',
  'effects.after_intend:open_pr',
  'effects.after_execute:open_pr',
  'effects.after_resolve:open_pr',
  'effects.after_execute:git_push',
  'store.before_commit#4',
  'store.after_commit#4',
];

/**
 * The kills in the recovery itself: the first start dies with an effect pending
 * (`effects.after_execute:open_pr`), and the second one dies at the point, in the middle of the
 * reconciliation.
 */
const RECOVERY_POINTS: readonly string[] = [
  'reconcile.before_orphans',
  'reconcile.after_orphans',
  'reconcile.before_worktrees',
  'reconcile.after_worktrees',
  'reconcile.before_effects',
  'reconcile.before_effect_resolve:open_pr',
  'reconcile.after_effects',
];

const PENDING_EFFECT = 'effects.after_execute:open_pr';

// `effects.after_verify` is not here: the reconciliation settles a pending effect whose verdict is
// `done` or `not_done` itself (`reconcile.settleEffects`), and `runEffect` reaches that point only
// for a verdict it settles on its own, which a restart never leaves for it. The point is covered at
// unit level by `points.test.ts` (P1); see "Como ficou" of P3 in docs/23.

describe.skipIf(process.platform !== 'linux')(
  'chaos A: the daemon killed in the middle of a play',
  { timeout: 10 * MINUTE },
  () => {
    describe('at the named points of the first run', () => {
      it.each(FIRST_START_POINTS)('%s', async (spec) => {
        const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
        try {
          const killed = await crashDaemon(rig, { mode: 'first', point: spec });
          expect(killed.signal).toBe('SIGKILL');
          expect(killed.crash?.point).toBe(spec.split(/[:#]/)[0]);
          const report = await restartDaemon(rig);
          verdictAfter(rig, [killed], report);
        } finally {
          await rig.dispose();
        }
      });
    });

    describe('at the named points of the recovery (a kill during the reconciliation)', () => {
      it.each(RECOVERY_POINTS)('%s', async (spec) => {
        const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
        try {
          const first = await rig.killAtPoint(PENDING_EFFECT);
          const second = await rig.killAtPoint(spec, 'resume');
          expect(second.signal).toBe('SIGKILL');
          expect(second.crash?.point).toBe(spec.split(/[:#]/)[0]);
          const report = await rig.restart();
          verdictAfter(rig, [first, second], report);
        } finally {
          await rig.dispose();
        }
      });
    });

    describe('at random instants of the first run', () => {
      const instants = chaosInstants();
      // The play of the fake agent takes about ten seconds; the range goes a little past its end,
      // so some of the instants land when it is done and the daemon is idle.
      const RANGE_MS = 12_000;

      afterAll(() => {
        process.stderr.write(
          `[chaos] ${String(instants)} random instants: ${String(Math.round(instantsMs / 1000))} s in all (${String(Math.round(instantsMs / Math.max(1, instantsRun)))} ms each), ${String(instantsWithoutPlay)} before the first play\n`,
        );
      });

      it.each(Array.from({ length: instants }, (_, index) => index))(
        'instant %i',
        { timeout: 5 * MINUTE },
        async (index) => {
          const seed = (SEED + index * 7919) >>> 0;
          const delayMs = new SeededRandom(seed).int(0, RANGE_MS);
          const started = Date.now();
          const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
          try {
            const killed = await crashDaemon(rig, { mode: 'first', delayMs });
            expect(killed.signal).toBe('SIGKILL');
            if (playCount(rig.storePath) === 0) instantsWithoutPlay += 1;
            const report = await restartDaemon(rig);
            try {
              verdictAfter(rig, [killed], report, { atLeastOneBoot: false });
            } catch (error) {
              throw new Error(
                `instant ${String(index)}: killed ${String(delayMs)} ms after STARTED (seed ${String(seed)}; OT_CHAOS_SEED=${String(SEED)}): ${String(error)}\n${recentEvents(rig.storePath)}`,
                { cause: error },
              );
            }
          } finally {
            await rig.dispose();
            instantsMs += Date.now() - started;
            instantsRun += 1;
          }
        },
      );
    });

    describe('in the window between a client being launched and its pid being written (I3)', () => {
      /** Starts a daemon that holds the client launch `skip` after the process exists and before its pid is written. */
      async function killInWindow(
        rig: ChaosRig,
        skip: number,
      ): Promise<{ crashed: Crashed; pid: number }> {
        const gate = join(rig.runDir, 'window-gate');
        const child = rig.start({
          mode: 'first',
          env: {
            // The gate before the launch never holds; the one after it does.
            OT_CHILD_HOLD_LAUNCH: join(rig.runDir, 'unused-gate'),
            OT_CHILD_HOLD_AFTER: '1000000',
            OT_CHILD_WINDOW_GATE: gate,
            OT_CHILD_WINDOW_SKIP: String(skip),
          },
        });
        await waitForFile(`${gate}.spawned`);
        const pid = Number(readFileSync(`${gate}.spawned`, 'utf8').trim().split('\n').at(-1));
        // The process exists and the row that tracks it has no pid yet: the window of the defect.
        expect(isAlive(pid)).toBe(true);
        const db = new DatabaseSync(rig.storePath);
        try {
          const rows = db.prepare("SELECT pid FROM sessions WHERE state = 'active'").all() as {
            pid: number | null;
          }[];
          expect(rows.some((row) => row.pid === null)).toBe(true);
          expect(rows.some((row) => row.pid === pid)).toBe(false);
        } finally {
          db.close();
        }
        child.process.kill('SIGKILL');
        const exit = await child.exited;
        return {
          crashed: { signal: exit.signal, census: rig.census() },
          pid,
        };
      }

      it.each([0, 1, 2])(
        'the client launched at position %i is found by its marker and ended',
        async (skip) => {
          const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
          try {
            const { crashed, pid } = await killInWindow(rig, skip);
            expect(crashed.signal).toBe('SIGKILL');
            // The orphan is real: the census (the /proc scan) finds it alive after the kill.
            expect(aliveEntries(crashed.census).map((entry) => entry.pid)).toContain(pid);
            const report = await restartDaemon(rig);
            expect(isAlive(pid)).toBe(false);
            verdictAfter(rig, [crashed], report, { atLeastOneBoot: false });
            expect(report.recovered.at(-1)?.orphansKilled).toBeGreaterThanOrEqual(1);
          } finally {
            await rig.dispose();
          }
        },
      );

      it('with recovery.orphans: report the same orphan is left alone and the notice says so (I3 fails, as it must)', async () => {
        const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
        try {
          const { crashed, pid } = await killInWindow(rig, 0);
          const report = await restartDaemon(rig, { OT_CHILD_ORPHANS: 'report' });
          expect(isAlive(pid)).toBe(true);
          expect(checkI3(crashed.census).ok).toBe(false);
          expect(report.recovered.at(-1)?.orphansKilled).toBe(0);
          const db = new DatabaseSync(rig.storePath);
          try {
            const notices = db
              .prepare("SELECT payload FROM events WHERE type = 'recovery.notice'")
              .all() as { payload: string }[];
            expect(notices.some((row) => row.payload.includes('"orphan_left"'))).toBe(true);
          } finally {
            db.close();
          }
        } finally {
          await rig.dispose();
        }
      });
    });

    it('the chat through the API: the connection is cut with the daemon and comes back to the next one', async () => {
      const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
      try {
        const first = startDaemon(rig, 'chat');
        const api = (await first.line(API_LINE, STEP_MS)) as { url: string };
        const { scenarioId } = (await first.line(SCENARIO_LINE, STEP_MS)) as { scenarioId: string };
        const token = (await readFile(dataPaths(rig.dataDir).apiToken, 'utf8')).trim();
        const before = await ChatSocket.open({ apiUrl: api.url, token, scenarioId });
        // The Producer asks for a play through the chat itself.
        before.send({ type: 'message', text: '#ot-play write alpha and beta #outcome:approved' });
        await before.until('the first state', () => before.frames[0]);
        const deadline = Date.now() + STEP_MS;
        while (playCount(rig.storePath) === 0) {
          if (Date.now() > deadline) throw new Error('the play was never written');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const cursor = before.cursor;
        // The daemon dies: the connection is cut without a close frame.
        first.process.kill('SIGKILL');
        await first.exited;
        expect(await before.closed).not.toBe(1000);
        const census = rig.census();

        // The next daemon, on the same folder, keeps its API up until the test is done with it.
        const keepUp = join(rig.runDir, 'keep-up');
        const second = startDaemon(rig, 'resume', undefined, { OT_CHILD_KEEP_UP: keepUp });
        const api2 = (await second.line(API_LINE, STEP_MS)) as { url: string };
        const report = (await second.line('REPORT ', STEP_MS)) as RunReport;
        const after = await ChatSocket.open({
          apiUrl: api2.url,
          token: (await readFile(dataPaths(rig.dataDir).apiToken, 'utf8')).trim(),
          scenarioId,
          lastEventId: cursor,
        });
        // What the chat said while it was cut (the events of the store after the cursor) comes, once.
        const db = new DatabaseSync(rig.storePath);
        let missed: number[];
        try {
          missed = (
            db
              .prepare(
                "SELECT id FROM events WHERE scenario_id = ? AND id > ? AND type IN ('chat.director_reply', 'chat.ask') ORDER BY id",
              )
              .all(scenarioId, cursor) as { id: number }[]
          ).map((row) => row.id);
        } finally {
          db.close();
        }
        await after.until('what it missed', () =>
          missed.every((id) => after.frames.some((frame) => frame.eventId === id))
            ? true
            : undefined,
        );
        const delivered = after.frames
          .filter((frame) => frame.type === 'director_reply' || frame.type === 'ask')
          .map((frame) => frame.eventId);
        expect(new Set(delivered).size).toBe(delivered.length);
        expect(delivered.every((id) => id > cursor)).toBe(true);
        // And it is a live socket: a message of the Producer goes through the next daemon.
        after.send({ type: 'message', text: '#ot-chat still here' });
        await after.until('a reply', () =>
          after.frames.find((frame) => frame.type === 'director_reply' && frame.eventId > cursor),
        );
        after.close();
        writeFileSync(keepUp, '');
        await second.exited;
        verdictAfter(rig, [{ census }], report, { atLeastOneBoot: false });
      } finally {
        await rig.dispose();
      }
    });

    it('wakeups of quota and budget (the scheduling of N285) written before a kill in the recovery fire once', async () => {
      const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
      try {
        const first = await crashDaemon(rig, { mode: 'first', point: PENDING_EFFECT });
        // Due wakeups of a quota and of a budget cap of the same profile, as the daemon wrote them.
        const db = new DatabaseSync(rig.storePath);
        try {
          const insert = db.prepare(
            "INSERT INTO wakeups (id, seq, profile_id, cause, at, state, os_trigger_id, created_at, updated_at) VALUES (?, ?, 'fake/one', ?, 1, 'scheduled', NULL, 1, 1)",
          );
          insert.run('W1', 1, 'quota');
          insert.run('W2', 2, 'budget');
        } finally {
          db.close();
        }
        // The second start dies in the reconciliation, before the wakeups are settled.
        const second = await crashDaemon(rig, { mode: 'resume', point: 'reconcile.after_effects' });
        const report = await restartDaemon(rig);
        verdictAfter(rig, [first, second], report);
        const check = new DatabaseSync(rig.storePath);
        try {
          const rows = check.prepare('SELECT id, cause, state FROM wakeups ORDER BY seq').all() as {
            id: string;
            cause: string;
            state: string;
          }[];
          expect(rows).toEqual([
            { id: 'W1', cause: 'quota', state: 'fired' },
            { id: 'W2', cause: 'budget', state: 'fired' },
          ]);
        } finally {
          check.close();
        }
      } finally {
        await rig.dispose();
      }
    });

    // The scheduler of scheduled tasks is Phase 9b: until it exists there is nothing to kill. The
    // scenario is written down here so the day it lands the test only needs its body.
    const SCHEDULED_TASKS_EXIST = false;
    it.skipIf(!SCHEDULED_TASKS_EXIST)(
      'a scheduled task that fell due while the daemon was dead runs once on the next start (Phase 9b)',
      () => {
        // 1. Schedule a task for an instant a little ahead, through the API (the Phase 9b route).
        // 2. Kill the daemon before the instant (`crashDaemon`), then wait for the instant to pass.
        // 3. Start the daemon again: the task runs exactly once (one play for it, I4: no external
        //    effect twice), and a second restart does not run it again.
        // 4. Check I1 to I8 as the other scenarios do.
        expect.fail('Phase 9b: the scheduler of scheduled tasks does not exist yet');
      },
    );
  },
);
