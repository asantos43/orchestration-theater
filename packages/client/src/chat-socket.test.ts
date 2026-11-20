// SPDX-License-Identifier: MPL-2.0
import type { ChatServerMessage, ChatTicket } from '@otheater/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import { ChatSocket, type ChatSocketOptions, type ChatSocketTarget } from './chat-socket.js';
import type { ConnectionDetail, ConnectionState } from './connection.js';
import {
  ApiInputError,
  ApiNetworkError,
  ApiProtocolError,
  ApiRequestError,
  ChatNotOpenError,
} from './errors.js';
import { createFakeSockets, type FakeWebSocket } from './fake-websocket.test-support.js';
import { startTestDaemon, type TestDaemon } from './test-daemon.test-support.js';
import { createTestClock, waitFor, type TestClock } from './test-clock.test-support.js';

const chats: ChatSocket[] = [];
const daemons: TestDaemon[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const chat of chats.splice(0)) chat.close();
  for (const daemon of daemons.splice(0)) await daemon.close();
});

const ticketNumber = (n: number): string => `ticket-${String(n).padStart(12, '0')}`;

interface Rig {
  readonly chat: ChatSocket;
  readonly clock: TestClock;
  readonly sockets: FakeWebSocket[];
  /** The scenario ids the ticket call was made for, one per call. */
  readonly tickets: string[];
  readonly messages: ChatServerMessage[];
  readonly states: ConnectionState[];
  readonly details: ConnectionDetail[];
}

function rig(
  options: ChatSocketOptions = {},
  extra: {
    scenarioId?: string;
    url?: string;
    createTicket?: (call: number, signal: AbortSignal) => Promise<ChatTicket>;
  } = {},
): Rig {
  const clock = createTestClock();
  const { Socket, sockets } = createFakeSockets();
  const tickets: string[] = [];
  const target: ChatSocketTarget = {
    url: extra.url ?? 'http://127.0.0.1:7777',
    webSocket: Socket,
    createTicket: (id, signal) => {
      tickets.push(id);
      const call = tickets.length;
      return extra.createTicket === undefined
        ? Promise.resolve({ ticket: ticketNumber(call), expiresInMs: 30_000 })
        : extra.createTicket(call, signal);
    },
  };
  const chat = new ChatSocket(target, extra.scenarioId ?? 'S1', {
    clock,
    random: () => 0.5,
    ...options,
  });
  chats.push(chat);
  const messages: ChatServerMessage[] = [];
  const states: ConnectionState[] = [];
  const details: ConnectionDetail[] = [];
  chat.onMessage((message) => messages.push(message));
  chat.onState((state, detail) => {
    states.push(state);
    details.push(detail);
  });
  return { chat, clock, sockets, tickets, messages, states, details };
}

/** Waits for the nth socket of the client and opens it, as the daemon accepting the upgrade does. */
async function openSocket(sockets: FakeWebSocket[], index = 0): Promise<FakeWebSocket> {
  await waitFor(() => sockets.length > index, `socket ${String(index)}`);
  const socket = sockets[index];
  if (socket === undefined) throw new Error('unreachable');
  socket.open();
  return socket;
}

const busy = (eventId: number): ChatServerMessage => ({ type: 'busy', eventId, busy: true });
const failedTicket = (status: number, retryAfterSeconds?: number): ApiRequestError =>
  new ApiRequestError({
    status,
    body: {
      code: status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : 'unavailable',
      message: 'no',
    },
    retryAfterSeconds,
  });

