// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { assertHarnessBuilt, ChaosRig, resolveSeed, SeededRandom } from './harness.js';
import {
  chaosInstants,
  crashDaemon,
  playCount,
  restartDaemon,
  SCENARIO_A_CHILD_SCRIPT,
  verdictAfter,
  type Crashed,
} from './scenario-a-fixture.js';

/**
 * Chaos A, a power loss (Phase 11, P3; docs/23). Two levels, both at the named points of the
 * catalogue and at 50 random instants (`OT_CHAOS_INSTANTS`):
 *
 * - level i: every process of the run dies at once (the daemon and the clients, by SIGKILL), so no
 *   client is left to be found as an orphan and the store is left as the kill left it;
 * - level ii: besides that, the store is torn: the copy of the `.db` taken at the kill, the `-wal`
 *   cut inside its last commit (never below what the ledger of I2 saw confirmed) and the `-shm`
 *   deleted (see `torn-store.ts`).
 *
 * What SQLite promises with `synchronous = FULL` is that a power loss can only take the commit that
 * was in flight; the tests check that the daemon starts on what is left and keeps I1 to I8. Real
 * power loss (the kernel dropping pages that were never fsynced) is not simulated: it needs a VM or a
 * fault-injecting file system, and stays [N] (docs/23, Limits).
 */

beforeAll(assertHarnessBuilt);
afterAll(disposeTestGitIsolation);

const SEED = resolveSeed(process.env, 20_261_125);
const MINUTE = 60_000;

const FIRST_START_POINTS: readonly string[] = [
  'effects.before_intend:open_pr',
  'effects.after_intend:open_pr',
  'effects.after_execute:open_pr',
  'effects.after_resolve:open_pr',
  'effects.after_execute:git_push',
  'store.before_commit#4',
  'store.after_commit#4',
];

/** Second kill, in the reconciliation of the first start that was left with an effect pending. */
const RECOVERY_POINTS: readonly string[] = [
  'reconcile.before_orphans',
  'reconcile.before_worktrees',
  'reconcile.before_effects',
  'reconcile.before_effect_resolve:open_pr',
  'reconcile.after_effects',
];

const PENDING_EFFECT = 'effects.after_execute:open_pr';
const RANGE_MS = 12_000;

function seedOf(index: number): number {
  return (SEED + index * 104_729) >>> 0;
}

for (const level of [
  { name: 'level i: the whole tree dies at once', torn: false },
  { name: 'level ii: the whole tree dies and the store is torn', torn: true },
] as const) {
  describe.skipIf(process.platform !== 'linux')(`chaos A, power loss, ${level.name}`, () => {
    const instants = chaosInstants();
    const stats = { runs: 0, torn: 0, lostBytes: 0, ms: 0 };

    afterAll(() => {
      process.stderr.write(
        `[chaos] ${level.name}: ${String(stats.runs)} instants in ${String(Math.round(stats.ms / 1000))} s; ` +
          `${String(stats.torn)} tears took bytes of the WAL (${String(stats.lostBytes)} in all)\n`,
      );
    });

    function crashSpec(
      seed: number,
      extra: { mode: 'first' | 'resume'; point?: string; delayMs?: number },
    ) {
      return { ...extra, wholeTree: true, ...(level.torn ? { tearSeed: seed } : {}) };
    }

    function count(killed: Crashed): void {
      stats.runs += 1;
      if (killed.tear !== undefined && killed.tear.keptBytes < killed.tear.walBytes) {
        stats.torn += 1;
        stats.lostBytes += killed.tear.walBytes - killed.tear.keptBytes;
      }
    }

    describe('at the named points', { timeout: 10 * MINUTE }, () => {
      it.each(FIRST_START_POINTS)('%s', async (point) => {
        const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
        try {
          const killed = await crashDaemon(
            rig,
            crashSpec(seedOf(point.length), { mode: 'first', point }),
          );
          expect(killed.crash?.point).toBe(point.split(/[:#]/)[0]);
          count(killed);
          const report = await restartDaemon(rig);
          verdictAfter(rig, [killed], report);
        } finally {
          await rig.dispose();
        }
      });

      it.each(RECOVERY_POINTS)('the second start dies at %s', async (point) => {
        const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
        try {
          const first = await crashDaemon(
            rig,
            crashSpec(seedOf(1), { mode: 'first', point: PENDING_EFFECT }),
          );
          const second = await crashDaemon(
            rig,
            crashSpec(seedOf(point.length), { mode: 'resume', point }),
          );
          expect(second.crash?.point).toBe(point.split(/[:#]/)[0]);
          count(first);
          count(second);
          const report = await restartDaemon(rig);
          verdictAfter(rig, [first, second], report);
        } finally {
          await rig.dispose();
        }
      });
    });

    describe('at random instants', () => {
      it.each(Array.from({ length: instants }, (_, index) => index))(
        'instant %i',
        { timeout: 5 * MINUTE },
        async (index) => {
          const seed = seedOf(index);
          const delayMs = new SeededRandom(seed).int(0, RANGE_MS);
          const started = Date.now();
          const rig = await ChaosRig.create({ script: SCENARIO_A_CHILD_SCRIPT });
          try {
            const killed = await crashDaemon(rig, crashSpec(seed, { mode: 'first', delayMs }));
            count(killed);
            const plays = playCount(rig.storePath);
            const report = await restartDaemon(rig);
            try {
              verdictAfter(rig, [killed], report, { atLeastOneBoot: false });
            } catch (error) {
              throw new Error(
                `instant ${String(index)}: killed ${String(delayMs)} ms after STARTED, ${String(plays)} plays in the store, tear ${JSON.stringify(killed.tear)} (seed ${String(seed)}; OT_CHAOS_SEED=${String(SEED)}): ${String(error)}`,
                { cause: error },
              );
            }
          } finally {
            await rig.dispose();
            stats.ms += Date.now() - started;
          }
        },
      );
    });
  });
}
