// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';

/**
 * The merge conflicts of a play (architecture 5.5, N83 and N84), end to end with the fake agent
 * and the fake code host. The fake Critic moves `main` on its first look (outcomes `base_drift`
 * and `base_drift_conflict`), or rejects it as a script failure so that a second script, with
 * alpha unchanged and beta rewritten, comes (outcome `rescript`).
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

function withPlayDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withDaemon(fakes(), options, body);
}

async function openPlay(harness: PlayHarness, outcome: string): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, `#ot-play write alpha and beta #outcome:${outcome}`);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return play.id;
}

async function stateOf(harness: PlayHarness, playId: string): Promise<string | undefined> {
  return (await harness.daemon.store.plays.get(playId))?.state;
}

async function delivered(harness: PlayHarness, playId: string): Promise<void> {
  await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
}

/** The content of `file` on the integration branch of the play. */
function onIntegration(harness: PlayHarness, playId: string, file: string): Promise<string> {
  return testGit(harness.rig.repo, 'show', `play/${playId}/integration:${file}`);
}

async function deliveryOf(
  harness: PlayHarness,
  playId: string,
): Promise<{ warnings?: string[] } | undefined> {
  const events = await harness.eventsOf(playId);
  return events.find((event) => event.type === 'delivery.completed')?.payload;
}

/** How many times the path went from DELIVERING to SCRIPTING. */
function returnsFromDelivery(path: readonly string[]): number {
  return path.filter((state, i) => state === 'SCRIPTING' && path[i - 1] === 'DELIVERING').length;
}

describe('the base moves while the play runs (N83)', { timeout: 120_000 }, () => {
  it('update, no conflict: merges the base into the integration and delivers', async () => {
    await withPlayDaemon({}, async (harness) => {
      const playId = await openPlay(harness, 'base_drift');
      await delivered(harness, playId);
      expect(returnsFromDelivery(await harness.pathOf(playId))).toBe(0);
      // the delivered branch carries the work of the play and the file main got meanwhile
      expect(await onIntegration(harness, playId, 'news.txt')).toContain('written on main');
      expect(await onIntegration(harness, playId, 'beta.txt')).toContain('beta');
      const pulls = harness.codeHost.pullRequests();
      expect(pulls).toHaveLength(1);
      expect((await deliveryOf(harness, playId))?.warnings).toBeUndefined();
    });
  });

  it('update, conflict: a script failure that goes back to SCRIPTING and counts in script_returns', async () => {
    await withPlayDaemon({}, async (harness) => {
      const playId = await openPlay(harness, 'base_drift_conflict');
      await delivered(harness, playId);
      const path = await harness.pathOf(playId);
      expect(returnsFromDelivery(path)).toBe(1);
      // the second round starts on the new base, which already has the file of main
      const alpha = await onIntegration(harness, playId, 'alpha.txt');
      expect(alpha).toContain('written by the fake Actor');
      expect(harness.codeHost.pullRequests()).toHaveLength(1);
    });
  });

  it('update, no conflict, but verify fails on the updated work: a script failure too', async () => {
    await withPlayDaemon({ limits: '  attempts_per_demand: 1' }, async (harness) => {
      const playId = await openPlay(harness, 'base_drift_verify');
      await waitFor(
        'AWAITING_PRODUCER',
        async () => (await stateOf(harness, playId)) === 'AWAITING_PRODUCER',
      );
      const path = await harness.pathOf(playId);
      // the base had no conflict, yet the work did not survive it: back to the script
      expect(returnsFromDelivery(path)).toBe(1);
      expect(harness.codeHost.pullRequests()).toHaveLength(0);
    });
  });

  it('update, conflict: script_returns runs out and the play goes to the Producer', async () => {
    await withPlayDaemon({ limits: '  script_returns: 0' }, async (harness) => {
      const playId = await openPlay(harness, 'base_drift_conflict');
      await waitFor(
        'AWAITING_PRODUCER',
        async () => (await stateOf(harness, playId)) === 'AWAITING_PRODUCER',
      );
      expect(harness.codeHost.pullRequests()).toHaveLength(0);
    });
  });

  it('deliver_and_warn, conflict: opens the PR with the conflicts listed and warns', async () => {
    await withPlayDaemon(
      { extra: 'delivery:\n  base_drift: deliver_and_warn' },
      async (harness) => {
        const playId = await openPlay(harness, 'base_drift_conflict');
        await delivered(harness, playId);
        expect(returnsFromDelivery(await harness.pathOf(playId))).toBe(0);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
        const warnings = (await deliveryOf(harness, playId))?.warnings ?? [];
        expect(warnings.join('\n')).toContain('alpha.txt');
      },
    );
  });

  it('deliver_and_warn, no conflict: delivers without warnings', async () => {
    await withPlayDaemon(
      { extra: 'delivery:\n  base_drift: deliver_and_warn' },
      async (harness) => {
        const playId = await openPlay(harness, 'base_drift');
        await delivered(harness, playId);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      },
    );
  });

  it('ask, with nobody watching: acts as update (a conflict goes back to SCRIPTING)', async () => {
    await withPlayDaemon({ extra: 'delivery:\n  base_drift: ask' }, async (harness) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(
        scenarioId,
        '#ot-play write alpha and beta #outcome:base_drift_conflict',
      );
      const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
      await delivered(harness, play.id);
      expect(returnsFromDelivery(await harness.pathOf(play.id))).toBe(1);
      const asks = (await harness.producer.poll(scenarioId, 0)).asks;
      expect(asks.filter((ask) => ask.kind === 'producer_menu')).toHaveLength(0);
    });
  });
});

