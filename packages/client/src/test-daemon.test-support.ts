// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_DISCOVERY_FILE,
  API_TOKEN_FILE,
  API_VERSION,
  LayoutPreferencesSchema,
  LayoutInterfaceSchema,
  apiError,
  defaultLayout,
  type ApiStatus,
  type LayoutPreferences,
} from '@otheater/protocol';

/**
 * A stand-in for the daemon API, in this process, for the tests of the client (N57: nothing real
 * runs). It speaks just what the tests need of the contract: the token check, `GET /v1/status` and
 * the layout routes over an in-memory table. The real server is P3; the tests with two real
 * daemons running the fake-agent enter when it is on `main`. The client never imports the daemon,
 * and neither does this file.
 */

export interface TestRequest {
  readonly method: string;
  /** Path and query, as received. */
  readonly target: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface TestReply {
  readonly status?: number;
  readonly json?: unknown;
  /** Sent as is (not JSON): an HTML page, a broken JSON. */
  readonly text?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Waits before answering. */
  readonly delayMs?: number;
  /** Never answers (until the daemon closes). */
  readonly hang?: boolean;
}

/** Returns a reply to take over the request, or `undefined` to leave it to the built-in routes. */
export type TestHandler = (request: TestRequest) => TestReply | undefined;

export interface TestDaemon {
  readonly url: string;
  readonly daemonId: string;
  readonly token: string;
  /** Every request received, in order (the token check included). */
  readonly requests: TestRequest[];
  /** The layouts it keeps, by interface. */
  readonly layouts: Map<string, LayoutPreferences>;
  /** Replaces the handler. */
  respondWith(handler: TestHandler | undefined): void;
  close(): Promise<void>;
}

export interface StartTestDaemonOptions {
  readonly daemonId?: string;
  readonly token?: string;
  readonly apiVersion?: number;
  readonly handler?: TestHandler;
}

async function readBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

export async function startTestDaemon(options: StartTestDaemonOptions = {}): Promise<TestDaemon> {
  const daemonId = options.daemonId ?? randomUUID();
  const token = options.token ?? `tok-${randomUUID()}`;
  const requests: TestRequest[] = [];
  const layouts = new Map<string, LayoutPreferences>();
  let handler = options.handler;
  const sockets = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    void (async () => {
      const received: TestRequest = {
        method: request.method ?? 'GET',
        target: request.url ?? '/',
        headers: request.headers,
        body: await readBody(request),
      };
      requests.push(received);
      const send = (reply: TestReply): void => {
        const respond = (): void => {
          response.writeHead(reply.status ?? 200, {
            ...(reply.text === undefined ? { 'content-type': 'application/json' } : {}),
            ...reply.headers,
          });
          response.end(reply.text ?? JSON.stringify(reply.json));
        };
        if (reply.hang === true) return;
        if (reply.delayMs !== undefined) setTimeout(respond, reply.delayMs);
        else respond();
      };
      if (request.headers.authorization !== `Bearer ${token}`) {
        send({ status: 401, json: apiError('unauthorized', 'Missing or wrong token') });
        return;
      }
      const taken = handler?.(received);
      if (taken !== undefined) {
        send(taken);
        return;
      }
      const path = received.target.split('?')[0] ?? '';
      if (received.method === 'GET' && path === '/v1/status') {
        const status: ApiStatus = {
          pid: process.pid,
          startedAt: 0,
          version: '0.0.0-test',
          dataDir: '/tmp/test-daemon',
          state: 'running',
          daemonId,
          apiVersion: options.apiVersion ?? API_VERSION,
        };
        send({ json: status });
        return;
      }
      const layoutMatch = /^\/v1\/layout\/([^/]+)$/.exec(path);
      if (layoutMatch !== null) {
        const which = LayoutInterfaceSchema.safeParse(decodeURIComponent(layoutMatch[1] ?? ''));
        if (!which.success) {
          send({ status: 404, json: apiError('not_found', 'No such interface') });
          return;
        }
        if (received.method === 'GET') {
          send({ json: layouts.get(which.data) ?? defaultLayout(which.data) });
          return;
        }
        if (received.method === 'PUT') {
          const body = LayoutPreferencesSchema.safeParse(JSON.parse(received.body));
          if (!body.success) {
            send({ status: 400, json: apiError('invalid_input', 'Bad layout') });
            return;
          }
          layouts.set(which.data, body.data);
          send({ json: body.data });
          return;
        }
      }
      send({ status: 404, json: apiError('not_found', `No route ${received.method} ${path}`) });
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    daemonId,
    token,
    requests,
    layouts,
    respondWith(next) {
      handler = next;
    },
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

/** The folders a test made, removed by {@link removeTempDirs}. */
const tempDirs: string[] = [];

/** A fresh temporary folder (never a real user folder). */
export async function tempDir(prefix = 'otheater-client-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

/**
 * Writes `api.json` and `api-token` in a data folder as the daemon does (P3), in the shapes of
 * `@otheater/protocol`'s discovery module. `pid` defaults to this process, which is alive.
 */
export async function writeDaemonFiles(
  dataDir: string,
  daemon: Pick<TestDaemon, 'url' | 'daemonId' | 'token'>,
  pid = process.pid,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, API_DISCOVERY_FILE),
    JSON.stringify({ url: daemon.url, daemonId: daemon.daemonId, pid, apiVersion: API_VERSION }),
    { mode: 0o600 },
  );
  await writeFile(join(dataDir, API_TOKEN_FILE), `${daemon.token}\n`, { mode: 0o600 });
}
