// SPDX-License-Identifier: MPL-2.0
import { apiError, type ApiSseMessage } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionDetail, ConnectionState } from './connection.js';
import { ApiInputError, ApiNetworkError, ApiProtocolError, ApiRequestError } from './errors.js';
import { EventStream, type EventStreamOptions } from './event-stream.js';
import { createTestClock, waitFor, type TestClock } from './test-clock.test-support.js';
import {
  envelopeOf,
  frameOf,
  startStreamServer,
  type StreamConnection,
  type StreamServer,
  type StreamServerOptions,
} from './test-stream-server.test-support.js';

const servers: StreamServer[] = [];
const streams: EventStream[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  for (const server of servers.splice(0)) await server.close();
});

async function serve(
  onStream: (connection: StreamConnection) => void,
  extra: Omit<StreamServerOptions, 'onStream'> = {},
): Promise<StreamServer> {
  const server = await startStreamServer({ ...extra, onStream });
  servers.push(server);
  return server;
}

interface Rig {
  readonly stream: EventStream;
  readonly clock: TestClock;
  readonly messages: ApiSseMessage[];
  readonly ids: number[];
  readonly states: ConnectionState[];
  readonly details: ConnectionDetail[];
}

/** An unstarted stream wired to a server, with the test clock and a recording of everything. */
function rig(server: StreamServer, options: EventStreamOptions = {}, token = server.token): Rig {
  const clock = createTestClock();
  const stream = new EventStream(
    { url: server.url, token, daemonId: server.daemonId },
    { clock, random: () => 0.5, ...options },
  );
  streams.push(stream);
  const messages: ApiSseMessage[] = [];
  const ids: number[] = [];
  const states: ConnectionState[] = [];
  const details: ConnectionDetail[] = [];
  stream.onMessage((message) => {
    messages.push(message);
    ids.push(message.data.id);
  });
  stream.onState((state, detail) => {
    states.push(state);
    details.push(detail);
  });
  return { stream, clock, messages, ids, states, details };
}

const DAEMON = '4b9f6f64-5f0b-4e5e-9a43-3a1f2b0c9d11';

const frames = (server: StreamServer, from: number, to: number): string => {
  let text = '';
  for (let id = from; id <= to; id += 1) text += frameOf(envelopeOf(id), server.daemonId);
  return text;
};

const header = (server: StreamServer, index: number): string | undefined => {
  const value = server.requests[index]?.headers['last-event-id'];
  return Array.isArray(value) ? value[0] : value;
};

describe('EventStream: delivery', () => {
  it('delivers the events in order, validated, and goes connecting then open', async () => {
    const server = await serve((connection) => {
      connection.write(': hello\n\n');
      connection.write(frames(server, 1, 3));
    });
    const { stream, ids, messages, states } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 3, 'three events');
    expect(ids).toEqual([1, 2, 3]);
    expect(messages[0]).toMatchObject({
      id: '1',
      event: 'play.created',
      data: { id: 1, type: 'play.created' },
    });
    expect(states).toEqual(['connecting', 'open']);
    expect(stream.state).toBe('open');
    expect(stream.lastEventId).toBe(3);
  });

  it('sends the token only in Authorization, never in the URL, and no Last-Event-ID the first time', async () => {
    const server = await serve(() => undefined);
    const { stream, states } = rig(server);
    stream.start();
    await waitFor(() => states.includes('open'), 'the stream to open');
    const request = server.requests[0];
    expect(request?.headers.authorization).toBe(`Bearer ${server.token}`);
    expect(request?.headers.accept).toBe('text/event-stream');
    expect(request?.headers['cache-control']).toBe('no-cache');
    expect(request?.headers['last-event-id']).toBeUndefined();
    expect(request?.target).not.toContain(server.token);
    expect(request?.target).toBe('/v1/events');
  });

  it('puts up with comments, frames cut in any place and a multibyte character cut in two', async () => {
    const title = 'ação 🎭 do teatro';
    const bytes = new TextEncoder().encode(frameOf(envelopeOf(1, 'S1', title), DAEMON));
    const cut = bytes.indexOf(0xf0) + 2; // inside the four bytes of the emoji
    const server = await serve((connection) => {
      connection.write(': heartbeat\n\n');
      connection.write(bytes.slice(0, cut));
      setTimeout(() => {
        connection.write(bytes.slice(cut, cut + 7));
        connection.write(bytes.slice(cut + 7));
      }, 10);
    });
    const { stream, messages } = rig(server);
    stream.start();
    await waitFor(() => messages.length === 1, 'the event');
    expect((messages[0]?.data.payload as { title: string }).title).toBe(title);
  });

  it('drops a message that is not above the last one delivered, unless told not to', async () => {
    const server = await serve((connection) => {
      const of = (id: number): string => frameOf(envelopeOf(id), server.daemonId);
      connection.write(of(1) + of(2) + of(2) + of(1) + of(3));
    });
    const dropping = rig(server);
    dropping.stream.start();
    await waitFor(() => dropping.ids.length >= 3, 'the events');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dropping.ids).toEqual([1, 2, 3]);

    const keeping = rig(server, { dropRepeated: false });
    keeping.stream.start();
    await waitFor(() => keeping.ids.length === 5, 'every message');
    expect(keeping.ids).toEqual([1, 2, 2, 1, 3]);
  });

  it('is not taken down by a listener that throws, and a listener can leave', async () => {
    const server = await serve((connection) => {
      connection.write(frames(server, 1, 2));
    });
    const { stream, ids } = rig(server);
    stream.onMessage(() => {
      throw new Error('faulty screen');
    });
    const seen: number[] = [];
    const stop = stream.onMessage((message) => {
      seen.push(message.data.id);
      stop();
    });
    stream.start();
    await waitFor(() => ids.length === 2, 'both events');
    expect(seen).toEqual([1]);
    expect(stream.state).toBe('open');
  });
});

