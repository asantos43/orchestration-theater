// SPDX-License-Identifier: MPL-2.0
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { AdapterUnavailable, isOTheaterError } from '@otheater/core';
import {
  API_ROUTE_LIST,
  API_VERSION,
  apiError,
  apiErrorCodeOf,
  apiErrorStatus,
  invalidInputDetails,
  type ApiDiscovery,
  type ApiErrorCode,
  type ApiRejectionReason,
  type DaemonId,
} from '@otheater/protocol';
import { Hono, type Context } from 'hono';
import type { ZodType } from 'zod';
import type { ApiTokenMode } from '../config.js';
import type { Logger } from '../logger.js';
import type { RecoveryGate } from '../recovery/gate.js';
import type { SituationSink } from '../situations.js';
import {
  generateApiToken,
  publishDiscovery,
  readDiscovery,
  removeDiscovery,
  sameToken,
  writePrivateFile,
} from './files.js';
import { ApiFailure, ApiHandlers, type HandlerEntry } from './handlers.js';

/** Where the API listens: the loopback only, like the MCP server and the Producer channel. */
export const API_HOST = '127.0.0.1';

/** The headers a page of an allowed origin may send. [proposta] Fixed: the contract names them. */
const CORS_ALLOWED_HEADERS = 'authorization, content-type, last-event-id, idempotency-key';
const CORS_ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';

export interface ApiServerOptions {
  /** The handlers of the routes. Default: an empty table (every route answers 404). */
  readonly handlers?: ApiHandlers;
  /** `auto` lets the system pick a free port (`api.port`). */
  readonly port: number | 'auto';
  /** The token of this start (see `loadOrCreateApiToken`). */
  readonly token: string;
  /** `api.token`, only to say it in `api.started`. */
  readonly tokenMode: ApiTokenMode;
  /** Where a rotation writes the new token (`api-token`, mode 0600). */
  readonly tokenFile: string;
  /** Where `api.json` is published once the server listens (removed on stop). */
  readonly discoveryFile: string;
  readonly daemonId: DaemonId;
  /** `api.cors.origins`: the only origins a browser page may call from. Default: none. */
  readonly corsOrigins?: readonly string[];
  /** `api.max_body_bytes`. */
  readonly maxBodyBytes: number;
  /** `api.rejection_events.every`: the window of the rate limit of `api.client_rejected`, in ms. */
  readonly rejectionWindowMs: number;
  readonly now: () => number;
  readonly logger: Logger;
  /** Where `api.started` and `api.client_rejected` go. Default: nowhere (tests of the server alone). */
  readonly situations?: SituationSink;
  /** Command routes wait here while the reconciliation of the start-up runs (5.21). Default: no wait. */
  readonly gate?: Pick<RecoveryGate, 'wait'>;
}

type Listener = () => void;

/**
 * The HTTP API of the daemon (architecture 5.12, P3 of docs/17): Hono on `@hono/node-server`, bound to
 * `127.0.0.1` only. Every request, status included, goes through the same guard before any route:
 *
 * 1. `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), else 403;
 * 2. an `Origin` must be in `api.cors.origins`, else 403 (a client that is not a browser sends none);
 * 3. `Authorization: Bearer <token>` must hold the current token, else 401.
 *
 * Then the route is matched in the registry of the protocol, its parts are validated with the
 * schemas of the route, a command waits for the recovery gate, and the handler of the route
 * (`handlers`) runs. Every error answer is `{ error: { code, message, details? } }`. No
 * `Access-Control-Allow-*` header is ever sent for an origin that is not in the list.
 */
export class ApiServer {
  readonly handlers: ApiHandlers;
  readonly host = API_HOST;
  readonly port: number;
  readonly #http: HttpServer;
  readonly #options: ApiServerOptions;
  readonly #origins: ReadonlySet<string>;
  readonly #stopController = new AbortController();
  readonly #rotationListeners = new Set<Listener>();
  readonly #rejections = new Map<ApiRejectionReason, { lastAt: number; suppressed: number }>();
  #token: string;
  #rotating: Promise<void> = Promise.resolve();
  #stopped: Promise<void> | undefined;

