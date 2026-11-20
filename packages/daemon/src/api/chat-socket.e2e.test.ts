// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import {
  ChatServerMessageSchema,
  type ChatClientMessage,
  type ChatServerMessage,
} from '@otheater/protocol';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { WebSocket as RawWebSocket } from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayHarness,
  type PlayHarnessOptions,
} from '../orchestration/e2e-fixture.js';
import { DECISION_KINDS } from '../orchestration/play-effects.js';
import { dataPaths } from '../paths.js';

/**
 * The chat WebSocket against the daemon with the fake agent (P7 of docs/17): a whole conversation
 * with a question answered, the event of the prompt queue, a connection that drops and comes back
 * with `resume`, and the tickets. The clock of the daemon is fake; the heartbeat and the wait for
 * `resume` are transport timers and run on real time, short here through the config.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/**
 * The transport timers run on real time, short here. The heartbeat is the exception: the daemon and
 * the test client share one event loop, so a stall under load would look like a missing pong and
 * end a healthy socket. Only the test of `no_pong` shortens it.
 */
const chatConfig = (heartbeat: string): string => `api:
  chat:
    resume_window: 50ms
    heartbeat: ${heartbeat}
    state_interval: 100ms
    close_grace: 200ms
`;

function withChatDaemon(
  options: PlayHarnessOptions & { readonly heartbeat?: string },
  body: (harness: PlayHarness, clock: FakeClock) => Promise<void>,
): Promise<void> {
  const clock = new FakeClock();
  return withPlayDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock,
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    { ...options, extra: `${chatConfig(options.heartbeat ?? '30s')}${options.extra ?? ''}` },
    (harness) => body(harness, clock),
  );
}