describe('EventStream: filters and cursor', () => {
  it('puts scenario, types and since in the query, and sends no header the first time', async () => {
    const server = await serve(() => undefined);
    const { stream, states } = rig(server, {
      scenario: ['S1', 'S2'],
      types: ['play.', 'quota.'],
      since: 7,
    });
    stream.start();
    await waitFor(() => states.includes('open'), 'the stream to open');
    const url = new URL(server.requests[0]?.target ?? '', 'http://x');
    expect(url.searchParams.getAll('scenario')).toEqual(['S1', 'S2']);
    expect(url.searchParams.getAll('types')).toEqual(['play.', 'quota.']);
    expect(url.searchParams.get('since')).toBe('7');
    expect(header(server, 0)).toBeUndefined();
  });

  it('takes a single string as one filter', async () => {
    const server = await serve(() => undefined);
    const { stream, states } = rig(server, { scenario: 'S9', types: 'play.' });
    stream.start();
    await waitFor(() => states.includes('open'), 'the stream to open');
    const url = new URL(server.requests[0]?.target ?? '', 'http://x');
    expect(url.searchParams.getAll('scenario')).toEqual(['S9']);
    expect(url.searchParams.getAll('types')).toEqual(['play.']);
  });

  it('refuses a filter outside the contract before connecting', async () => {
    const server = await serve(() => undefined);
    expect(() => rig(server, { since: -1 })).toThrow(ApiInputError);
    expect(() => rig(server, { scenario: '' })).toThrow(ApiInputError);
    expect(server.requests).toHaveLength(0);
  });

  it('uses since again if no event arrived, and Last-Event-ID once one did', async () => {
    const server = await serve((connection) => {
      if (connection.index === 0) connection.destroy();
      else if (connection.index === 1) {
        connection.write(frames(server, 8, 9));
        setTimeout(() => {
          connection.destroy();
        }, 20);
      }
    });
    const { stream, ids } = rig(server, { since: 7, scenario: 'S1' });
    stream.start();
    await waitFor(() => server.requests.length >= 3, 'three requests');
    expect(ids).toEqual([8, 9]);
    const second = new URL(server.requests[1]?.target ?? '', 'http://x');
    const third = new URL(server.requests[2]?.target ?? '', 'http://x');
    expect(second.searchParams.get('since')).toBe('7');
    expect(header(server, 1)).toBeUndefined();
    expect(third.searchParams.get('since')).toBeNull();
    expect(third.searchParams.get('scenario')).toBe('S1');
    expect(header(server, 2)).toBe('9');
  });

  it('follows an id that came with no event, so a stream that falls before the first event resumes', async () => {
    const server = await serve((connection) => {
      if (connection.index === 0) {
        connection.write('id: 42\n\n');
        setTimeout(() => {
          connection.destroy();
        }, 10);
      } else connection.write(frames(server, 43, 43));
    });
    const { stream, ids } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 1, 'the event after the gap');
    expect(header(server, 1)).toBe('42');
    expect(ids).toEqual([43]);
    expect(stream.lastEventId).toBe(43);
  });

  it('tells the listener when the cursor moves, once for each chunk: the head frame first', async () => {
    const server = await serve((connection) => {
      connection.write('retry: 1\nid: 0\n\n');
      setTimeout(() => {
        // Two events in one chunk move the cursor once, to the last of them.
        connection.write(frames(server, 1, 2));
      }, 20);
      setTimeout(() => {
        // The same id again moves nothing.
        connection.write('id: 2\n\n');
      }, 40);
    });
    const { stream, ids } = rig(server);
    const cursors: number[] = [];
    const stop = stream.onCursor((id) => cursors.push(id));
    stream.start();
    await waitFor(() => ids.length === 2, 'two events');
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(cursors).toEqual([0, 2]);
    stop();
  });

  it('does not tell the cursor to a listener that was removed', async () => {
    const server = await serve((connection) => {
      connection.write('id: 5\n\n');
    });
    const { stream } = rig(server);
    const cursors: number[] = [];
    stream.onCursor((id) => cursors.push(id))();
    stream.start();
    await waitFor(() => stream.state === 'open', 'the stream');
    await waitFor(() => stream.lastEventId === 5, 'the cursor');
    expect(cursors).toEqual([]);
  });
});