describe('ChatSocket: connecting', () => {
  it('trades for a ticket, opens ws://host/v1/scenarios/:id/chat?ticket=, and goes connecting then open', async () => {
    const { chat, sockets, tickets, states } = rig();
    chat.start();
    const socket = await openSocket(sockets);
    expect(tickets).toEqual(['S1']);
    expect(socket.url).toBe(`ws://127.0.0.1:7777/v1/scenarios/S1/chat?ticket=${ticketNumber(1)}`);
    expect(states).toEqual(['connecting', 'open']);
    // No cursor, so nothing to resume.
    expect(socket.sent).toEqual([]);
  });

  it('uses wss for https and keeps a path prefix of the daemon', async () => {
    const { chat, sockets } = rig({}, { url: 'https://daemon.example/prefix/', scenarioId: 'S-2' });
    chat.start();
    const socket = await openSocket(sockets);
    expect(socket.url).toBe(
      `wss://daemon.example/prefix/v1/scenarios/S-2/chat?ticket=${ticketNumber(1)}`,
    );
  });

  it('refuses a scenario id outside the contract before doing anything', () => {
    const { Socket } = createFakeSockets();
    const target: ChatSocketTarget = {
      url: 'http://127.0.0.1:1',
      webSocket: Socket,
      createTicket: () => Promise.reject(new Error('never')),
    };
    expect(() => new ChatSocket(target, '')).toThrow(ApiInputError);
  });

  it('closes for good when the runtime has no WebSocket', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const clock = createTestClock();
    const chat = new ChatSocket(
      {
        url: 'http://127.0.0.1:1',
        createTicket: () => Promise.resolve({ ticket: ticketNumber(1), expiresInMs: 1000 }),
      },
      'S1',
      { clock },
    );
    chats.push(chat);
    chat.start();
    await chat.done;
    expect(clock.sleeps).toEqual([]);
    expect(chat.detail.error).toBeInstanceOf(ApiNetworkError);
    expect(chat.detail.error?.message).toContain('no WebSocket');
  });
});

describe('ChatSocket: receiving', () => {
  it('delivers the messages of the daemon in order, and the cursor follows the highest eventId', async () => {
    const { chat, sockets, messages } = rig();
    chat.start();
    const socket = await openSocket(sockets);
    socket.receive(busy(5));
    socket.receive({ type: 'play_state', eventId: 6, playId: 'P1', state: 'WORK' });
    socket.receive({ type: 'director_reply', eventId: 7, replyId: 1, text: 'hi', final: true });
    socket.receive({ type: 'error', eventId: null, error: { code: 'internal', message: 'oops' } });
    expect(messages.map((message) => message.type)).toEqual([
      'busy',
      'play_state',
      'director_reply',
      'error',
    ]);
    expect(chat.lastEventId).toBe(7);
    socket.receive(busy(3));
    expect(chat.lastEventId).toBe(7);
  });

  it('is not taken down by a listener that throws', async () => {
    const { chat, sockets, messages } = rig();
    chat.onMessage(() => {
      throw new Error('faulty screen');
    });
    chat.start();
    const socket = await openSocket(sockets);
    socket.receive(busy(1));
    socket.receive(busy(2));
    expect(messages).toHaveLength(2);
    expect(chat.state).toBe('open');
  });

  it.each([
    ['text that is not JSON', 'not json at all', 'invalid_json'],
    ['a type the contract does not have', { type: 'weather', eventId: 1 }, 'invalid_response'],
    [
      'a message with a field too many',
      { type: 'busy', eventId: 1, busy: true, extra: 1 },
      'invalid_response',
    ],
    [
      'an eventId that is not a number',
      { type: 'busy', eventId: 'x', busy: true },
      'invalid_response',
    ],
    [
      'an error with an eventId',
      { type: 'error', eventId: 4, error: { code: 'internal', message: 'm' } },
      'invalid_response',
    ],
  ] as const)(
    'closes with a typed error and 1002, without retrying, on %s',
    async (_name, frame, reason) => {
      const { chat, sockets, clock, messages } = rig();
      chat.start();
      const socket = await openSocket(sockets);
      socket.receive(busy(1));
      socket.receive(frame);
      await chat.done;
      expect(chat.state).toBe('closed');
      expect(clock.sleeps).toEqual([]);
      expect(sockets).toHaveLength(1);
      expect(socket.closes[0]?.code).toBe(1002);
      expect(messages).toHaveLength(1);
      expect(chat.detail.error).toBeInstanceOf(ApiProtocolError);
      expect(chat.detail.error).toMatchObject({ reason });
    },
  );

  it('closes with invalid_stream on a binary frame', async () => {
    const { chat, sockets } = rig();
    chat.start();
    const socket = await openSocket(sockets);
    socket.receiveBinary(new Uint8Array([1, 2, 3]));
    await chat.done;
    expect(chat.detail.error).toMatchObject({ reason: 'invalid_stream' });
  });

  it('with invalidMessages skip, drops the bad message, tells onInvalid and goes on', async () => {
    const { chat, sockets, messages } = rig({ invalidMessages: 'skip' });
    const invalid: unknown[] = [];
    chat.onInvalid((error) => {
      invalid.push(error);
    });
    chat.start();
    const socket = await openSocket(sockets);
    socket.receive('{broken');
    socket.receive({ type: 'nope' });
    socket.receiveBinary(new Uint8Array([0]));
    socket.receive(busy(9));
    expect(invalid).toHaveLength(3);
    expect(messages.map((message) => message.eventId)).toEqual([9]);
    expect(chat.state).toBe('open');
    expect(socket.closes).toEqual([]);
  });
});

