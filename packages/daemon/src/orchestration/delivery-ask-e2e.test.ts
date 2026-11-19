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
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * `delivery.mode: ask` with someone watching (architecture 5.5, N89, P9), end to end with the fake
 * agent and the fake code host: the Director asks in DELIVERING, the answer is a menu of the
 * machine, and with nobody (or nobody answering) the play goes on with the PR.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const ASK = 'delivery:\n  mode: ask\n  allow_direct_merge: true\n';
const PRESENT = 'chat:\n  presence: always\n';

function withPlayDaemon(
  clock: FakeClock,
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock,
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    options,
    body,
  );
}

async function openPlay(harness: PlayHarness): Promise<{ scenarioId: string; playId: string }> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, '#ot-play write alpha and beta');
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return { scenarioId, playId: play.id };
}

async function stateOf(harness: PlayHarness, playId: string): Promise<string | undefined> {
  return (await harness.daemon.store.plays.get(playId))?.state;
}

async function done(harness: PlayHarness, playId: string): Promise<void> {
  await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
}

/** The question of the delivery, as the Producer sees it in `ot chat` (each poll is a sign of life). */
function deliveryMenu(harness: PlayHarness, scenarioId: string) {
  return waitFor('the question of the delivery', async () =>
    (await harness.producer.poll(scenarioId, 0)).asks.find(
      (ask) =>
        ask.kind === 'producer_menu' &&
        (ask.input.reason as { kind?: string } | null)?.kind === 'delivery_ask',
    ),
  );
}

async function deliveryOf(harness: PlayHarness, playId: string) {
  const events = await harness.eventsOf(playId);
  return events.find((event) => event.type === 'delivery.completed')?.payload as
    | {
        mode: string;
        requestedMode: string;
        requestedBy: string;
        downgraded: boolean;
        reason?: string;
        pullRequest?: { number: number };
        mergeSha?: string;
      }
    | undefined;
}