describe('EventStream: reconnection', () => {
  it('survives a drop in the middle of a frame and receives 1 to 10 exactly once', async () => {
    const server = await serve((connection) => {
      if (connection.index === 0) {
        connection.write(frames(server, 1, 5));
        // Half of frame 6: it must not be delivered, and the cursor stays at 5.
        connection.write('id: 6\nevent: play.created\ndata: {"id"');
        setTimeout(() => {
          connection.destroy();
        }, 10);
      } else connection.write(frames(server, 6, 10));
    });
    const { stream, ids, clock, states, details } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 10, 'ten events');
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(header(server, 0)).toBeUndefined();
    expect(header(server, 1)).toBe('5');
    expect(clock.sleeps).toEqual([1000]);
    expect(states).toEqual(['connecting', 'open', 'retrying', 'connecting', 'open']);
    expect(details[2]?.error).toBeInstanceOf(ApiNetworkError);
    expect(details[2]).toMatchObject({ attempt: 1, delayMs: 1000 });
  });

  it('comes back when the daemon ends the stream, and counts that as a failure to retry', async () => {
    const server = await serve((connection) => {
      if (connection.index === 0) {
        connection.write(frames(server, 1, 2));
        connection.end();
      } else connection.write(frames(server, 3, 3));
    });
    const { stream, ids, details } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 3, 'three events');
    expect(header(server, 1)).toBe('2');
    expect(details.find((entry) => entry.error !== undefined)?.error).toBeInstanceOf(
      ApiNetworkError,
    );
  });

  it('takes the retry of the server as the new base of the backoff', async () => {
    const server = await serve(
      (connection) => {
        if (connection.index === 0) {
          connection.write(`retry: 3000\n\n${frames(server, 1, 1)}`);
          setTimeout(() => {
            connection.destroy();
          }, 10);
        } else connection.write(frames(server, 2, 2));
      },
      {
        intercept: (_request, index) =>
          index === 1 || index === 2
            ? { status: 503, json: apiError('unavailable', 'busy') }
            : undefined,
      },
    );
    const { stream, ids, clock } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 2, 'the second event');
    // 3 s from the server, then 6 s and 12 s for two more failures in a row.
    expect(clock.sleeps).toEqual([3000, 6000, 12_000]);
  });

  it('honours Retry-After of a 503 as a floor for the wait', async () => {
    const server = await serve(
      (connection) => {
        connection.write(frames(server, 1, 1));
      },
      {
        intercept: (_request, index) =>
          index === 0
            ? {
                status: 503,
                json: apiError('recovering', 'starting'),
                headers: { 'retry-after': '7' },
              }
            : undefined,
      },
    );
    const { stream, ids, clock, details } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 1, 'the event');
    expect(clock.sleeps).toEqual([7000]);
    const error = details.find((entry) => entry.error !== undefined)?.error;
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: 'recovering', status: 503, retryAfterSeconds: 7 });
  });

  it('tries again after a 5xx that is not JSON (a proxy page)', async () => {
    const server = await serve(
      (connection) => {
        connection.write(frames(server, 1, 1));
      },
      {
        intercept: (_request, index) =>
          index === 0 ? { status: 502, text: '<html>Bad gateway</html>' } : undefined,
      },
    );
    const { stream, ids, clock, details } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 1, 'the event');
    expect(clock.sleeps).toEqual([1000]);
    const error = details.find((entry) => entry.error !== undefined)?.error;
    expect(error).toBeInstanceOf(ApiProtocolError);
    expect(error).toMatchObject({ reason: 'invalid_error_body', status: 502 });
  });

  it('tries again when the daemon is not there, and gives up after maxRetries', async () => {
    const server = await serve(() => undefined);
    const dead = rig(server, { maxRetries: 2 });
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    dead.stream.start();
    await dead.stream.done;
    expect(dead.stream.state).toBe('closed');
    expect(dead.clock.sleeps).toEqual([1000, 2000]);
    expect(dead.stream.detail.error).toBeInstanceOf(ApiNetworkError);
    expect(dead.states).toEqual([
      'connecting',
      'retrying',
      'connecting',
      'retrying',
      'connecting',
      'closed',
    ]);
  });

  it('gives up for good after maxRetries 503 in a row, with the last error', async () => {
    const server = await serve(() => undefined, {
      intercept: () => ({ status: 503, json: apiError('unavailable', 'busy') }),
    });
    const { stream, clock } = rig(server, { maxRetries: 2 });
    stream.start();
    await stream.done;
    expect(server.requests).toHaveLength(3);
    expect(clock.sleeps).toHaveLength(2);
    expect(stream.detail.error).toMatchObject({ code: 'unavailable', status: 503 });
  });
});