  private constructor(options: ApiServerOptions, http: HttpServer, port: number) {
    this.#options = options;
    this.#origins = new Set(options.corsOrigins ?? []);
    this.#http = http;
    this.port = port;
    this.#token = options.token;
    this.handlers = options.handlers ?? new ApiHandlers();
  }

  /**
   * Starts listening, publishes `api.json` and records `api.started`. A port that cannot be taken
   * (`api.port` fixed and busy) is `AdapterUnavailable`, like the other servers of the daemon.
   */
  static async start(options: ApiServerOptions): Promise<ApiServer> {
    const handlers = options.handlers ?? new ApiHandlers();
    const resolved: ApiServerOptions = { ...options, handlers };
    const app = new Hono();
    // The server needs its own port to check `Host`, and the port is known only after listening:
    // the guard reads it from `holder` at each request.
    const holder: { server?: ApiServer } = {};
    ApiServer.#mount(app, holder, resolved);
    const http = await new Promise<HttpServer>((resolve, reject) => {
      const server = serve(
        {
          fetch: app.fetch,
          hostname: API_HOST,
          port: options.port === 'auto' ? 0 : options.port,
        },
        () => {
          server.off('error', onError);
          resolve(server);
        },
      ) as HttpServer;
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(new AdapterUnavailable(`The API could not listen on ${API_HOST}: ${error.message}`));
      };
      server.once('error', onError);
    });
    const { port } = http.address() as AddressInfo;
    const api = new ApiServer(resolved, http, port);
    holder.server = api;
    // [proposta] The rotation is a route of the contract (`POST /v1/api-token/rotate`), always there.
    if (!api.handlers.has('rotateApiToken')) {
      api.handlers.register(
        'rotateApiToken',
        async () => {
          await api.rotateToken();
          return { rotated: true };
        },
        // Not held by the recovery gate: swapping the token touches no orchestration state, and a
        // leaked token should be revocable even while the daemon is still reconciling.
        { command: false },
      );
    }
    try {
      await api.#publish();
    } catch (error) {
      await api.stop().catch(() => undefined);
      throw error;
    }
    return api;
  }

  /** The base URL, with no token and no trailing slash. */
  get url(): string {
    return `http://${API_HOST}:${String(this.port)}`;
  }

  get daemonId(): DaemonId {
    return this.#options.daemonId;
  }

  /** Aborts when the server stops: what a long answer (a stream) ends on. */
  get stopSignal(): AbortSignal {
    return this.#stopController.signal;
  }

  /** The underlying Node server, for a route that upgrades the connection (the chat socket, P7). */
  get httpServer(): HttpServer {
    return this.#http;
  }

  /**
   * The request as a route that takes over the connection sees it (the WebSocket upgrade, P7):
   * the same three checks of every request, in the same order, with the same events. `undefined`
   * means the request may go on; otherwise this is the answer to send.
   */
  guard(request: Request): Response | undefined {
    return this.#checkHost(request) ?? this.#checkOrigin(request) ?? this.#checkToken(request);
  }

  /**
   * Hook of the rotation: `listener` runs right after the token is swapped, so the streams and
   * sockets opened under the old token (P4, P7) can close themselves. Returns what removes it. A
   * listener that throws is logged and does not stop the others.
   */
  onTokenRotated(listener: Listener): () => void {
    this.#rotationListeners.add(listener);
    return () => {
      this.#rotationListeners.delete(listener);
    };
  }

  /**
   * Swaps the token: a new one is written to `api-token` (atomic, 0600) and the old one stops
   * working at once. Calls are serialized. Resolves after the file is written and the listeners ran.
   */
  rotateToken(): Promise<void> {
    const run = this.#rotating.then(async () => {
      const next = generateApiToken();
      // The file first: when the write fails the old token still works and nothing changed.
      await writePrivateFile(this.#options.tokenFile, `${next}\n`);
      this.#token = next;
      this.#options.logger.info('the API token was rotated');
      for (const listener of [...this.#rotationListeners]) {
        try {
          listener();
        } catch (error) {
          this.#options.logger.error({ err: error }, 'a listener of the token rotation failed');
        }
      }
    });
    this.#rotating = run.catch(() => undefined);
    return run;
  }

  /** Stops listening, drops the open connections and removes `api.json`. Idempotent. */
  stop(): Promise<void> {
    this.#stopped ??= (async () => {
      await removeDiscovery(this.#options.discoveryFile).catch((error: unknown) => {
        this.#options.logger.warn({ err: error }, 'api.json could not be removed');
      });
      this.#stopController.abort();
      await new Promise<void>((resolve) => {
        this.#http.close(() => {
          resolve();
        });
        this.#http.closeAllConnections();
      });
    })();
    return this.#stopped;
  }

  // ---- start-up ----

  async #publish(): Promise<void> {
    const { discoveryFile, daemonId, logger, situations } = this.#options;
    const found = await readDiscovery(discoveryFile);
    if (found.kind === 'stale') {
      logger.info({ pid: found.info.pid }, 'replaced the api.json of a daemon that is gone');
    }
    const info: ApiDiscovery = {
      url: this.url,
      daemonId,
      pid: process.pid,
      apiVersion: API_VERSION,
    };
    await publishDiscovery(discoveryFile, info);
    logger.info({ url: this.url }, 'API listening');
    situations?.record('api.started', {
      url: this.url,
      daemonId,
      tokenMode: this.#options.tokenMode,
    });
  }

  // ---- the guard ----

  #checkHost(request: Request): Response | undefined {
    const host = request.headers.get('host')?.toLowerCase();
    const port = String(this.port);
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return undefined;
    return this.#reject('host', 403, 'forbidden', 'The Host header is not allowed', request);
  }

  #checkOrigin(request: Request): Response | undefined {
    const origin = request.headers.get('origin');
    if (origin === null || this.#origins.has(origin)) return undefined;
    return this.#reject('origin', 403, 'forbidden', 'The Origin is not allowed', request);
  }

  #checkToken(request: Request): Response | undefined {
    const match = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '');
    if (match !== null && sameToken(match[1], this.#token)) return undefined;
    return this.#reject('token', 401, 'unauthorized', 'A valid API token is required', request, {
      'www-authenticate': 'Bearer realm="otheater"',
    });
  }

  /**
   * The answer for a refused request, and the record of it: a log line and, at most once per
   * window and reason, an `api.client_rejected` event that counts what was held back since the
   * last one. Never the value the client sent.
   */
  #reject(
    reason: ApiRejectionReason,
    status: number,
    code: ApiErrorCode,
    message: string,
    request: Request,
    headers: Record<string, string> = {},
  ): Response {
    const { now, rejectionWindowMs, logger, situations } = this.#options;
    const at = now();
    const state = this.#rejections.get(reason);
    if (state === undefined || at - state.lastAt >= rejectionWindowMs) {
      const suppressed = state?.suppressed ?? 0;
      this.#rejections.set(reason, { lastAt: at, suppressed: 0 });
      logger.warn({ reason, method: request.method }, 'an API request was rejected');
      situations?.record('api.client_rejected', { reason, suppressed });
    } else {
      state.suppressed += 1;
      logger.debug({ reason, method: request.method }, 'an API request was rejected');
    }
    return Response.json(apiError(code, message), {
      status,
      headers: { 'cache-control': 'no-store', ...headers },
    });
  }

  // ---- the app ----

  static #mount(app: Hono, holder: { server?: ApiServer }, options: ApiServerOptions): void {
    const server = (): ApiServer => {
      if (holder.server === undefined) throw new Error('The API server is not listening yet');
      return holder.server;
    };
    app.use('*', async (c, next) => {
      const self = server();
      const request = c.req.raw;
      const origin = request.headers.get('origin');
      // A preflight carries no token by design: it is answered for an allowed origin only.
      if (request.method === 'OPTIONS' && origin !== null) {
        const refused = self.#checkHost(request) ?? self.#checkOrigin(request);
        if (refused !== undefined) return refused;
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(origin),
            'access-control-allow-methods': CORS_ALLOWED_METHODS,
            'access-control-allow-headers': CORS_ALLOWED_HEADERS,
            'access-control-max-age': '600',
          },
        });
      }
      const refused = self.guard(request);
      if (refused !== undefined) return refused;
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > options.maxBodyBytes) {
        return failure(
          new ApiFailure('payload_too_large', 'The request body is too large', {
            details: { maxBytes: options.maxBodyBytes },
          }),
        );
      }
      await next();
      // An origin that passed the guard is in the list; one that is not never gets here.
      if (origin !== null) {
        for (const [name, value] of Object.entries(corsHeaders(origin))) {
          c.res.headers.set(name, value);
        }
      }
      return undefined;
    });
    for (const route of API_ROUTE_LIST) {
      app.on(route.method, route.path, (c) => server().#dispatch(c, route.id));
    }
    app.notFound(() => failure(new ApiFailure('not_found', 'No such route')));
    app.onError((error) => {
      if (!(error instanceof ApiFailure) && apiErrorCodeOf(error) === 'internal') {
        options.logger.error({ err: error }, 'an API request failed');
      }
      return failure(error);
    });
  }

  async #dispatch(c: Context, id: string): Promise<Response> {
    const entry = this.handlers.get(id);
    // [proposta] A route with no handler is not mounted: the same 404 as a path that does not exist.
    if (entry === undefined) return failure(new ApiFailure('not_found', 'No such route'));
    const { route } = entry;
    const request = c.req.raw;
    const params = parsePart(route.params, c.req.param(), 'path');
    const query = parsePart(route.query, queryOf(request), 'query');
    const headers = parsePart(route.headers, headersOf(request), 'header');
    const body =
      route.body === undefined
        ? undefined
        : parsePart(route.body, await readJson(request, this.#options.maxBodyBytes), 'body');
    // A command acts on the state, so it waits for the reconciliation of the start-up (5.21).
    if (entry.command) await this.#options.gate?.wait();
    const signal = AbortSignal.any([request.signal, this.#stopController.signal]);
    const result = await entry.handler({ params, query, headers, body, request, signal });
    return this.#answer(entry, result);
  }

  #answer(entry: HandlerEntry, result: unknown): Response {
    if (result instanceof Response) return result;
    if (entry.route.kind !== 'json') {
      throw new Error(
        `The route ${entry.route.id} is a stream and its handler must return a Response`,
      );
    }
    // The contract is the schema of the route: an answer that does not fit it is a bug of the handler.
    const checked = entry.route.response.safeParse(result);
    if (!checked.success) {
      throw new Error(
        `The answer of ${entry.route.id} does not fit its schema: ${checked.error.message}`,
      );
    }
    return Response.json(result);
  }
}

function corsHeaders(origin: string): Record<string, string> {
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

/** The error answer for any thrown value. A message of an unexpected failure never leaves the daemon. */
function failure(error: unknown): Response {
  if (error instanceof ApiFailure) {
    return Response.json(apiError(error.code, error.message, error.details), {
      status: apiErrorStatus(error.code),
      ...(error.headers === undefined ? {} : { headers: error.headers }),
    });
  }
  const code = apiErrorCodeOf(error);
  const message =
    code !== 'internal' && isOTheaterError(error)
      ? error.message
      : 'The daemon failed this request';
  return Response.json(apiError(code, message), { status: apiErrorStatus(code) });
}

function parsePart(schema: ZodType | undefined, value: unknown, where: string): never {
  if (schema === undefined) return undefined as never;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as never;
  throw new ApiFailure('invalid_input', `The ${where} of the request is not valid`, {
    details: invalidInputDetails(parsed.error),
  });
}

/** `?a=1&a=2&b=3` as `{ a: ['1', '2'], b: '3' }`: a key that comes once is a string, a repeated one a list. */
function queryOf(request: Request): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const previous = out[key];
    if (previous === undefined) out[key] = value;
    else out[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

function headersOf(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

/** Reads the body as JSON, never more than `max` bytes. */
async function readJson(request: Request, max: number): Promise<unknown> {
  const tooLarge = (): ApiFailure =>
    new ApiFailure('payload_too_large', 'The request body is too large', {
      details: { maxBytes: max },
    });
  if (request.body === null) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ApiFailure('invalid_input', 'The body of the request is not valid JSON');
  }
}