describe('ChatSocket: sending', () => {
  it('sends a valid message as JSON, once the socket is open', async () => {
    const { chat, sockets } = rig();
    chat.start();
    const socket = await openSocket(sockets);
    chat.send({ type: 'message', text: 'hello', attachments: ['A1'] });
    chat.send({ type: 'answer', decisionId: 'D1', answer: { option: 'approve' } });
    chat.send({ type: 'command', text: '/idea add something' });
    expect(socket.sentMessages()).toEqual([
      { type: 'message', text: 'hello', attachments: ['A1'] },
      { type: 'answer', decisionId: 'D1', answer: { option: 'approve' } },
      { type: 'command', text: '/idea add something' },
    ]);
  });

  it('throws ChatNotOpenError, and queues nothing, before the socket is open and after a drop', async () => {
    const { chat, sockets } = rig();
    expect(() => {
      chat.send({ type: 'message', text: 'too early' });
    }).toThrow(ChatNotOpenError);
    chat.start();
    const first = await openSocket(sockets);
    first.drop();
    await waitFor(() => sockets.length === 2, 'the new socket');
    expect(() => {
      chat.send({ type: 'message', text: 'during the drop' });
    }).toThrow(ChatNotOpenError);
    const second = await openSocket(sockets, 1);
    expect(second.sent).toEqual([]);
    chat.send({ type: 'message', text: 'now' });
    expect(second.sentMessages()).toEqual([{ type: 'message', text: 'now' }]);
  });

  it('refuses what is outside the contract with ApiInputError, and sends nothing', async () => {
    const { chat, sockets } = rig();
    chat.start();
    const socket = await openSocket(sockets);
    const bad: unknown[] = [
      { type: 'command', text: 'no slash' },
      { type: 'message' },
      { type: 'message', text: 'x', extra: true },
      { type: 'answer', decisionId: '', answer: {} },
      { type: 'weather' },
    ];
    for (const message of bad) {
      expect(() => {
        chat.send(message as never);
      }).toThrow(ApiInputError);
    }
    // `resume` is valid for the contract, but it is the client's own business.
    expect(() => {
      chat.send({ type: 'resume', lastEventId: 3 } as never);
    }).toThrow(ApiInputError);
    expect(socket.sent).toEqual([]);
  });

  it('throws ChatNotOpenError after close()', async () => {
    const { chat, sockets } = rig();
    chat.start();
    await openSocket(sockets);
    chat.close();
    expect(() => {
      chat.send({ type: 'message', text: 'late' });
    }).toThrow(ChatNotOpenError);
  });
});