describeWithLauncher('delivery.mode: ask (N89)', { timeout: 120_000 }, () => {
  it('with the Producer present, asks and opens the PR when the answer is deliver_pr', async () => {
    await withPlayDaemon(new FakeClock(), { extra: `${ASK}${PRESENT}` }, async (harness) => {
      const { scenarioId, playId } = await openPlay(harness);
      const menu = await deliveryMenu(harness, scenarioId);
      expect(menu.playId).toBe(playId);
      expect(menu.input.options).toEqual(['deliver_pr', 'deliver_merge', 'cancel']);
      expect(await stateOf(harness, playId)).toBe('AWAITING_PRODUCER');
      expect(harness.codeHost.pullRequests()).toHaveLength(0);

      await harness.producer.answer(menu.id, { option: 'deliver_pr' });
      await done(harness, playId);
      expect(harness.codeHost.pullRequests()).toHaveLength(1);
      expect(await deliveryOf(harness, playId)).toMatchObject({
        mode: 'pr',
        requestedMode: 'pr',
        requestedBy: 'producer',
        downgraded: false,
      });
      const path = await harness.pathOf(playId);
      expect(path.slice(-4)).toEqual(['DELIVERING', 'AWAITING_PRODUCER', 'DELIVERING', 'DONE']);
      expect(await harness.daemon.store.decisions.get(menu.id)).toMatchObject({ state: 'decided' });
    });
  });

  it('with the Producer present, asks and merges when the answer is deliver_merge', async () => {
    await withPlayDaemon(new FakeClock(), { extra: `${ASK}${PRESENT}` }, async (harness) => {
      const { scenarioId, playId } = await openPlay(harness);
      const menu = await deliveryMenu(harness, scenarioId);
      await harness.producer.answer(menu.id, { option: 'deliver_merge' });
      await done(harness, playId);
      expect(harness.codeHost.pullRequests()).toHaveLength(0);
      const delivery = await deliveryOf(harness, playId);
      expect(delivery).toMatchObject({
        mode: 'direct_merge',
        requestedMode: 'direct_merge',
        requestedBy: 'producer',
        downgraded: false,
      });
      expect(delivery?.mergeSha).toBeDefined();
    });
  });

  it('with nobody watching, does not ask: opens the PR', async () => {
    await withPlayDaemon(new FakeClock(), { extra: ASK }, async (harness) => {
      const { scenarioId, playId } = await openPlay(harness);
      await done(harness, playId);
      expect(harness.codeHost.pullRequests()).toHaveLength(1);
      expect(await deliveryOf(harness, playId)).toMatchObject({
        mode: 'pr',
        requestedMode: 'ask',
        downgraded: true,
        reason: expect.stringContaining('unattended') as unknown,
      });
      expect(await harness.pathOf(playId)).not.toContain('AWAITING_PRODUCER');
      const asks = (await harness.producer.poll(scenarioId, 0)).asks;
      expect(asks.filter((ask) => ask.kind === 'producer_menu')).toHaveLength(0);
    });
  });

  it('when the Producer leaves during the question, the PR opens and the menu closes', async () => {
    const clock = new FakeClock();
    await withPlayDaemon(clock, { extra: ASK }, async (harness) => {
      const { scenarioId, playId } = await openPlay(harness);
      // present while it polls (a window of 30 s on the clock the test moves)
      const menu = await deliveryMenu(harness, scenarioId);
      expect(await stateOf(harness, playId)).toBe('AWAITING_PRODUCER');
      await clock.advance(60_000);
      await done(harness, playId);
      expect(harness.codeHost.pullRequests()).toHaveLength(1);
      expect(await deliveryOf(harness, playId)).toMatchObject({
        mode: 'pr',
        requestedBy: 'producer',
      });
      expect(await harness.daemon.store.decisions.get(menu.id)).toMatchObject({
        state: 'cancelled',
      });
      const choice = (await harness.daemon.store.decisions.list({ playId })).find(
        (row) => row.kind === 'menu_choice',
      );
      expect(choice).toMatchObject({
        decidedBy: 'daemon',
        answer: { option: 'deliver_pr', cause: 'left' },
      });
    });
  });

  it('on_leave: wait keeps the question open after the Producer left', async () => {
    const clock = new FakeClock();
    await withPlayDaemon(
      clock,
      { extra: `${ASK}  ask:\n    on_leave: wait\n    timeout: 0\n` },
      async (harness) => {
        const { scenarioId, playId } = await openPlay(harness);
        const menu = await deliveryMenu(harness, scenarioId);
        await clock.advance(3_600_000);
        expect(await stateOf(harness, playId)).toBe('AWAITING_PRODUCER');
        // it comes back and answers
        await harness.producer.answer(menu.id, { option: 'deliver_pr' });
        await done(harness, playId);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      },
    );
  });

  it('when the time is over, the PR opens even with the Producer in the chat', async () => {
    const clock = new FakeClock();
    await withPlayDaemon(
      clock,
      { extra: `${ASK}  ask:\n    timeout: 2m\n${PRESENT}` },
      async (harness) => {
        const { scenarioId, playId } = await openPlay(harness);
        const menu = await deliveryMenu(harness, scenarioId);
        await clock.advance(60_000);
        expect(await stateOf(harness, playId)).toBe('AWAITING_PRODUCER');
        await clock.advance(61_000);
        await done(harness, playId);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
        expect(await harness.daemon.store.decisions.get(menu.id)).toMatchObject({
          state: 'cancelled',
        });
        const choice = (await harness.daemon.store.decisions.list({ playId })).find(
          (row) => row.kind === 'menu_choice',
        );
        expect(choice?.answer).toMatchObject({ option: 'deliver_pr', cause: 'timeout' });
      },
    );
  });

  it('without allow_direct_merge there is nothing to ask: opens the PR', async () => {
    await withPlayDaemon(
      new FakeClock(),
      { extra: `delivery:\n  mode: ask\n${PRESENT}` },
      async (harness) => {
        const { playId } = await openPlay(harness);
        await done(harness, playId);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
        expect(await harness.pathOf(playId)).not.toContain('AWAITING_PRODUCER');
      },
    );
  });
});
