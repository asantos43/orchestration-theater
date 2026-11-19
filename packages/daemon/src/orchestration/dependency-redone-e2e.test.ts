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
import { describeWithLauncher, itWithLauncher } from '../launcher-fixture.js';

/**
 * Judgment point 8 and who is watching (P15a), end to end with the fake agent. The fake Critic
 * rejects its first look and the Director classifies it as an execution failure of alpha, which
 * beta depends on and which is approved: alpha is redone, so the daemon sends `DEPENDENCY_REDONE`
 * (beta is stale) and the fake Director answers `rebase` or `redo` by the outcome. With
 * `delivery.base_drift: ask` a chat that polls the scenario is watching, and the menu opens.
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

async function stateOf(harness: PlayHarness, playId: string): Promise<string | undefined> {
  return (await harness.daemon.store.plays.get(playId))?.state;
}

async function delivered(harness: PlayHarness, playId: string): Promise<void> {
  await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
}

async function openPlay(harness: PlayHarness, outcome: string): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, `#ot-play write alpha and beta #outcome:${outcome}`);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return play.id;
}

async function attemptsOf(harness: PlayHarness, playId: string, demandId: string) {
  return (await harness.daemon.store.attempts.list()).filter(
    (attempt) => attempt.playId === playId && attempt.demandId === demandId,
  );
}

/** The decisions of judgment point 8 of the play, and the answer the Director gave. */
async function pointEight(harness: PlayHarness, playId: string) {
  const rows = await harness.daemon.store.decisions.list({
    playId,
    kinds: ['judge.dependency_redone'],
  });
  return rows.map((row) => ({ state: row.state, input: row.input, answer: row.answer }));
}

describe(
  'a demand that is redone while others depend on it (judgment point 8)',
  { timeout: 120_000 },
  () => {
    itWithLauncher(
      'rebase: the dependents move onto the new work and the play delivers',
      async () => {
        await withPlayDaemon({}, async (harness) => {
          const playId = await openPlay(harness, 'dependency_redone_rebase');
          await delivered(harness, playId);
          const rows = await pointEight(harness, playId);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            state: 'decided',
            input: { demandId: 'alpha', dependentIds: ['beta'] },
            answer: { action: 'rebase' },
          });
          // alpha ran twice, beta once: its finished work was moved, not redone
          expect(await attemptsOf(harness, playId, 'alpha')).toHaveLength(2);
          expect(await attemptsOf(harness, playId, 'beta')).toHaveLength(1);
          expect(
            await testGit(harness.rig.repo, 'show', `play/${playId}/integration:beta.txt`),
          ).toContain('beta');
          expect(harness.codeHost.pullRequests()).toHaveLength(1);
          // the integration waited for the point: it came after the redo of alpha
          const path = await harness.pathOf(playId);
          expect(path.filter((state) => state === 'INTEGRATING').length).toBe(2);
        });
      },
    );

    itWithLauncher(
      'redo: the dependents run again on the new work and the play delivers',
      async () => {
        await withPlayDaemon({}, async (harness) => {
          const playId = await openPlay(harness, 'dependency_redone_redo');
          await delivered(harness, playId);
          const rows = await pointEight(harness, playId);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ state: 'decided', answer: { action: 'redo' } });
          expect(await attemptsOf(harness, playId, 'alpha')).toHaveLength(2);
          expect(await attemptsOf(harness, playId, 'beta')).toHaveLength(2);
          const demands = await harness.daemon.store.demands.list({ playId });
          expect(demands.map((demand) => [demand.id, demand.state])).toEqual([
            ['alpha', 'approved'],
            ['beta', 'approved'],
          ]);
          expect(harness.codeHost.pullRequests()).toHaveLength(1);
        });
      },
    );

    itWithLauncher(
      'does not open the point when nothing depends on the redone demand',
      async () => {
        await withPlayDaemon({}, async (harness) => {
          const playId = await openPlay(harness, 'approved');
          await delivered(harness, playId);
          expect(await pointEight(harness, playId)).toEqual([]);
        });
      },
    );
  },
);

describeWithLauncher(
  'who is watching a play (delivery.base_drift: ask)',
  { timeout: 120_000 },
  () => {
    const ask = { extra: 'delivery:\n  base_drift: ask' };

    it('a chat that polls the scenario is watching: the menu opens, and the Producer chooses', async () => {
      await withPlayDaemon(ask, async (harness) => {
        const scenarioId = await harness.openChat();
        // what `ot chat` does: it polls the scenario all the time
        const watcher = setInterval(() => {
          void harness.producer.poll(scenarioId, 0).catch(() => undefined);
        }, 100);
        try {
          await harness.producer.send(
            scenarioId,
            '#ot-play write alpha and beta #outcome:base_drift_conflict',
          );
          const menu = await waitFor('the menu of the drifted base', async () =>
            (await harness.producer.poll(scenarioId, 0)).asks.find(
              (item) => item.kind === 'producer_menu',
            ),
          );
          expect(menu.input.options).toEqual([
            'redo_on_new_base',
            'deliver_with_conflict',
            'cancel',
          ]);
          expect(await stateOf(harness, menu.playId ?? '')).toBe('AWAITING_PRODUCER');
          expect(harness.codeHost.pullRequests()).toHaveLength(0);
          await harness.producer.answer(menu.id, { option: 'deliver_with_conflict' });
          await delivered(harness, menu.playId ?? '');
          expect(harness.codeHost.pullRequests()).toHaveLength(1);
        } finally {
          clearInterval(watcher);
        }
      });
    });

    it('with nobody polling the play does update, without a menu', async () => {
      await withPlayDaemon(ask, async (harness) => {
        const playId = await openPlay(harness, 'base_drift_conflict');
        await delivered(harness, playId);
        const path = await harness.pathOf(playId);
        expect(
          path.filter((state, i) => state === 'SCRIPTING' && path[i - 1] === 'DELIVERING'),
        ).toHaveLength(1);
        expect(path).not.toContain('AWAITING_PRODUCER');
      });
    });

    it('chat.presence: always counts as watched even when nobody polls', async () => {
      await withPlayDaemon(
        { extra: 'delivery:\n  base_drift: ask\nchat:\n  presence: always' },
        async (harness) => {
          const playId = await openPlay(harness, 'base_drift_conflict');
          await waitFor(
            'AWAITING_PRODUCER',
            async () => (await stateOf(harness, playId)) === 'AWAITING_PRODUCER',
          );
          expect(harness.codeHost.pullRequests()).toHaveLength(0);
        },
      );
    });
  },
);
