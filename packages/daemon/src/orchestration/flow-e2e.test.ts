// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * A play that runs a flow of the configuration (P12, N133, N241) with the fake agent in every
 * role, as `play-e2e.test.ts` runs the official one. The client is the compiled fake agent, so
 * `pnpm build` comes first.
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

async function openPlay(harness: PlayHarness): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return play.id;
}

const stateOf = async (harness: PlayHarness, playId: string) =>
  (await harness.daemon.store.plays.get(playId))?.state;

interface StoredSnapshot {
  context: { flow?: { id: string; version: number; hash: string; skip: string[] }; limits: object };
}

describeWithLauncher(
  'a play that runs a flow of the configuration (P12)',
  { timeout: 120_000 },
  () => {
    it('runs to the delivery without the review of the plan, and the snapshot names the flow', async () => {
      const extra = `
flows:
  quick:
    version: 1
    description: no review of the plan
    steps:
      plan_review: { enabled: false }
scenario:
  flow: quick
`;
      await withPlayDaemon({ extra }, async (harness) => {
        const playId = await openPlay(harness);
        await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');

        const path = await harness.pathOf(playId);
        expect(path).not.toContain('REVIEWING_PLAN');
        expect(path).toEqual(
          expect.arrayContaining(['PLANNING', 'SCRIPTING', 'EXECUTING', 'CRITIQUING']),
        );
        expect(path.at(-1)).toBe('DONE');
        expect(harness.codeHost.pullRequests()).toHaveLength(1);

        const record = await harness.daemon.store.plays.get(playId);
        const { flow } = (record?.snapshot as unknown as StoredSnapshot).context;
        expect(flow).toMatchObject({ id: 'quick', version: 1, skip: ['plan_review'] });
        expect(flow?.hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    it('runs to the delivery without the critique', async () => {
      const extra = `
flows:
  no-critic:
    version: 1
    steps:
      critique: { enabled: false }
scenario:
  flow: no-critic
`;
      await withPlayDaemon({ extra }, async (harness) => {
        const playId = await openPlay(harness);
        await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
        const path = await harness.pathOf(playId);
        expect(path).not.toContain('CRITIQUING');
        expect(path).toContain('REVIEWING_PLAN');
        expect(path.at(-1)).toBe('DONE');
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    });
  },
);
