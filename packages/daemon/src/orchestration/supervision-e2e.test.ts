// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { supervisionKey } from '@otheater/core';
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
  withPlayDaemon,
  type PlayFakes,
  type PlayHarness,
} from './e2e-fixture.js';
import { itWithLauncher } from '../launcher-fixture.js';

/**
 * The Director's supervision of the Actors (N309, D8; P14 of Phase 11b), end to end with the fake
 * agent. The Actor of `alpha` edits a file outside its demand (`#actor-supervise:alpha`): the
 * daemon sees it, calls the fake Director, which warns (or redirects), and the message reaches the
 * Actor in the reply of its next MCP tool call.
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

async function deliveredPlay(harness: PlayHarness, need: string): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, need);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  await waitFor(
    'DONE',
    async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
  );
  return play.id;
}

async function eventsOfType(harness: PlayHarness, playId: string, type: string) {
  return (await harness.eventsOf(playId)).filter((event) => event.type === type);
}

function alpha(harness: PlayHarness, playId: string): Promise<string> {
  return testGit(harness.rig.repo, 'show', `play/${playId}/integration:alpha.txt`);
}

describe('the supervision of the Director, end to end with the fake agent', { timeout: 120_000 }, () => {
  itWithLauncher(
    'an edit outside the demand calls the Director and its warning arrives in the next tool reply',
    async () => {
      await withPlayDaemon(fakes(), {}, async (harness) => {
        const playId = await deliveredPlay(harness, '#ot-play write alpha #actor-supervise:alpha');
        const signals = await eventsOfType(harness, playId, 'supervision.signal');
        expect(signals).toHaveLength(1);
        expect(signals[0]?.payload).toMatchObject({
          signal: 'outside_demand',
          demandId: 'alpha',
          outcome: 'director_called',
        });
        const warnings = (await eventsOfType(harness, playId, 'supervision.warning')).map(
          (event) => event.payload,
        );
        expect(warnings).toMatchObject([
          { kind: 'warn', delivered: false, reason: 'queued' },
          { kind: 'warn', delivered: true, reason: 'delivered' },
        ]);
        // the Actor read it in the reply of its tool and wrote it down
        expect(await alpha(harness, playId)).toContain('warning: stay inside the demand');
        const kept = await harness.daemon.store.blackboard.history(playId, supervisionKey('alpha'));
        expect(kept.at(-1)?.value).toMatchObject({ kind: 'warn', state: 'delivered' });
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    },
  );

  itWithLauncher('with mode log the signal is recorded and the Director is not called', async () => {
    await withPlayDaemon(fakes(), { extra: 'supervision:\n  mode: log' }, async (harness) => {
      const playId = await deliveredPlay(harness, '#ot-play write alpha #actor-supervise:alpha');
      const signals = await eventsOfType(harness, playId, 'supervision.signal');
      expect(signals.map((event) => event.payload)).toMatchObject([
        { signal: 'outside_demand', outcome: 'logged' },
      ]);
      expect(await eventsOfType(harness, playId, 'supervision.warning')).toHaveLength(0);
      expect(await alpha(harness, playId)).not.toContain('warning:');
    });
  });

  itWithLauncher('with mode off nothing is watched', async () => {
    await withPlayDaemon(fakes(), { extra: 'supervision:\n  mode: off' }, async (harness) => {
      const playId = await deliveredPlay(harness, '#ot-play write alpha #actor-supervise:alpha');
      expect(await eventsOfType(harness, playId, 'supervision.signal')).toHaveLength(0);
      expect(await alpha(harness, playId)).not.toContain('warning:');
    });
  });

  itWithLauncher(
    'with mode redirect the Director cancels the attempt and it is relaunched with the warning',
    async () => {
      await withPlayDaemon(fakes(), { extra: 'supervision:\n  mode: redirect' }, async (harness) => {
        const playId = await deliveredPlay(
          harness,
          '#ot-play write alpha #actor-supervise:alpha@1',
        );
        const redirects = await eventsOfType(harness, playId, 'supervision.redirect');
        expect(redirects).toHaveLength(1);
        expect(redirects[0]?.payload).toMatchObject({ demandId: 'alpha' });
        expect(await eventsOfType(harness, playId, 'attempt.cancelled')).not.toHaveLength(0);
        // the second attempt got the text of the Director in its prompt
        expect(await alpha(harness, playId)).toContain(
          'redirected: start over and stay inside the demand',
        );
      });
    },
  );

  itWithLauncher(
    'a signal past max_warnings_per_demand does not call the Director: supervision.limit_reached',
    async () => {
      await withPlayDaemon(
        fakes(),
        { extra: 'supervision:\n  max_warnings_per_demand: 1' },
        async (harness) => {
          const playId = await deliveredPlay(
            harness,
            '#ot-play write alpha #actor-supervise:alpha=2',
          );
          const limits = await eventsOfType(harness, playId, 'supervision.limit_reached');
          expect(limits.map((event) => event.payload)).toMatchObject([
            { limit: 'max_warnings_per_demand', demandId: 'alpha', max: 1 },
          ]);
          const signals = (await eventsOfType(harness, playId, 'supervision.signal')).map(
            (event) => (event.payload as { outcome: string }).outcome,
          );
          expect(signals).toEqual(['director_called', 'limited']);
        },
      );
    },
  );

  itWithLauncher(
    'a signal with director_budget 0 does not call the Director: supervision.limit_reached',
    async () => {
      await withPlayDaemon(
        fakes(),
        { extra: 'supervision:\n  director_budget: 0' },
        async (harness) => {
          const playId = await deliveredPlay(
            harness,
            '#ot-play write alpha #actor-supervise:alpha',
          );
          const limits = await eventsOfType(harness, playId, 'supervision.limit_reached');
          expect(limits.map((event) => event.payload)).toMatchObject([
            { limit: 'director_budget', demandId: 'alpha' },
          ]);
          expect(await eventsOfType(harness, playId, 'supervision.warning')).toHaveLength(0);
        },
      );
    },
  );
});