describe('EventStream: errors that do not come back', () => {
  async function refused(
    status: number,
    code: 'unauthorized' | 'forbidden' | 'not_found',
  ): Promise<{ stream: EventStream; clock: TestClock; server: StreamServer }> {
    const server = await serve(() => undefined, {
      intercept: () => ({ status, json: apiError(code, 'no') }),
    });
    const { stream, clock } = rig(server);
    stream.start();
    await stream.done;
    return { stream, clock, server };
  }

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
  ] as const)('does not reconnect after a %i', async (status, code) => {
    const { stream, clock, server } = await refused(status, code);
    expect(stream.state).toBe('closed');
    expect(server.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(stream.detail.error).toBeInstanceOf(ApiRequestError);
    expect(stream.detail.error).toMatchObject({ code, status });
  });

  it('does not reconnect after a 401 for a wrong token', async () => {
    const server = await serve(() => undefined);
    const { stream, clock, states } = rig(server, {}, 'wrong-token');
    stream.start();
    await stream.done;
    expect(server.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(states).toEqual(['connecting', 'closed']);
    expect(stream.detail.error).toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('closes with a protocol error on a 401 that is a page and not an error of the API', async () => {
    const server = await serve(() => undefined, {
      intercept: () => ({ status: 401, text: '<html>login</html>' }),
    });
    const { stream, clock } = rig(server);
    stream.start();
    await stream.done;
    expect(server.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(stream.detail.error).toBeInstanceOf(ApiProtocolError);
    expect(stream.detail.error).toMatchObject({ reason: 'invalid_error_body', status: 401 });
  });

  it('does not follow a redirect (the token would go along)', async () => {
    const server = await serve(() => undefined, {
      intercept: () => ({
        status: 302,
        text: '',
        headers: { location: 'http://127.0.0.1:1/elsewhere' },
      }),
    });
    const { stream } = rig(server);
    stream.start();
    await stream.done;
    expect(server.requests).toHaveLength(1);
    expect(stream.state).toBe('closed');
  });

  it('closes with invalid_stream when the answer is not an event stream', async () => {
    const server = await serve(() => undefined, { contentType: 'text/html' });
    const { stream, clock } = rig(server);
    stream.start();
    await stream.done;
    expect(clock.sleeps).toEqual([]);
    expect(stream.detail.error).toMatchObject({ reason: 'invalid_stream', status: 200 });
  });

  it('closes with invalid_stream when the answer has no body', async () => {
    const stream = new EventStream(
      {
        url: 'http://127.0.0.1:1',
        token: 't',
        fetch: () =>
          Promise.resolve(
            new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
          ),
      },
      { clock: createTestClock() },
    );
    streams.push(stream);
    stream.start();
    await stream.done;
    expect(stream.detail.error).toMatchObject({ reason: 'invalid_stream' });
  });

  it('reads a stream from an injected fetch, with no network', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frameOf(envelopeOf(1), DAEMON)));
      },
    });
    const calls: string[] = [];
    const stream = new EventStream(
      {
        url: 'http://daemon.invalid/base/',
        token: 'secret',
        fetch: (url, init) => {
          calls.push(url);
          expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret');
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            }),
          );
        },
      },
      { clock: createTestClock() },
    );
    streams.push(stream);
    const ids: number[] = [];
    stream.onMessage((message) => {
      ids.push(message.data.id);
    });
    stream.start();
    await waitFor(() => ids.length === 1, 'the event');
    expect(calls[0]).toBe('http://daemon.invalid/base/v1/events');
  });
});

