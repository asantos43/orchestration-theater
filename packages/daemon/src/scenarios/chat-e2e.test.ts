// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../orchestration/e2e-fixture.js';

/**
 * The chat tests of architecture section 10 with the fake agent (P12): a simple question is
 * answered by the Director, a hard one opens the consultant, an image only goes to a client that
 * accepts images, and the Director sleeps and wakes without losing its state. The fake agent is
 * the compiled `dist/cli.js`, so `pnpm build` comes first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** A second client that declares it accepts images; the Director's client (`fake`) does not. */
const VISION = 'fake-vision';

const VISION_ALTERNATIVE = `
scenarios:
  consultant_alternatives:
    - client: ${VISION}
      profile: one
      model: fake-model
`;

function withChatDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness, clock: FakeClock) => Promise<void>,
): Promise<void> {
  const clock = new FakeClock();
  const fakes: PlayFakes = {
    codeHost: new FakeCodeHost(),
    clock,
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) => [
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
      new FakeClientAdapter({
        id: VISION,
        capabilities: { inputTypes: ['image'] },
        launcher,
        baseEnv: {},
        env,
        adapterVersion: '1.0.0',
        command,
      }),
    ],
  };
  return withDaemon(fakes, options, (harness) => body(harness, clock));
}

async function repliesOf(harness: PlayHarness, scenarioId: string): Promise<string[]> {
  return (await harness.producer.poll(scenarioId, 0)).replies.map((reply) => reply.text);
}

async function waitForReply(
  harness: PlayHarness,
  scenarioId: string,
  text: string,
): Promise<string> {
  return waitFor(`a reply with "${text}"`, async () =>
    (await repliesOf(harness, scenarioId)).find((reply) => reply.includes(text)),
  );
}

async function transitionsOf(harness: PlayHarness, scenarioId: string): Promise<string[]> {
  return (await harness.daemon.store.events.readFrom(0, 100_000))
    .filter((event) => event.type === 'scenario.chat_transitioned')
    .filter((event) => event.scenarioId === scenarioId)
    .map((event) => {
      const payload = event.payload as { from: string; to: string };
      return `${payload.from}>${payload.to}`;
    });
}

async function attemptClients(harness: PlayHarness, role: string): Promise<string[]> {
  return (await harness.daemon.store.attempts.list())
    .filter((attempt) => attempt.demandId.startsWith(`${role}-`))
    .map((attempt) => attempt.client);
}

// A one-pixel PNG: the magic bytes are what the daemon takes the type from.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

