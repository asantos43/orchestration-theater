// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import type { EventEnvelope } from '@otheater/core';
import { disposeTestGitIsolation } from '@otheater/sdk';
import {
  ChatDirectorReplyPayloadSchema,
  ChatDirectorSilentPayloadSchema,
} from '@otheater/protocol';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * A turn of the Director that ends with no text (N183): the fake agent opens a play with the
 * framework tool and says nothing (`#ot-silent-play`), or does nothing at all (`#ot-silent`). The
 * daemon writes `chat.director_silent` and, with `chat.silent_turn: notice`, a reply it generated
 * and marked. The fake agent is the compiled `dist/cli.js`, so `pnpm build` comes first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const LEAD = 'The Director ended the turn without a reply.';

function withSilentDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withPlayDaemon(
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

async function eventsOf(
  harness: PlayHarness,
  scenarioId: string,
  type: string,
): Promise<EventEnvelope[]> {
  return (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
    (event) => event.type === type && event.scenarioId === scenarioId,
  );
}

async function waitForEvent(
  harness: PlayHarness,
  scenarioId: string,
  type: string,
  nth = 0,
): Promise<EventEnvelope> {
  return waitFor(`the ${type} event`, async () => (await eventsOf(harness, scenarioId, type))[nth]);
}

describeWithLauncher('the silent turn of the Director (N183)', { timeout: 180_000 }, () => {
  it('opens a play with no text: a generated reply with the tool and the play, and the event of the situation', async () => {
    await withSilentDaemon({}, async (harness) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, '#ot-silent-play write alpha and beta');

      const reply = await waitForEvent(harness, scenarioId, 'chat.director_reply');
      const silent = await waitForEvent(harness, scenarioId, 'chat.director_silent');
      const [play] = await waitFor('the play', async () => {
        const plays = await harness.plays(scenarioId);
        return plays.length > 0 ? plays : undefined;
      });
      const playId = play?.id ?? '';
      expect(playId).not.toBe('');

      const payload = ChatDirectorReplyPayloadSchema.parse(reply.payload);
      expect(payload.generated).toBe(true);
      expect(payload.to).toBe('producer');
      expect(payload.playId).toBe(playId);
      expect(payload.tools).toHaveLength(1);
      expect(payload.tools?.[0]?.name).toContain('open_play');
      expect(payload.tools?.[0]?.status).toBe('completed');
      expect(payload.text).toBe(
        `${LEAD} Tools called: ${payload.tools?.[0]?.name ?? ''}. Play opened: ${playId}.`,
      );

      expect(ChatDirectorSilentPayloadSchema.parse(silent.payload)).toEqual({
        tools: payload.tools,
        playId,
        mode: 'notice',
      });
      // The situation is written first, then the reply it caused.
      expect(silent.id).toBeLessThan(reply.id);
      // The producer channel (what `poll` and the chat read) keeps the same reply.
      const polled = (await harness.producer.poll(scenarioId, 0)).replies;
      expect(polled.map((item) => item.text)).toEqual([payload.text]);
    });
  });

  it('ends with no text and no tool: the reply only says the Director did not answer', async () => {
    await withSilentDaemon({}, async (harness) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, '#ot-silent');
      const reply = await waitForEvent(harness, scenarioId, 'chat.director_reply');
      expect(reply.payload).toEqual({
        replyId: 1,
        to: 'producer',
        text: LEAD,
        generated: true,
        tools: [],
      });
      const silent = await waitForEvent(harness, scenarioId, 'chat.director_silent');
      expect(silent.payload).toEqual({ tools: [], playId: null, mode: 'notice' });
    });
  });

  it('with chat.silent_turn: none the chat gets nothing, and the event of the situation still goes out', async () => {
    await withSilentDaemon({ extra: 'chat:\n  silent_turn: none\n' }, async (harness) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, '#ot-silent-play write alpha and beta');
      const silent = await waitForEvent(harness, scenarioId, 'chat.director_silent');
      expect(ChatDirectorSilentPayloadSchema.parse(silent.payload)).toMatchObject({
        mode: 'none',
        playId: expect.stringMatching(/.+/) as unknown,
      });
      // A later turn that does speak is reply 1: the silent one took no number.
      await harness.producer.send(scenarioId, '#ot-chat hello');
      const reply = await waitForEvent(harness, scenarioId, 'chat.director_reply');
      expect(reply.payload).toEqual({ replyId: 1, to: 'producer', text: 'answer: hello' });
      expect(await eventsOf(harness, scenarioId, 'chat.director_reply')).toHaveLength(1);
    });
  });

  it('a turn with text stays as it was: no marks and no event of the situation', async () => {
    await withSilentDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat hello');
      const reply = await waitForEvent(harness, scenarioId, 'chat.director_reply');
      expect(reply.payload).toEqual({ replyId: 1, to: 'producer', text: 'answer: hello' });
      expect(await eventsOf(harness, scenarioId, 'chat.director_silent')).toEqual([]);
    });
  });
});