describe('EventStream: messages outside the contract', () => {
  const badFrames = {
    'a body that is not JSON': 'id: 2\nevent: play.created\ndata: {not json\n\n',
    'an envelope that does not fit': 'id: 2\nevent: play.created\ndata: {"nope":1}\n\n',
    'an id that is not the one of the body': (daemonId: string): string =>
      frameOf(envelopeOf(2), daemonId).replace('id: 2\n', 'id: 5\n'),
    'an event name that is not the type of the body': (daemonId: string): string =>
      frameOf(envelopeOf(2), daemonId).replace('event: play.created', 'event: play.updated'),
  } as const;
  const reasons = ['invalid_json', 'invalid_response', 'invalid_response', 'invalid_response'];

  it.each(Object.keys(badFrames).map((name, index) => [name, reasons[index]] as const))(
    'closes with a typed error, and does not retry, on %s',
    async (name, reason) => {
      const bad = badFrames[name as keyof typeof badFrames];
      const server = await serve((connection) => {
        connection.write(frames(server, 1, 1));
        connection.write(typeof bad === 'string' ? bad : bad(server.daemonId));
      });
      const { stream, clock } = rig(server);
      stream.start();
      await stream.done;
      expect(stream.state).toBe('closed');
      expect(clock.sleeps).toEqual([]);
      expect(server.requests).toHaveLength(1);
      expect(stream.detail.error).toBeInstanceOf(ApiProtocolError);
      expect(stream.detail.error).toMatchObject({ reason, status: 200 });
    },
  );

  it('with invalidMessages skip, drops the bad message, tells onInvalid and goes on', async () => {
    const server = await serve((connection) => {
      connection.write('id: 1\nevent: play.created\ndata: {not json\n\n');
      connection.write(frames(server, 2, 3));
    });
    const { stream, ids } = rig(server, { invalidMessages: 'skip' });
    const invalid: unknown[] = [];
    stream.onInvalid((error) => {
      invalid.push(error);
    });
    stream.start();
    await waitFor(() => ids.length === 2, 'the valid events');
    expect(ids).toEqual([2, 3]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ reason: 'invalid_json' });
    expect(stream.state).toBe('open');
  });
});

describe('EventStream: closing', () => {
  it('close() ends the stream at once: the response is dropped and nothing is tried again', async () => {
    const server = await serve((connection) => {
      connection.write(frames(server, 1, 1));
    });
    const { stream, ids, states } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 1, 'the event');
    expect(server.openStreams()).toBe(1);
    stream.close();
    expect(stream.state).toBe('closed');
    await stream.done;
    await waitFor(() => server.openStreams() === 0, 'the daemon to see the stream go');
    expect(server.requests).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
    expect(stream.detail.error).toBeUndefined();
  });

  it('the abort signal closes the stream in the middle of a wait to retry', async () => {
    const abort = new AbortController();
    const server = await serve(() => undefined, {
      intercept: () => ({ status: 503, json: apiError('unavailable', 'busy') }),
    });
    const stream = new EventStream(
      { url: server.url, token: server.token },
      { initialDelayMs: 60_000, maxDelayMs: 60_000, signal: abort.signal },
    );
    streams.push(stream);
    stream.start();
    await waitFor(() => stream.state === 'retrying', 'the wait');
    const started = Date.now();
    abort.abort();
    await stream.done;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stream.state).toBe('closed');
    expect(server.requests).toHaveLength(1);
  });

  it('the abort signal closes an open stream, and a signal already aborted never connects', async () => {
    const server = await serve(() => undefined);
    const abort = new AbortController();
    const live = new EventStream(
      { url: server.url, token: server.token },
      { signal: abort.signal },
    );
    streams.push(live);
    live.start();
    await waitFor(() => live.state === 'open', 'the stream to open');
    abort.abort();
    await live.done;
    expect(live.state).toBe('closed');

    const before = server.requests.length;
    const late = new EventStream(
      { url: server.url, token: server.token },
      { signal: AbortSignal.abort() },
    );
    streams.push(late);
    late.start();
    await late.done;
    expect(late.state).toBe('closed');
    expect(server.requests).toHaveLength(before);
  });

  it('stops delivering after close(), even for what was already on the wire', async () => {
    const server = await serve((connection) => {
      connection.write(frames(server, 1, 1));
      setTimeout(() => {
        connection.write(frames(server, 2, 2));
      }, 30);
    });
    const { stream, ids } = rig(server);
    stream.start();
    await waitFor(() => ids.length === 1, 'the first event');
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ids).toEqual([1]);
  });
});