describe('the chat flow with the fake agent (P12)', { timeout: 120_000 }, () => {
  it('answers a simple question with the Director alone', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      expect(await harness.daemon.store.scenarios.get(scenarioId)).toMatchObject({
        kind: 'chat',
        flowId: 'chat',
      });
      await harness.producer.send(scenarioId, '#ot-chat what is two and two');
      await waitForReply(harness, scenarioId, 'answer: what is two and two');
      expect(await attemptClients(harness, 'consult')).toEqual([]);
      expect(await transitionsOf(harness, scenarioId)).toEqual([]);
      expect(await harness.daemon.store.decisions.list({ scenarioId })).toEqual([]);
    });
  });

  it('opens the consultant on a hard question: CONSULTING, then back to IDLE', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-consult how should we shard this table');
      const reply = await waitForReply(harness, scenarioId, 'consulted');
      expect(reply).toContain('consulted on \\"how should we shard this table\\"');

      const decisions = await harness.daemon.store.decisions.list({ scenarioId });
      expect(decisions.map((d) => [d.kind, d.state])).toEqual([['chat.consult', 'decided']]);
      await waitFor('the way back', async () =>
        (await transitionsOf(harness, scenarioId)).length === 2 ? true : undefined,
      );
      expect(await transitionsOf(harness, scenarioId)).toEqual([
        'IDLE>CONSULTING',
        'CONSULTING>IDLE',
      ]);
      expect(await attemptClients(harness, 'consult')).toEqual(['fake']);
    });
  });

  it('sends an image only to a client that accepts images', async () => {
    await withChatDaemon({ extra: VISION_ALTERNATIVE }, async (harness) => {
      const dir = await mkdtemp(join(tmpdir(), 'otheater-p12-'));
      try {
        const file = join(dir, 'diagram.png');
        await writeFile(file, PNG);
        const scenarioId = await harness.openGenericChat('talk');
        const attachment = await harness.producer.attach(scenarioId, { path: file });
        expect(attachment).toMatchObject({ id: 'A1', mime: 'image/png' });

        // The Director's own client (`fake`) does not accept images, so the consultation goes to
        // the alternative that does.
        await harness.producer.send(scenarioId, '#ot-consult what is in it\n#ot-attach A1');
        const reply = await waitForReply(harness, scenarioId, 'A1 is image/png');
        expect(reply).toContain('consulted');
        expect(await attemptClients(harness, 'consult')).toEqual([VISION]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('refuses the consultation of an image when no client accepts images', async () => {
    await withChatDaemon({}, async (harness) => {
      const dir = await mkdtemp(join(tmpdir(), 'otheater-p12-'));
      try {
        const file = join(dir, 'diagram.png');
        await writeFile(file, PNG);
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.attach(scenarioId, { path: file });
        await harness.producer.send(scenarioId, '#ot-consult what is in it\n#ot-attach A1');
        const reply = await waitForReply(harness, scenarioId, 'consult refused');
        expect(reply).toContain('no_executor_for_attachments');
        expect(await attemptClients(harness, 'consult')).toEqual([]);
        expect(await transitionsOf(harness, scenarioId)).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('lets the consultant read a text attachment', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const note = await harness.producer.attach(scenarioId, {
        text: 'the budget is nine',
        name: 'note.txt',
      });
      await harness.producer.send(scenarioId, '#ot-consult what is the budget\n#ot-attach A1', [
        note.id,
      ]);
      await waitForReply(harness, scenarioId, 'A1 says the budget is nine');
    });
  });

  it('lets the Director read a text attachment itself, but not an image (N85)', async () => {
    await withChatDaemon({}, async (harness) => {
      const dir = await mkdtemp(join(tmpdir(), 'otheater-n85-'));
      try {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.attach(scenarioId, { text: 'the budget is nine', name: 'note.txt' });
        const file = join(dir, 'diagram.png');
        await writeFile(file, PNG);
        await harness.producer.attach(scenarioId, { path: file });
        await harness.producer.send(scenarioId, '#ot-read A1 A2');
        await waitForReply(harness, scenarioId, 'read A1: ok');
        const refused = await waitForReply(harness, scenarioId, 'read A2: refused');
        expect(refused).toContain('director_text_only');
        expect(await attemptClients(harness, 'consult')).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('sleeps after the idle time and wakes with the state summary, without losing the replies', async () => {
    await withChatDaemon({}, async (harness, clock) => {
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(harness, scenarioId, 'answer: first');

      await waitFor('the Director to sleep', async () => {
        await clock.advance(15 * 60_000);
        const scenario = await harness.daemon.store.scenarios.get(scenarioId);
        return scenario?.directorState === 'asleep' ? true : undefined;
      });
      const events = async (type: string) =>
        (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
          (event) => event.type === type && event.scenarioId === scenarioId,
        );
      expect(await events('scenario.director_slept')).toHaveLength(1);

      await harness.producer.send(scenarioId, '#ot-chat second');
      await waitForReply(harness, scenarioId, 'answer: second');
      const replies = await repliesOf(harness, scenarioId);
      expect(replies).toContain('answer: first');
      expect(replies.some((reply) => reply.includes(`woke with the state of ${scenarioId}`))).toBe(
        true,
      );
      expect(await events('scenario.director_woke')).toHaveLength(1);
      expect((await harness.daemon.store.scenarios.get(scenarioId))?.directorState).toBe('active');
    });
  });

  it('never sleeps when director_idle_after is 0', async () => {
    await withChatDaemon(
      { extra: 'scenarios:\n  director_idle_after: 0' },
      async (harness, clock) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, '#ot-chat first');
        await waitForReply(harness, scenarioId, 'answer: first');
        await clock.advance(24 * 60 * 60_000);
        expect((await harness.daemon.store.scenarios.get(scenarioId))?.directorState).toBe(
          'active',
        );
      },
    );
  });
});
