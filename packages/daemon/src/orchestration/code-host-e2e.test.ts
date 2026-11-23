// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { LocalCodeHost } from '../code-host.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The code host of the production composition (Phase 11, P13, N289), end to end with the fake agent:
 * the daemon builds the host from `adapters.code_host` (no instance handed in), a play reaches the
 * delivery and the host the configuration named is the one that got the push and the pull request.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function withPlayDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    options,
    body,
  );
}

async function play(harness: PlayHarness): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, '#ot-play write alpha and beta');
  const found = await waitFor(
    'the play to exist',
    async () => (await harness.plays(scenarioId))[0],
  );
  await waitFor(
    'DONE',
    async () => (await harness.daemon.store.plays.get(found.id))?.state === 'DONE',
  );
  return found.id;
}

async function deliveryOf(harness: PlayHarness, playId: string) {
  const events = await harness.eventsOf(playId);
  return events.find((event) => event.type === 'delivery.completed')?.payload as
    { mode: string; branch: string; pullRequest?: { number: number; url: string } } | undefined;
}

describeWithLauncher('adapters.code_host in the daemon (N289)', { timeout: 120_000 }, () => {
  it('fake: the play delivers and the journal of the host shows the pull request opened', async () => {
    await withPlayDaemon({ codeHostMode: 'fake' }, async (harness) => {
      const host = harness.daemon.codeHost as LocalCodeHost;
      expect(host).toBeInstanceOf(LocalCodeHost);
      expect(harness.daemon.adapters).toContainEqual(
        expect.objectContaining({ port: 'CodeHost', id: 'fake' }),
      );
      const playId = await play(harness);
      const delivery = await deliveryOf(harness, playId);
      expect(delivery).toMatchObject({ mode: 'pr', pullRequest: { number: 1 } });
      expect(host.pullRequests()).toEqual([
        expect.objectContaining({ number: 1, state: 'open', headBranch: delivery?.branch }),
      ]);
      expect(host.calls.map((call) => call.method)).toContain('pushRef');
      expect(host.calls.map((call) => call.method)).toContain('openPullRequest');
      // The host of this run is the daemon's own: the fake handed to the fixture saw nothing.
      expect(harness.codeHost.pullRequests()).toHaveLength(0);
    });
  });

  it('none: the play delivers without a pull request, with a warning and a daemon.notice', async () => {
    await withPlayDaemon({ codeHostMode: 'none' }, async (harness) => {
      const playId = await play(harness);
      const delivery = await deliveryOf(harness, playId);
      expect(delivery?.mode).toBe('pr');
      // A local record stands in for the pull request: the event of the delivery needs a number.
      expect(delivery?.pullRequest?.url).toContain('/none/pull/');
      const events = await harness.daemon.store.events.readFrom(0, 100_000);
      const notices = events
        .filter((event) => event.type === 'daemon.notice')
        .map((event) => event.payload as { kind: string; subject: string; detail: string });
      expect(notices).toContainEqual({
        kind: 'delivery_without_pr',
        subject: delivery?.branch,
        detail: expect.stringContaining('no pull request was opened') as string,
      });
      expect((harness.daemon.codeHost as LocalCodeHost).pullRequests()).toHaveLength(1);
    });
  });
});
