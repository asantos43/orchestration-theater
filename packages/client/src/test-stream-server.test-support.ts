// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { apiError, sseMessageOf, type ApiEventEnvelope } from '@otheater/protocol';
import type { TestReply, TestRequest } from './test-daemon.test-support.js';

/**
 * A stand-in for `GET /v1/events` in this process, on the loopback, for the tests of the event
 * stream (N57: nothing real runs). The test decides what each connection does: write frames,
 * write half a frame, drop the socket. The real server is P4; the test of a stream that falls in
 * the middle of a play against the daemon enters in P13. Like the other test daemon, it never
 * imports the daemon.
 */

/** One accepted stream. */
export interface StreamConnection {
  /** 0 for the first stream accepted, 1 for the second... (refused requests are not counted). */
  readonly index: number;
  readonly request: TestRequest;
  readonly lastEventId: string | undefined;
  readonly query: URLSearchParams;
  /** Writes raw text or bytes to the open stream. */
  write(chunk: string | Uint8Array): void;
  /** Ends the response cleanly. */
  end(): void;
  /** Kills the socket, as a dropped connection does. */
  destroy(): void;
  /** Resolves when the client has gone away (or the server did). */
  readonly closed: Promise<void>;
}

export interface StreamServerOptions {
  readonly token?: string;
  readonly daemonId?: string;
  /**
   * Called for every request to the stream, after the token check, before the stream starts, with
   * the 0-based count of the requests so far. A reply answers instead of the stream.
   */
  readonly intercept?: (request: TestRequest, requestIndex: number) => TestReply | undefined;
  readonly onStream: (connection: StreamConnection) => void;
  /** Content type of the stream. Default `text/event-stream`. */
  readonly contentType?: string;
}

export interface StreamServer {
  readonly url: string;
  readonly token: string;
  readonly daemonId: string;
  /** Every request to the server, in order. */
  readonly requests: TestRequest[];
  /** Streams currently open. */
  openStreams(): number;
  close(): Promise<void>;
}

type EventEnvelope = Parameters<typeof sseMessageOf>[0];

/** An event of the log, as a test writes it. */
export function envelopeOf(
  id: number,
  scenarioId = 'S1',
  title = `event ${String(id)}`,
): EventEnvelope {
  return {
    id,
    timestamp: 1_700_000_000_000 + id,
    type: 'play.created',
    schemaVersion: 1,
    payload: { title },
    scenarioId,
    playId: 'P1',
  };
}

/** The SSE frame of an event, exactly as the daemon writes it. */
export function frameOf(envelope: EventEnvelope, daemonId: string): string {
  const message = sseMessageOf(envelope, daemonId);
  return `id: ${message.id}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

export type { ApiEventEnvelope };

export async function startStreamServer(options: StreamServerOptions): Promise<StreamServer> {
  const token = options.token ?? `tok-${randomUUID()}`;
  const daemonId = options.daemonId ?? randomUUID();
  const requests: TestRequest[] = [];
  const sockets = new Set<Socket>();
  const streams = new Set<ServerResponse>();
  let accepted = 0;

  const server: Server = createServer((request, response) => {
    const received: TestRequest = {
      method: request.method ?? 'GET',
      target: request.url ?? '/',
      headers: request.headers,
      body: '',
    };
    const requestIndex = requests.length;
    requests.push(received);
    const reply = (answer: TestReply): void => {
      response.writeHead(answer.status ?? 200, {
        ...(answer.text === undefined ? { 'content-type': 'application/json' } : {}),
        ...answer.headers,
      });
      response.end(answer.text ?? JSON.stringify(answer.json));
    };
    if (request.headers.authorization !== `Bearer ${token}`) {
      reply({ status: 401, json: apiError('unauthorized', 'Missing or wrong token') });
      return;
    }
    const url = new URL(received.target, 'http://localhost');
    if (url.pathname !== '/v1/events') {
      reply({ status: 404, json: apiError('not_found', 'No such route') });
      return;
    }
    const taken = options.intercept?.(received, requestIndex);
    if (taken !== undefined) {
      reply(taken);
      return;
    }
    response.writeHead(200, {
      'content-type': options.contentType ?? 'text/event-stream',
      'cache-control': 'no-cache',
    });
    response.flushHeaders();
    streams.add(response);
    const closed = new Promise<void>((resolve) => {
      response.on('close', () => {
        streams.delete(response);
        resolve();
      });
    });
    const header = request.headers['last-event-id'];
    options.onStream({
      index: accepted++,
      request: received,
      lastEventId: Array.isArray(header) ? header[0] : header,
      query: url.searchParams,
      write(chunk) {
        response.write(chunk);
      },
      end() {
        response.end();
      },
      destroy() {
        response.destroy();
      },
      closed,
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    token,
    daemonId,
    requests,
    openStreams: () => streams.size,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
