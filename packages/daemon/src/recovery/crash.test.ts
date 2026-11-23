// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { aliveEntries, censusPids } from '../chaos/census.js';
import { assertHarnessBuilt, ChaosRig } from '../chaos/harness.js';
import { assertInvariants } from '../chaos/invariants.js';

/**
 * `kill -9` of the daemon in the middle of a side effect (architecture 5.21, acceptance of P9).
 * The daemon runs as a child process of the test (the chaos harness, Phase 11 P1), with the fake
 * agent and the fake code host. The point `effects.after_execute:open_pr` makes the daemon kill
 * itself right after the code host opened the pull request, before the daemon wrote that the effect
 * ended; the test then starts another on the same folder and checks what the start-up did, and the
 * invariants I1 to I8 of the harness.
 *
 * The child runs the build output (packages/daemon/dist/, built by `pnpm build`): this comment names
 * the path so that `tools/ci/test-affected.sh` (it lists the tests that name a dist/ path) keeps
 * running this test when any source changes.
 */

beforeAll(assertHarnessBuilt);
afterAll(disposeTestGitIsolation);

interface SystemMessage {
  scenarioId: string;
  kind: string;
  resumed: { kind: string; id: string }[];
  settled: { effectType: string; playId: string; outcome: string }[];
  waiting: { kind: string; id: string }[];
}

describe.skipIf(process.platform !== 'linux')(
  'kill -9 of the daemon in the middle of a side effect (P9)',
  { timeout: 240_000 },
  () => {
    it('ends the orphan, settles the effect by its verifier and repeats nothing', async () => {
      const rig = await ChaosRig.create();
      try {
        // 1. The daemon runs until the code host has opened the pull request, then it kills itself.
        const killed = await rig.killAtPoint('effects.after_execute:open_pr');
        expect(killed.signal).toBe('SIGKILL');
        expect(killed.crash).toMatchObject({
          point: 'effects.after_execute',
          detail: 'open_pr',
          hit: 1,
        });
        const clientPids = killed.crash?.pids ?? [];
        expect(clientPids.length).toBeGreaterThan(0);
        // The census finds every client the daemon named, and the client outlived the daemon: it is
        // an orphan now.
        for (const pid of clientPids) expect(censusPids(killed.census)).toContain(pid);
        const orphans = aliveEntries(killed.census).map((entry) => entry.pid);
        expect(orphans.length).toBeGreaterThan(0);

        // 2. Another daemon on the same folder reconciles, resumes the play and ends it.
        const report = await rig.restart();

        expect(report.timedOut).toBe(false);
        // The orphans died (I3 asks it of the whole census).
        assertInvariants(rig.evaluate({ census: killed.census, report, boots: 2 }));
        const recovered = report.recovered.at(-1);
        expect(recovered?.orphansKilled).toBeGreaterThanOrEqual(clientPids.length);
        expect(recovered?.sessionsInterrupted).toBeGreaterThan(0);
        expect(recovered?.effectsResolved).toBeGreaterThanOrEqual(1);
        expect(recovered?.pending).toEqual([]);
        expect(recovered?.playsResumed).toHaveLength(1);
        // The effect was settled by the verifier, not by asking the Producer.
        const prs = report.sideEffects.filter((row) => row.type === 'open_pr');
        expect(prs).toHaveLength(1);
        expect(prs[0]).toMatchObject({ state: 'done', verifier: 'verifier' });
        expect(report.decisions.filter((row) => row.kind === 'recovery_effect')).toEqual([]);
        // Nothing repeated: one pull request, and the delivery is told once.
        expect(report.pulls).toBe(1);
        const opened = readFileSync(rig.journalPath, 'utf8')
          .split('\n')
          .filter((line) => line.includes('"op":"openPullRequest"'));
        expect(opened).toHaveLength(1);
        // The dead daemon never wrote `delivery.completed`, and the reconciliation settled the PR,
        // so the resumed delivery only replays what is done and tells nothing again.
        expect(
          report.events.filter((event) => event.type === 'delivery.completed').length,
        ).toBeLessThanOrEqual(1);
        // One per start: the first daemon and the one that took over.
        expect(report.events.filter((event) => event.type === 'daemon.recovered')).toHaveLength(2);
        expect(report.plays.map((play) => play.state)).toEqual(['DONE']);
        // The chat of the scenario shows what the start-up did (5.21, step 8): the play taken up
        // again and the pull request settled by the verifier; nothing waits for the Producer. The
        // first start of the folder was clean and wrote no message: one event, for one scenario.
        const playId = report.plays[0]?.id ?? '';
        expect(report.systemMessages).toHaveLength(1);
        const notice = report.systemMessages[0]?.payload as SystemMessage | undefined;
        expect(notice?.scenarioId).toBe(report.systemMessages[0]?.scenarioId);
        expect(notice?.kind).toBe('recovery');
        expect(notice?.resumed).toContainEqual({ kind: 'play', id: playId });
        expect(notice?.settled).toEqual([{ effectType: 'open_pr', playId, outcome: 'done' }]);
        expect(notice?.waiting).toEqual([]);
      } finally {
        await rig.dispose();
      }
    });
  },
);