const tokenOf = async (harness: PlayHarness): Promise<string> =>
  (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();

/** `POST /v1/chat-tickets`. */
async function ticketFor(harness: PlayHarness, scenarioId: string): Promise<string> {
  const answer = await fetch(`${harness.daemon.api.url}/v1/chat-tickets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await tokenOf(harness)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ scenarioId }),
  });
  expect(answer.status).toBe(200);
  const body = (await answer.json()) as { ticket: string; expiresInMs: number };
  expect(body.expiresInMs).toBe(30_000);
  return body.ticket;
}

const socketUrl = (harness: PlayHarness, scenarioId: string, ticket: string): string =>
  `${harness.daemon.api.url.replace('http', 'ws')}/v1/scenarios/${scenarioId}/chat?ticket=${ticket}`;

/** A chat client that keeps what the daemon sent. */
class ChatClient {
  readonly frames: ChatServerMessage[] = [];
  readonly closed: Promise<number>;
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket, opened: Promise<void>) {
    this.#socket = socket;
    this.opened = opened;
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    socket.addEventListener('message', (event) => {
      this.frames.push(ChatServerMessageSchema.parse(JSON.parse(String(event.data))));
    });
  }

  readonly opened: Promise<void>;

  static async open(
    harness: PlayHarness,
    scenarioId: string,
    first?: ChatClientMessage,
  ): Promise<ChatClient> {
    const ticket = await ticketFor(harness, scenarioId);
    const socket = new WebSocket(socketUrl(harness, scenarioId, ticket));
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('the chat socket did not open'));
      });
    });
    const client = new ChatClient(socket, opened);
    await opened;
    if (first !== undefined) client.send(first);
    return client;
  }

  send(message: ChatClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  close(): Promise<number> {
    this.#socket.close(1000);
    return this.closed;
  }

  /** The first frame, from `from` on, that `match` takes. */
  next<T extends ChatServerMessage>(
    what: string,
    match: (frame: ChatServerMessage) => frame is T,
    from = 0,
  ): Promise<T> {
    return waitFor(what, () => Promise.resolve(this.frames.slice(from).find(match)));
  }

  of<Type extends ChatServerMessage['type']>(
    type: Type,
  ): Extract<ChatServerMessage, { type: Type }>[] {
    return this.frames.filter(
      (frame): frame is Extract<ChatServerMessage, { type: Type }> => frame.type === type,
    );
  }

  /** The highest `eventId` the client has got: the cursor of its `resume`. */
  get cursor(): number {
    return this.frames.reduce((top, frame) => Math.max(top, frame.eventId ?? 0), 0);
  }
}

const isAsk = (frame: ChatServerMessage): frame is Extract<ChatServerMessage, { type: 'ask' }> =>
  frame.type === 'ask';

function replyWith(client: ChatClient, text: string, from = 0) {
  return client.next(
    `a reply with "${text}"`,
    (frame): frame is Extract<ChatServerMessage, { type: 'director_reply' }> =>
      frame.type === 'director_reply' && frame.text.includes(text),
    from,
  );
}

/** The status of a WebSocket handshake, without opening a client (a refusal has no socket to read). */
function handshakeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const attempt = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    });
    attempt.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    attempt.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    attempt.on('error', reject);
    attempt.end();
  });
}

async function eventsOfType(harness: PlayHarness, type: string) {
  return (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
    (event) => event.type === type,
  );
}

describeWithLauncher('the chat WebSocket with the fake agent (P7)', { timeout: 120_000 }, () => {
  it('carries a whole conversation: a message in the queue, a question answered, the reply', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const client = await ChatClient.open(harness, scenarioId);

      // The state of the moment comes first, with an id that is a cursor, never 0.
      await client.next('the first state', (frame) => frame.type === 'busy');
      expect(client.of('waits')[0]).toMatchObject({ waits: [] });

      client.send({ type: 'message', text: '#ot-ask What color is the sky?' });
      const ask = await client.next('the question', isAsk);
      expect(ask).toMatchObject({ kind: 'producer_question' });
      expect(JSON.stringify(ask.input)).toContain('What color is the sky?');

      // The question has an event of its own, and the message carries its id.
      const askEvents = await eventsOfType(harness, 'chat.ask');
      expect(askEvents.map((event) => event.id)).toEqual([ask.eventId]);
      // The message went through the single prompt queue: that is its event.
      const queued = await eventsOfType(harness, 'prompt.queued');
      expect(queued.at(-1)).toMatchObject({
        scenarioId,
        payload: { source: 'producer' },
      });

      client.send({ type: 'answer', decisionId: ask.decisionId, answer: { answers: ['blue'] } });
      const reply = await replyWith(client, 'answer:');
      expect(reply.final).toBe(true);
      expect(
        (await eventsOfType(harness, 'chat.director_reply')).map((event) => event.id),
      ).toContain(reply.eventId);
      // Answered: it is not pending any more, and the busy flag goes down when the turn ends.
      expect(await harness.daemon.store.decisions.get(ask.decisionId)).toMatchObject({
        state: 'decided',
      });
      await waitFor('busy to go down', () =>
        Promise.resolve(client.of('busy').at(-1)?.busy === false || undefined),
      );
      // Every message that comes from an event has the id of its event, and they only grow.
      const ids = client.frames.flatMap((frame) =>
        frame.type === 'ask' || frame.type === 'director_reply' ? [frame.eventId] : [],
      );
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      await client.close();
    });
  });

  it('answers an invalid message with an error frame and keeps the socket open', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const client = await ChatClient.open(harness, scenarioId);
      (client as unknown as { send(message: unknown): void }).send({ type: 'shout' });
      const error = await client.next(
        'the error',
        (frame): frame is Extract<ChatServerMessage, { type: 'error' }> => frame.type === 'error',
      );
      expect(error).toMatchObject({ eventId: null, error: { code: 'invalid_input' } });
      // An answer to a decision that does not exist is refused the same way.
      client.send({ type: 'answer', decisionId: 'nope', answer: {} });
      await waitFor('the second error', () =>
        Promise.resolve(client.of('error').length === 2 || undefined),
      );
      expect(client.of('error')[1]?.error.code).toBe('not_found');
      const rejected = await eventsOfType(harness, 'api.client_rejected');
      expect(
        rejected.some((event) => (event.payload as { reason: string }).reason === 'message'),
      ).toBe(true);
      // Still open: a message goes through.
      client.send({ type: 'message', text: '#ot-chat still here' });
      await replyWith(client, 'still here');
      await client.close();
    });
  });

  it('a connection that drops and comes back with resume gets what it missed, once', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const first = await ChatClient.open(harness, scenarioId);
      first.send({ type: 'message', text: '#ot-chat one' });
      await replyWith(first, 'one');
      const cursor = first.cursor;
      expect(cursor).toBeGreaterThan(0);
      await first.close();
      await waitFor('the close to be recorded', async () =>
        (await eventsOfType(harness, 'api.chat_closed')).length === 1 ? true : undefined,
      );

      // While nobody is connected the Director says another thing (through the Producer channel).
      await harness.producer.send(scenarioId, '#ot-chat two');
      await waitFor('the second reply', async () =>
        (await harness.producer.poll(scenarioId, 0)).replies.some((r) => r.text.includes('two'))
          ? true
          : undefined,
      );

      const second = await ChatClient.open(harness, scenarioId, {
        type: 'resume',
        lastEventId: cursor,
      });
      await replyWith(second, 'two');
      second.send({ type: 'message', text: '#ot-chat three' });
      await replyWith(second, 'three');

      const heard = [...first.of('director_reply'), ...second.of('director_reply')].map(
        (frame) => frame.text,
      );
      // No loss and no repeat: one, two and three, each once.
      expect(heard).toHaveLength(3);
      expect(heard[0]).toContain('one');
      expect(heard[1]).toContain('two');
      expect(heard[2]).toContain('three');
      // Nothing the first connection had comes again; the state messages carry the cursor itself.
      for (const frame of second.frames) {
        if (frame.type === 'waits' || frame.type === 'busy') {
          expect(frame.eventId).toBeGreaterThanOrEqual(cursor);
        } else if (frame.eventId !== null) {
          expect(frame.eventId).toBeGreaterThan(cursor);
        }
      }
      await second.close();
    });
  });

  it('tells a new connection what is pending, and a resume past the question tells it once more, with the cursor', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const first = await ChatClient.open(harness, scenarioId);
      first.send({ type: 'message', text: '#ot-ask Which name?' });
      const ask = await first.next('the question', isAsk);
      await first.close();

      // Nothing to resume from: the open question comes first, in the state of the moment.
      const second = await ChatClient.open(harness, scenarioId);
      const again = await second.next('the question again', isAsk);
      expect(again.decisionId).toBe(ask.decisionId);
      await second.close();

      // N179, item 3: a resume past the question still tells what is pending, from the state of the
      // store, once. The frame carries the cursor of the resume, so a client never jumps over an
      // event it has not got. A client has the question already; it matches it by `decisionId`.
      const third = await ChatClient.open(harness, scenarioId, {
        type: 'resume',
        lastEventId: ask.eventId,
      });
      await third.next('the state', (frame) => frame.type === 'busy');
      expect(third.of('ask').map((frame) => [frame.decisionId, frame.eventId])).toEqual([
        [ask.decisionId, ask.eventId],
      ]);
      third.send({ type: 'answer', decisionId: ask.decisionId, answer: { answers: ['Ada'] } });
      await replyWith(third, 'answer:');
      await third.close();
    });
  });

  it('tells a resume the question once when its event is in the replay and the state has it too', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const before = await harness.daemon.store.events.lastId();
      const first = await ChatClient.open(harness, scenarioId);
      first.send({ type: 'message', text: '#ot-ask Which name?' });
      const ask = await first.next('the question', isAsk);
      await first.close();

      // The cursor is before the question: the replay brings its `chat.ask`, and the state has it.
      const second = await ChatClient.open(harness, scenarioId, {
        type: 'resume',
        lastEventId: before,
      });
      await second.next('the state', (frame) => frame.type === 'busy');
      await second.next('the question', isAsk);
      expect(second.of('ask').map((frame) => [frame.decisionId, frame.eventId])).toEqual([
        [ask.decisionId, ask.eventId],
      ]);
      await second.close();
    });
  });

  it('a decision with no chat.ask event reaches a resume, from the state of the store (N179, item 3)', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      // `daemon.store` is the store before the chat decorator: this decision has no `chat.ask`, like
      // one made before the event existed or whose event was not written.
      await harness.daemon.store.decisions.create({
        id: 'D-silent',
        scenarioId,
        kind: DECISION_KINDS.menu,
        input: {},
      });
      expect(await eventsOfType(harness, 'chat.ask')).toEqual([]);
      const cursor = await harness.daemon.store.events.lastId();

      const client = await ChatClient.open(harness, scenarioId, {
        type: 'resume',
        lastEventId: cursor,
      });
      await client.next('the state', (frame) => frame.type === 'busy');
      expect(client.of('ask').map((frame) => [frame.decisionId, frame.eventId])).toEqual([
        ['D-silent', cursor],
      ]);
      await client.close();
    });
  });

  it('takes a question back from the other clients when one of them answers it (N179, item 2)', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const one = await ChatClient.open(harness, scenarioId);
      const other = await ChatClient.open(harness, scenarioId);
      one.send({ type: 'message', text: '#ot-ask Which name?' });
      const ask = await one.next('the question', isAsk);
      await other.next('the same question', isAsk);

      other.send({ type: 'answer', decisionId: ask.decisionId, answer: { answers: ['Ada'] } });
      const closed = await one.next(
        'the withdrawal',
        (frame): frame is Extract<ChatServerMessage, { type: 'ask_closed' }> =>
          frame.type === 'ask_closed',
      );
      expect(closed).toMatchObject({ decisionId: ask.decisionId, state: 'decided' });
      expect(closed.eventId).toBeGreaterThan(ask.eventId);
      // It is an event of the log, and the one that answered is told too (it ignores a question it
      // answered itself).
      const events = await eventsOfType(harness, 'chat.ask_closed');
      expect(events.map((event) => event.id)).toEqual([closed.eventId]);
      expect((await other.next('its own', (frame) => frame.type === 'ask_closed')).eventId).toBe(
        closed.eventId,
      );

      // A resume from before the question brings both events, and no question to show.
      const late = await ChatClient.open(harness, scenarioId, {
        type: 'resume',
        lastEventId: ask.eventId - 1,
      });
      await late.next('the withdrawal again', (frame) => frame.type === 'ask_closed');
      expect(late.of('ask')).toEqual([]);
      await Promise.all([one.close(), other.close(), late.close()]);
    });
  });

  it('takes a question back from the clients when the REST route answers it', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const client = await ChatClient.open(harness, scenarioId);
      client.send({ type: 'message', text: '#ot-ask Which name?' });
      const ask = await client.next('the question', isAsk);

      const answered = await fetch(
        `${harness.daemon.api.url}/v1/decisions/${ask.decisionId}/answer`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await tokenOf(harness)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ answer: { answers: ['Ada'] } }),
        },
      );
      expect(answered.status).toBe(200);
      const closed = await client.next(
        'the withdrawal',
        (frame): frame is Extract<ChatServerMessage, { type: 'ask_closed' }> =>
          frame.type === 'ask_closed',
      );
      expect(closed).toMatchObject({ decisionId: ask.decisionId, state: 'decided' });

      expect(client.of('ask_closed')).toHaveLength(1);
      await client.close();
    });
  });

  it('a resume from the snapshot of openScenario gets the reply made before the socket opened (N179, item 1)', async () => {
    await withChatDaemon({}, async (harness) => {
      const opened = await harness.producer.openChat({ type: 'chat', name: 'talk' });
      const { scenarioId } = opened;
      expect(opened.lastEventId).toBeGreaterThan(0);
      expect(opened.lastEventId).toBeLessThanOrEqual(await harness.daemon.store.events.lastId());

      // The Director answers between the snapshot and the socket.
      await harness.producer.send(scenarioId, '#ot-chat early');
      await waitFor('the early reply', async () =>
        (await harness.producer.poll(scenarioId, 0)).replies.some((r) => r.text.includes('early'))
          ? true
          : undefined,
      );

      // With no cursor the socket starts at the head and never hears it...
      const blind = await ChatClient.open(harness, scenarioId);
      await blind.next('the state', (frame) => frame.type === 'busy');
      // ...and with the cursor of the snapshot it does, once.
      const client = await ChatClient.open(harness, scenarioId, {
        type: 'resume',
        lastEventId: opened.lastEventId,
      });
      const reply = await replyWith(client, 'early');
      expect(reply.eventId).toBeGreaterThan(opened.lastEventId);
      client.send({ type: 'message', text: '#ot-chat later' });
      await replyWith(client, 'later');
      expect(
        client.of('director_reply').filter((frame) => frame.text.includes('early')),
      ).toHaveLength(1);
      expect(blind.of('director_reply').filter((frame) => frame.text.includes('early'))).toEqual(
        [],
      );
      await Promise.all([blind.close(), client.close()]);
    });
  });

  it('refuses a ticket used twice, one that expired, one for another scenario and none at all', async () => {
    await withChatDaemon({}, async (harness, clock) => {
      const scenarioId = await harness.openGenericChat('talk');
      const other = await harness.openGenericChat('other');
      const url = (ticket: string, id = scenarioId) => socketUrl(harness, id, ticket);

      const once = await ticketFor(harness, scenarioId);
      expect(await handshakeStatus(url(once))).toBe(101);
      expect(await handshakeStatus(url(once))).toBe(401);

      const late = await ticketFor(harness, scenarioId);
      await clock.advance(30_001);
      expect(await handshakeStatus(url(late))).toBe(401);

      const wrong = await ticketFor(harness, other);
      expect(await handshakeStatus(url(wrong))).toBe(401);
      // The ticket is spent even by a try for the wrong scenario.
      expect(await handshakeStatus(url(wrong, other))).toBe(401);

      expect(await handshakeStatus(url(''))).toBe(401);
      expect(await handshakeStatus(url('short'))).toBe(401);

      // Every refusal is an event, and neither a ticket nor the token is in the log.
      const rejected = (await eventsOfType(harness, 'api.client_rejected')).filter(
        (event) => (event.payload as { reason: string }).reason === 'ticket',
      );
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      const log = JSON.stringify(await harness.daemon.store.events.readFrom(0, 100_000));
      expect(log).not.toContain(once);
      expect(log).not.toContain(await tokenOf(harness));
    });
  });

  it('issues a ticket only with the token, and only for a scenario that exists', async () => {
    await withChatDaemon({}, async (harness) => {
      const post = (scenarioId: string, token?: string) =>
        fetch(`${harness.daemon.api.url}/v1/chat-tickets`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify({ scenarioId }),
        });
      const scenarioId = await harness.openGenericChat('talk');
      expect((await post(scenarioId)).status).toBe(401);
      expect((await post('no-such-scenario', await tokenOf(harness))).status).toBe(404);
      expect((await post(scenarioId, await tokenOf(harness))).status).toBe(200);
      // The route of the socket itself, with the token and no upgrade, is not the way in.
      const plain = await fetch(
        `${harness.daemon.api.url}/v1/scenarios/${scenarioId}/chat?ticket=${'a'.repeat(20)}`,
        { headers: { authorization: `Bearer ${await tokenOf(harness)}` } },
      );
      expect(plain.status).toBe(400);
    });
  });

  it('ends a socket that does not answer the ping, and records why', async () => {
    await withChatDaemon({ heartbeat: '150ms' }, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const ticket = await ticketFor(harness, scenarioId);
      const socket = new RawWebSocket(socketUrl(harness, scenarioId, ticket), { autoPong: false });
      const closed = new Promise<void>((resolve) => {
        socket.on('close', () => {
          resolve();
        });
        socket.on('error', () => undefined);
      });
      await closed;
      const event = await waitFor('the close event', async () =>
        (await eventsOfType(harness, 'api.chat_closed')).at(0),
      );
      expect(event).toMatchObject({ scenarioId, payload: { reason: 'no_pong' } });
    });
  });

  it('closes the open sockets when the token is rotated', async () => {
    await withChatDaemon({}, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      const client = await ChatClient.open(harness, scenarioId);
      const spare = await ticketFor(harness, scenarioId);
      const answer = await fetch(`${harness.daemon.api.url}/v1/api-token/rotate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await tokenOf(harness)}` },
      });
      expect(answer.status).toBe(200);
      expect(await client.closed).toBe(1008);
      // A ticket the old token got is no good either.
      expect(await handshakeStatus(socketUrl(harness, scenarioId, spare))).toBe(401);
      const event = await waitFor('the close event', async () =>
        (await eventsOfType(harness, 'api.chat_closed')).at(0),
      );
      expect(event).toMatchObject({ payload: { reason: 'token_rotated', code: 1008 } });
    });
  });

  it('an open socket counts as a Producer watching: the delivery question comes over it and waits', async () => {
    await withChatDaemon(
      { extra: 'delivery:\n  mode: ask\n  allow_direct_merge: true\n' },
      async (harness, clock) => {
        const scenarioId = await harness.openChat();
        const client = await ChatClient.open(harness, scenarioId);
        client.send({ type: 'message', text: '#ot-play write alpha and beta' });
        const menu = await client.next(
          'the delivery menu',
          (frame): frame is Extract<ChatServerMessage, { type: 'ask' }> =>
            frame.type === 'ask' && frame.kind === 'producer_menu',
        );
        expect(menu.playId).not.toBeNull();
        expect(client.of('play_state').map((frame) => frame.state)).toContain('DELIVERING');
        const playId = menu.playId ?? '';
        // Nobody polls, and the window of a poll goes by: the socket is what keeps the Producer here.
        await clock.advance(120_000);
        expect((await harness.daemon.store.plays.get(playId))?.state).toBe('AWAITING_PRODUCER');
        client.send({
          type: 'answer',
          decisionId: menu.decisionId,
          answer: { option: 'deliver_pr' },
        });
        await client.next(
          'the end of the play',
          (frame): frame is Extract<ChatServerMessage, { type: 'play_state' }> =>
            frame.type === 'play_state' && frame.state === 'DONE',
        );
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
        await client.close();
      },
    );
  });
});
