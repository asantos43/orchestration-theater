// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';
import {
  API_ROUTES,
  type AnyApiRoute,
  type ApiErrorCode,
  type ApiRouteId,
  type RouteResponse,
} from '@otheater/protocol';
import type { WSEvents } from 'hono/ws';
import type { WebSocket } from 'ws';
import type { z } from 'zod';

/**
 * The handlers of the API routes (P3 of docs/17). The routes are data in `packages/protocol`
 * (`API_ROUTES`); a handler is the code that answers one of them. The server validates what comes
 * in (path parameters, query, headers, body) with the schemas of the route and hands the handler the
 * parsed values, so a handler never reads a raw request. P4 to P7 register theirs here.
 */

/** What an unparsed part of a route becomes: its parsed type, or `undefined` when the route has none. */
type Parsed<Schema> = Schema extends z.ZodType ? z.output<Schema> : undefined;

/** What a handler receives. */
export interface ApiCall<Route extends AnyApiRoute> {
  readonly params: Parsed<Route['params']>;
  readonly query: Parsed<Route['query']>;
  /** The headers the route declares, keyed by the lower-case name. */
  readonly headers: Parsed<Route['headers']>;
  /** The parsed JSON body (at most `api.max_body_bytes`). */
  readonly body: Parsed<Route['body']>;
  /** The request as it came, for what the route's schemas do not cover (a stream reads the socket here). */
  readonly request: Request;
  /** Aborts when the client goes away or the daemon stops. */
  readonly signal: AbortSignal;
  /**
   * Only on a route of kind `websocket` (P7): upgrades the connection and hands the socket to
   * `events`. It resolves to the `Response` the handler returns. Call it only after the route
   * accepted the request: a refusal is a plain `Response`, and the upgrade never happens.
   */
  readonly upgrade?: (events: ApiSocketEvents) => Promise<Response>;
}

/** What a route that upgrades the connection listens to; `raw` of the context is the `ws` socket. */
export type ApiSocketEvents = WSEvents<WebSocket>;

/**
 * What a handler returns: the value of the `response` schema (the server answers it as JSON with
 * status 200), or a `Response` of its own (a stream, a status other than 200). A route of kind
 * `sse` or `websocket` always answers a `Response`.
 */
export type ApiResult<Route extends AnyApiRoute> = RouteResponse<Route> | Response;

export type ApiHandler<Route extends AnyApiRoute> = (
  call: ApiCall<Route>,
) => ApiResult<Route> | Promise<ApiResult<Route>>;

/**
 * A failure a handler throws to answer with a code of the API. A handler may also throw the errors
 * of the core (`NotFound`, `Conflict`, `InvalidInput`...): the server maps them with
 * `apiErrorCodeOf`. This one exists for the codes the core has no error for (`payload_too_large`,
 * `recovering`) and for `details`.
 */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly details: Readonly<Record<string, JsonValue>> | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: {
      readonly details?: Readonly<Record<string, JsonValue>>;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export interface HandlerOptions {
  /**
   * Marks the route as a command: it waits for the reconciliation of the start-up (5.21) before
   * it runs, so it never acts on a state that is about to change. A read answers from the first
   * moment. [proposta] Default: every method but `GET` is a command.
   */
  readonly command?: boolean;
}

export interface HandlerEntry {
  readonly route: AnyApiRoute;
  readonly handler: ApiHandler<AnyApiRoute>;
  readonly command: boolean;
}

/**
 * The table of handlers, keyed by the `id` of the route. The server looks a handler up at each
 * request, so one may be registered before or after the server starts. [proposta] A route of the
 * registry with no handler is not mounted: it answers 404 `not_found`, like a path that does not
 * exist (the set of codes of the API has no 501).
 */
export class ApiHandlers {
  readonly #entries = new Map<string, HandlerEntry>();

  /** Registers the handler of a route. Throws for an unknown id or a second handler of one id. */
  register<Id extends ApiRouteId>(
    id: Id,
    handler: ApiHandler<(typeof API_ROUTES)[Id]>,
    options: HandlerOptions = {},
  ): this {
    const route: AnyApiRoute | undefined = (API_ROUTES as Record<string, AnyApiRoute>)[id];
    if (route === undefined) throw new Error(`No API route has the id ${id}`);
    if (this.#entries.has(id)) throw new Error(`The API route ${id} already has a handler`);
    this.#entries.set(id, {
      route,
      handler,
      command: options.command ?? route.method !== 'GET',
    });
    return this;
  }

  get(id: string): HandlerEntry | undefined {
    return this.#entries.get(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** The ids with a handler, sorted. */
  ids(): string[] {
    return [...this.#entries.keys()].sort();
  }
}
