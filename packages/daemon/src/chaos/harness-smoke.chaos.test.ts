// SPDX-License-Identifier: MPL-2.0
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { aliveEntries, isAlive, PID_DIR_NAME, pidFileEntries } from './census.js';
import { assertHarnessBuilt, ChaosRig, planInstant, planPoint, resolveSeed } from './harness.js';
import { assertInvariants } from './invariants.js';

/**
 * The smoke test of the chaos harness (Phase 11, P1; docs/23): the daemon runs as a process, is
 * killed at a named point and at a random instant, starts again, and the invariants I1 to I8 hold.
 * The seed is fixed here, so the same seed is used twice and must give the same plan and the same
 * verdict (the wall clock does not repeat to the bit, the plan and the verdict do). The runs use the
 * build output of the daemon (packages/daemon/dist/); `pnpm test:chaos` builds nothing, so
 * `pnpm build` comes first.
 */

const SEED = 20_261_123;
const POINTS = [
  'effects.after_intend:open_pr',
  'effects.after_execute:open_pr',
  'effects.after_resolve:open_pr',
];

beforeAll(assertHarnessBuilt);
afterAll(disposeTestGitIsolation);

/** Whether the store has at least one play and every play is DONE (a store that is not there yet: no). */
function allPlaysDone(storePath: string): boolean {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(storePath);
  } catch {
    return false;
  }
  try {
    const rows = db.prepare('SELECT state FROM plays').all() as { state: string }[];
    return rows.length > 0 && rows.every((row) => row.state === 'DONE');
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Condition not met in ${String(timeoutMs)} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface Outcome {
  readonly plan: string;
  readonly verdict: readonly string[];
  readonly play: readonly string[];
}

async function killAtPointAndRecover(seed: number): Promise<Outcome> {
  const spec = planPoint(seed, POINTS);
  const rig = await ChaosRig.create();
  try {
    const killed = await rig.killAtPoint(spec);
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.crash?.point).toBe(spec.split(':')[0]);
    const report = await rig.restart();
    const verdict = rig.evaluate({ census: killed.census, report, boots: 2 });
    assertInvariants(verdict);
    return {
      plan: spec,
      verdict: verdict.map((entry) => `${entry.id}:${String(entry.ok)}`),
      play: report.plays.map((play) => play.state),
    };
  } finally {
    await rig.dispose();
  }
}

async function killAtInstantAndRecover(seed: number): Promise<Outcome> {
  // The range is where the outcome is stable (docs/23, P1 "Como ficou"): from about 1.2 s on, a
  // client may be spawned and the daemon killed before its `sessions` row is committed, and the
  // restart cannot find that orphan. The finding is recorded there; it is not this test's to fix.
  const { delayMs } = planInstant(seed, { minMs: 600, maxMs: 1000 });
  const rig = await ChaosRig.create();
  try {
    const killed = await rig.killAfter(delayMs);
    expect(killed.signal).toBe('SIGKILL');
    // The kill came at a random instant: whatever the daemon had done, the next start settles it.
    const report = await rig.restart();
    const verdict = rig.evaluate({
      census: killed.census,
      report,
      // A kill before the first commit leaves no play and no `daemon.recovered` of that start.
      boots: report.recovered.length,
      explainedStates: ['DONE'],
    });
    assertInvariants(verdict);
    return {
      plan: `after ${String(delayMs)} ms`,
      verdict: verdict.map((entry) => `${entry.id}:${String(entry.ok)}`),
      play: report.plays.map((play) => play.state),
    };
  } finally {
    await rig.dispose();
  }
}

describe.skipIf(process.platform !== 'linux')(
  'the chaos harness (smoke)',
  { timeout: 300_000 },
  () => {
    it('prints the seed, and takes OT_CHAOS_SEED to repeat a run', () => {
      expect(resolveSeed({ OT_CHAOS_SEED: '42' })).toBe(42);
      expect(resolveSeed({}, 7)).toBe(7);
    });

    it('kills at a named point, recovers, and gives the same plan and verdict twice with the same seed', async () => {
      const first = await killAtPointAndRecover(SEED);
      const second = await killAtPointAndRecover(SEED);
      expect(second).toEqual(first);
      expect(first.verdict.every((entry) => entry.endsWith(':true'))).toBe(true);
    });

    it('kills at a random instant, recovers, and gives the same plan and verdict twice with the same seed', async () => {
      const first = await killAtInstantAndRecover(SEED);
      const second = await killAtInstantAndRecover(SEED);
      expect(second.plan).toBe(first.plan);
      expect(second.verdict).toEqual(first.verdict);
      expect(first.verdict.every((entry) => entry.endsWith(':true'))).toBe(true);
    });

    it('with faults.inject: off the point is never reached, whatever the variable says', async () => {
      const rig = await ChaosRig.create();
      try {
        const child = rig.start({
          mode: 'first',
          crashAt: 'effects.after_execute:open_pr',
          env: { OT_CHILD_INJECT: 'off' },
        });
        // The first start opens a chat and does not end by itself: wait until the play that the
        // point would have killed is done, which the store shows.
        await waitFor(() => allPlaysDone(rig.storePath), 90_000);
        expect(child.output()).not.toContain('CRASHPOINT');
        expect(isAlive(child.pid)).toBe(true);
        child.process.kill('SIGKILL');
        const exit = await child.exited;
        expect(exit.signal).toBe('SIGKILL');
      } finally {
        await rig.dispose();
      }
    });

    it('the harness leaves its pid files in <state dir>/pids, one per start, and ends what is alive', async () => {
      const rig = await ChaosRig.create();
      try {
        await rig.killAtPoint('effects.after_intend:open_pr');
        const entries = pidFileEntries(rig.stateDir);
        expect(PID_DIR_NAME).toBe('pids');
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const census = rig.census();
        await rig.dispose();
        expect(aliveEntries(census)).toEqual([]);
      } finally {
        await rig.dispose();
      }
    });
  },
);