describe('a new script keeps what did not change (N84)', { timeout: 120_000 }, () => {
  async function attemptsOf(harness: PlayHarness, playId: string, demandId: string) {
    return (await harness.daemon.store.attempts.list()).filter(
      (attempt) => attempt.playId === playId && attempt.demandId === demandId,
    );
  }

  it('keep_unchanged: alpha does not run again, beta runs with the old diff in context', async () => {
    await withPlayDaemon({}, async (harness) => {
      const playId = await openPlay(harness, 'rescript');
      await delivered(harness, playId);
      expect(await attemptsOf(harness, playId, 'alpha')).toHaveLength(1);
      expect((await attemptsOf(harness, playId, 'beta')).length).toBe(2);
      const alpha = await onIntegration(harness, playId, 'alpha.txt');
      expect(alpha).not.toContain('earlier work');
      const beta = await onIntegration(harness, playId, 'beta.txt');
      expect(beta).toContain('took over earlier work, diff given');
      expect(harness.codeHost.pullRequests()).toHaveLength(1);
    });
  });

  it('redo_all: everything runs again', async () => {
    await withPlayDaemon({ extra: 'rescript:\n  reuse: redo_all' }, async (harness) => {
      const playId = await openPlay(harness, 'rescript');
      await delivered(harness, playId);
      expect(await attemptsOf(harness, playId, 'alpha')).toHaveLength(2);
      expect(await attemptsOf(harness, playId, 'beta')).toHaveLength(2);
    });
  });

  it('from_previous: alpha is kept and beta starts from its old branch, without a diff', async () => {
    await withPlayDaemon({ extra: 'rescript:\n  reuse: from_previous' }, async (harness) => {
      const playId = await openPlay(harness, 'rescript');
      await delivered(harness, playId);
      expect(await attemptsOf(harness, playId, 'alpha')).toHaveLength(1);
      const beta = await attemptsOf(harness, playId, 'beta');
      expect(beta).toHaveLength(2);
      const [first, second] = beta;
      // the second attempt is cut from the branch of the first (it holds its commit)
      const ancestor = await testGit(
        harness.rig.repo,
        'merge-base',
        '--is-ancestor',
        first?.branch ?? '',
        second?.branch ?? '',
      ).then(
        () => true,
        () => false,
      );
      expect(ancestor).toBe(true);
      expect(await onIntegration(harness, playId, 'beta.txt')).toContain('took over earlier work');
    });
  });
});
