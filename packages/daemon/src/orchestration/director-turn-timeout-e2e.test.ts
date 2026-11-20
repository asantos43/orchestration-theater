// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import type { EventEnvelope } from '@otheater/core';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { SessionTurnTimeoutPayloadSchema } from '@otheater/protocol';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The limit of one turn of the Director (N184, `limits.turn_timeout`): the fake agent hangs on the
 * turn (`#ot-director-hang`, the first time) and the fake clock runs past the limit. With `cancel`
 * the session is cancelled and the turn fails like any failed turn (its error is the reply of the
 * chat); with `notice` only the event is written. The fake agent is the compiled `dist/cli.js`.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const MINUTE = 60_000;

interface Rig {
  readonly harness: PlayHarness;
  readonly clock: FakeClock;
  readonly stateDir: () => string;
}

function withTurnDaemon(
  options: PlayHarnessOptions,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const clock = new FakeClock();
  let stateDir = '';
  return withPlayDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock,
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) => {
        stateDir = env.FAKE_AGENT_STATE_DIR ?? stateDir;
        return new FakeClientAdapter({
          launcher,
          baseEnv: {},
          env,
          adapterVersion: '1.0.0',
          command,
        });
      },
    },
    options,
    (harness) => body({ harness, clock, stateDir: () => stateDir }),
  );
}

async function eventsOf(
  harness: PlayHarness,
  scenarioId: string,
  type: string,
): Promise<EventEnvelope[]> {
  return (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
    (event) => event.type === type && event.scenarioId === scenarioId,
  );
}

async function hangs(rig: Rig, scenarioId: string): Promise<void> {
  await rig.harness.producer.send(scenarioId, '#ot-director-hang\n#ot-chat hello');
  await waitFor('the Director turn to hang', () =>
    Promise.resolve(existsSync(join(rig.stateDir(), 'director-hang.count'))),
  );
}

describeWithLauncher('the turn limit of the Director (N184)', { timeout: 180_000 }, () => {
  it('cancel: the event is written, the session is cancelled and the turn fails with its error in the chat', async () => {
    await withTurnDaemon({ limits: '  turn_timeout: 1m\n' }, async (rig) => {
      const scenarioId = await rig.harness.openGenericChat('talk');
      await hangs(rig, scenarioId);
      await rig.clock.advance(MINUTE);

      const event = await waitFor(
        'the turn_timeout event',
        async () => (await eventsOf(rig.harness, scenarioId, 'session.turn_timeout'))[0],
      );
      expect(SessionTurnTimeoutPayloadSchema.parse(event.payload)).toMatchObject({
        limitMs: MINUTE,
        action: 'cancel',
      });
      const reply = await waitFor(
        'the error reply',
        async () => (await eventsOf(rig.harness, scenarioId, 'chat.director_reply'))[0],
      );
      expect(JSON.stringify(reply.payload)).toContain('limits.turn_timeout');
    });
  });

  it('notice: only the event, the turn is not cancelled', async () => {
    await withTurnDaemon(
      { limits: '  turn_timeout: 1m\n  on_turn_timeout: notice\n' },
      async (rig) => {
        const scenarioId = await rig.harness.openGenericChat('talk');
        await hangs(rig, scenarioId);
        await rig.clock.advance(MINUTE);

        const event = await waitFor(
          'the turn_timeout event',
          async () => (await eventsOf(rig.harness, scenarioId, 'session.turn_timeout'))[0],
        );
        expect(SessionTurnTimeoutPayloadSchema.parse(event.payload)).toMatchObject({
          limitMs: MINUTE,
          action: 'notice',
        });
        expect(await eventsOf(rig.harness, scenarioId, 'chat.director_reply')).toEqual([]);
      },
    );
  });
});
