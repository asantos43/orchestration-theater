// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11, P4): a provider that is down, on the loopback of the host.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * A provider that fails, as a `node:http` server on `127.0.0.1` with an ephemeral port (docs/23,
 * "Como cada falha é simulada": the origins of the tests stay on the loopback, nothing leaves the
 * machine). The modes are the ways an HTTP origin is down:
 * - `ok`: answers 200 with `body`;
 * - `refuse`: nothing listens on the port (the connection is refused). The port stays reserved by
 *   this object, so a `setMode('ok')` brings the same address back;
 * - `503`: answers `503 Service Unavailable`, with `Retry-After` when `retryAfterSeconds` is set;
 * - `cut`: sends the headers and the first half of the body, then drops the connection, so the
 *   reader sees an answer that ends before its `Content-Length`;
 * - `slow`: takes the request and never answers it, until `release()` (or `close()`). The caller's
 *   own timeout is what ends it; no timer of this server decides when, so a test waits for the
 *   event `held() >= 1` and not for a window of milliseconds;
 * - `flap`: the origin falls and returns by the number of requests, not by time: the n-th request
 *   gets the step `flapPattern[n % length]` (`ok`, `503`, `cut`, `reset`), so a run is the same on
 *   any machine.
 *
 * It counts what it saw (`requests()`), which is how a chaos test measures a ceiling of attempts: a
 * client that loops without a backoff shows up as a number that grows.
 */

export const LOOPBACK_MODES = ['ok', 'refuse', '503', 'cut', 'slow', 'flap'] as const;
export type LoopbackMode = (typeof LOOPBACK_MODES)[number];

/** What one request of the `flap` mode gets. `reset` drops the connection before any byte. */
export const FLAP_STEPS = ['ok', '503', 'cut', 'reset'] as const;
export type FlapStep = (typeof FLAP_STEPS)[number];

export interface LoopbackOptions {
  /** The mode it starts in. Default `ok`. */
  readonly mode?: LoopbackMode;
  /** The body of an `ok` answer, and the one `cut` cuts. Default a small JSON. */
  readonly body?: string;
  /** `Content-Type` of `ok` and `cut`. Default `application/json`. */
  readonly contentType?: string;
  /** `Retry-After` of the `503`, in seconds. Default none. */
  readonly retryAfterSeconds?: number;
  /** The steps of `flap`, in order, repeated. Default `reset`, `503`, `ok`. */
  readonly flapPattern?: readonly FlapStep[];
}

/** One request the server saw. */
export interface LoopbackRequest {
  readonly method: string;
  readonly url: string;
  /** What the server did with it: a mode, or a step of `flap`. */
  readonly outcome: FlapStep | 'slow';
}

export interface LoopbackServer {
  /** The port, ephemeral; the same for the whole life of the object, `refuse` included. */
  readonly port: number;
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  readonly url: string;
  mode(): LoopbackMode;
  /** Changes the mode. Into and out of `refuse` it closes and reopens the listening socket. */
  setMode(mode: LoopbackMode): Promise<void>;
  /** The requests that reached the server, in order (`refuse` sees none: nobody listens). */
  requests(): readonly LoopbackRequest[];
  /** The `slow` requests that are waiting for an answer now. */
  held(): number;
  /** Ends the `slow` requests that wait: each gets a 200 and the body. */
  release(): void;
  /** Closes the socket and drops every open connection. Safe to call twice. */
  close(): Promise<void>;
}

const DEFAULT_BODY = '{"ok":true,"padding":"0123456789abcdef0123456789abcdef"}';
const DEFAULT_PATTERN: readonly FlapStep[] = ['reset', '503', 'ok'];

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export async function startLoopbackServer(options: LoopbackOptions = {}): Promise<LoopbackServer> {
  const body = options.body ?? DEFAULT_BODY;
  const contentType = options.contentType ?? 'application/json';
  const pattern = options.flapPattern ?? DEFAULT_PATTERN;
  if (pattern.length === 0) throw new Error('flapPattern needs at least one step');
  let current: LoopbackMode = options.mode ?? 'ok';
  const seen: LoopbackRequest[] = [];
  const sockets = new Set<Socket>();
  const waiting = new Set<ServerResponse>();
  let flapIndex = 0;
  let closed = false;

  const answerOk = (response: ServerResponse): void => {
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  };
  const answer503 = (response: ServerResponse): void => {
    response.writeHead(503, {
      'content-type': 'text/plain',
      ...(options.retryAfterSeconds === undefined
        ? {}
        : { 'retry-after': String(options.retryAfterSeconds) }),
    });
    response.end('service unavailable');
  };
  const answerCut = (response: ServerResponse): void => {
    // The header promises the whole body; the connection goes after the first half.
    const half = body.slice(0, Math.max(1, Math.floor(body.length / 2)));
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
    });
    response.write(half, () => {
      response.socket?.destroy();
    });
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    request.resume();
    const entry = (outcome: LoopbackRequest['outcome']): void => {
      seen.push({ method: request.method ?? 'GET', url: request.url ?? '/', outcome });
    };
    const step: FlapStep | 'slow' =
      current === 'flap'
        ? (pattern[flapIndex++ % pattern.length] ?? 'ok')
        : current === 'ok' || current === 'refuse'
          ? 'ok'
          : current;
    entry(step);
    if (step === 'slow') {
      waiting.add(response);
      response.once('close', () => {
        waiting.delete(response);
      });
    } else if (step === '503') answer503(response);
    else if (step === 'cut') answerCut(response);
    else if (step === 'reset') request.socket.destroy();
    else answerOk(response);
  };

  const make = (): Server => {
    const created = createServer(handle);
    created.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
      });
    });
    return created;
  };

  let server: Server | undefined = make();
  await listen(server, 0);
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const { port } = address;

  const stopListening = async (): Promise<void> => {
    const old = server;
    server = undefined;
    if (old === undefined) return;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      old.close(() => {
        resolve();
      });
    });
  };

  if (current === 'refuse') await stopListening();

  return {
    port,
    url: `http://127.0.0.1:${String(port)}`,
    mode: () => current,
    setMode: async (mode) => {
      if (closed) throw new Error('the loopback server is closed');
      if (mode === 'refuse') {
        current = mode;
        await stopListening();
        return;
      }
      if (server === undefined) {
        server = make();
        await listen(server, port);
      }
      if (current !== mode && mode !== 'slow') flapIndex = 0;
      current = mode;
    },
    requests: () => [...seen],
    held: () => waiting.size,
    release: () => {
      for (const response of [...waiting]) {
        waiting.delete(response);
        answerOk(response);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const response of waiting) response.destroy();
      waiting.clear();
      await stopListening();
    },
  };
}