describe('ChatSocket: reconnection', () => {
  it('comes back with a new ticket and sends resume with the last eventId as its first frame', async () => {
    const { chat, sockets, tickets, clock, states, details, messages } = rig();
    chat.start();
    const first = await openSocket(sockets);
    first.receive(busy(4));
    first.receive(busy(5));
    first.drop(1006);
    const second = await openSocket(sockets, 1);
    expect(tickets).toEqual(['S1', 'S1']);
    expect(second.url).toBe(`ws://127.0.0.1:7777/v1/scenarios/S1/chat?ticket=${ticketNumber(2)}`);
    expect(second.sentMessages()).toEqual([{ type: 'resume', lastEventId: 5 }]);
    second.receive(busy(6));
    expect(messages.map((message) => message.eventId)).toEqual([4, 5, 6]);
    expect(clock.sleeps).toEqual([1000]);
    expect(states).toEqual(['connecting', 'open', 'retrying', 'connecting', 'open']);
    expect(details[2]?.error).toBeInstanceOf(ApiNetworkError);
    expect(details[2]?.error?.message).toContain('1006');
  });

  it('sends the first resume from resumeFrom, and again after a drop with no message', async () => {
    const { chat, sockets } = rig({ resumeFrom: 40 });
    chat.start();
    const first = await openSocket(sockets);
    expect(first.sentMessages()).toEqual([{ type: 'resume', lastEventId: 40 }]);
    first.drop();
    const second = await openSocket(sockets, 1);
    expect(second.sentMessages()).toEqual([{ type: 'resume', lastEventId: 40 }]);
  });

  it('sends no resume after a drop when it never had an event', async () => {
    const { chat, sockets } = rig();
    chat.start();
    (await openSocket(sockets)).drop();
    const second = await openSocket(sockets, 1);
    expect(second.sent).toEqual([]);
  });

  it('does not move the cursor for a message of error', async () => {
    const { chat, sockets } = rig();
    chat.start();
    const first = await openSocket(sockets);
    first.receive(busy(8));
    first.receive({ type: 'error', eventId: null, error: { code: 'internal', message: 'm' } });
    first.drop();
    const second = await openSocket(sockets, 1);
    expect(second.sentMessages()).toEqual([{ type: 'resume', lastEventId: 8 }]);
  });

  it('retries with a growing wait while the socket never opens, and starts over once it does', async () => {
    const { chat, sockets, clock, details } = rig();
    chat.start();
    await waitFor(() => sockets.length === 1, 'socket 0');
    sockets[0]?.drop(1006);
    await waitFor(() => sockets.length === 2, 'socket 1');
    sockets[1]?.drop(1006);
    await waitFor(() => sockets.length === 3, 'socket 2');
    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(details.find((entry) => entry.error !== undefined)?.error?.message).toContain(
      'did not open',
    );
    const third = await openSocket(sockets, 2);
    third.drop();
    await waitFor(() => sockets.length === 4, 'socket 3');
    expect(clock.sleeps).toEqual([1000, 2000, 1000]);
  });

  it('gives up after maxRetries and says why', async () => {
    const { chat, sockets } = rig({ maxRetries: 1 });
    chat.start();
    await waitFor(() => sockets.length === 1, 'socket 0');
    sockets[0]?.drop();
    await waitFor(() => sockets.length === 2, 'socket 1');
    sockets[1]?.drop();
    await chat.done;
    expect(chat.state).toBe('closed');
    expect(chat.detail.error).toBeInstanceOf(ApiNetworkError);
  });
});

describe('ChatSocket: the ticket', () => {
  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
  ] as const)('does not retry after a %i on the ticket', async (status, code) => {
    const { chat, sockets, clock, tickets } = rig(
      {},
      { createTicket: () => Promise.reject(failedTicket(status)) },
    );
    chat.start();
    await chat.done;
    expect(tickets).toHaveLength(1);
    expect(sockets).toHaveLength(0);
    expect(clock.sleeps).toEqual([]);
    expect(chat.detail.error).toMatchObject({ status, code });
  });

  it('honours Retry-After of a 503 on the ticket', async () => {
    const { chat, sockets, clock, tickets } = rig(
      {},
      {
        createTicket: (call) =>
          call === 1
            ? Promise.reject(failedTicket(503, 7))
            : Promise.resolve({ ticket: ticketNumber(call), expiresInMs: 30_000 }),
      },
    );
    chat.start();
    await openSocket(sockets);
    expect(tickets).toHaveLength(2);
    expect(clock.sleeps).toEqual([7000]);
  });

  it('retries after a network failure of the ticket call, and a reply that is not the contract is not retried', async () => {
    const network = rig(
      {},
      {
        createTicket: (call) =>
          call === 1
            ? Promise.reject(new ApiNetworkError({ reason: 'connection', origin: 'http://x' }))
            : Promise.resolve({ ticket: ticketNumber(call), expiresInMs: 30_000 }),
      },
    );
    network.chat.start();
    await openSocket(network.sockets);
    expect(network.clock.sleeps).toEqual([1000]);

    const protocol = rig(
      {},
      {
        createTicket: () =>
          Promise.reject(new ApiProtocolError({ reason: 'invalid_response', status: 200 })),
      },
    );
    protocol.chat.start();
    await protocol.chat.done;
    expect(protocol.tickets).toHaveLength(1);
    expect(protocol.chat.detail.error).toBeInstanceOf(ApiProtocolError);

    const odd = rig({}, { createTicket: () => Promise.reject(new TypeError('bug')) });
    odd.chat.start();
    await odd.chat.done;
    expect(odd.chat.detail.error?.message).toContain('the ticket call failed');
  });
});

describe('ChatSocket: closing', () => {
  it('close() says 1000 to the daemon, resolves done and never connects again', async () => {
    const { chat, sockets, states } = rig();
    chat.start();
    const socket = await openSocket(sockets);
    chat.close();
    await chat.done;
    expect(socket.closes[0]?.code).toBe(1000);
    expect(states.at(-1)).toBe('closed');
    expect(chat.detail.error).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toHaveLength(1);
  });

  it('close() while the ticket call is in flight ends without opening a socket', async () => {
    const { chat, sockets, tickets } = rig(
      {},
      {
        createTicket: (_call, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new ApiNetworkError({ reason: 'aborted', origin: 'http://x' }));
            });
          }),
      },
    );
    chat.start();
    await waitFor(() => tickets.length === 1, 'the ticket call');
    chat.close();
    await chat.done;
    expect(sockets).toHaveLength(0);
    expect(chat.state).toBe('closed');
  });

  it('the abort signal closes the chat', async () => {
    const abort = new AbortController();
    const { chat, sockets } = rig({ signal: abort.signal });
    chat.start();
    const socket = await openSocket(sockets);
    abort.abort();
    await chat.done;
    expect(socket.closes[0]?.code).toBe(1000);
    expect(chat.state).toBe('closed');
  });

  it('stops delivering after close()', async () => {
    const { chat, sockets, messages } = rig();
    chat.start();
    const socket = await openSocket(sockets);
    socket.receive(busy(1));
    chat.close();
    socket.receive(busy(2));
    expect(messages).toHaveLength(1);
  });
});

describe('ApiClient.chat', () => {
  it('gets the ticket with the token of the client and keeps the token out of the socket URL', async () => {
    const ticket = 'ticket-abcdefghijklmnop';
    const daemon = await startTestDaemon({
      handler: (request) =>
        request.method === 'POST' && request.target === '/v1/chat-tickets'
          ? { json: { ticket, expiresInMs: 30_000 } }
          : undefined,
    });
    daemons.push(daemon);
    const { Socket, sockets } = createFakeSockets();
    const client = new ApiClient({
      url: daemon.url,
      token: daemon.token,
      daemonId: daemon.daemonId,
    });
    const chat = client.chat('S1', { webSocket: Socket, clock: createTestClock() });
    chats.push(chat);
    chat.start();
    const socket = await openSocket(sockets);
    const request = daemon.requests.find((entry) => entry.target === '/v1/chat-tickets');
    expect(request?.headers.authorization).toBe(`Bearer ${daemon.token}`);
    expect(JSON.parse(request?.body ?? '{}')).toEqual({ scenarioId: 'S1' });
    const wsUrl = daemon.url.replace('http:', 'ws:');
    expect(socket.url).toBe(`${wsUrl}/v1/scenarios/S1/chat?ticket=${ticket}`);
    expect(socket.url).not.toContain(daemon.token);
  });

  it('stops at once when the daemon answers 404 to the ticket', async () => {
    const daemon = await startTestDaemon({
      handler: (request) =>
        request.target === '/v1/chat-tickets'
          ? { status: 404, json: { error: { code: 'not_found', message: 'No such scenario' } } }
          : undefined,
    });
    daemons.push(daemon);
    const { Socket, sockets } = createFakeSockets();
    const client = new ApiClient({ url: daemon.url, token: daemon.token });
    const chat = client.chat('S404', { webSocket: Socket, clock: createTestClock() });
    chats.push(chat);
    chat.start();
    await chat.done;
    expect(sockets).toHaveLength(0);
    expect(chat.detail.error).toMatchObject({ status: 404, code: 'not_found' });
  });
});
