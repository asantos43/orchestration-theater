// SPDX-License-Identifier: MPL-2.0
import {
  API_ROUTES,
  ApiErrorSchema,
  invalidInputDetails,
  isSupportedApiVersion,
  routePath,
  type AnyApiRoute,
  type ApiStatus,
  type CreateOrderBody,
  type DaemonId,
  type DirectPromoteBody,
  type OpenDirectBody,
  type ExtendOrderBody,
  type OrderValidity,
  type RouteBody,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  type ScenarioRef,
} from '@otheater/protocol';
import type { z } from 'zod';
import {
  ApiInputError,
  ApiNetworkError,
  ApiProtocolError,
  ApiRequestError,
  ApiVersionError,
  DaemonIdMismatchError,
  type ApiErrorContext,
} from './errors.js';
import { ChatSocket, type ChatSocketOptions, type WebSocketConstructor } from './chat-socket.js';
import { EventStream, type EventStreamOptions } from './event-stream.js';
import { networkDetail, parseJsonText, retryAfterSeconds, type FetchLike } from './http.js';

/**
 * Typed REST client of one daemon (plan docs/17 P9). It is generic over the route registry of
 * `@otheater/protocol`: `client.call(route, { params, query, body, headers })` takes the types of
 * the route's schemas, sends `Authorization: Bearer`, and returns the answer parsed by the
 * route's `response` schema. It runs on `fetch` only, so it works in Node 24 and in a browser.
 */

export type { FetchLike } from './http.js';

/** Per-call deadline when nothing else says. [proposta] 30 s. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiClientOptions {
  /** Base URL of the daemon (`http://127.0.0.1:<port>`); a path prefix is kept (reverse proxy). */
  readonly url: string;
  /** The API token. Sent as `Authorization: Bearer`, never logged and never put in an error. */
  readonly token: string;
  /**
   * The id the list expects at this address (N168). It goes into every error, and
   * {@link ApiClient.connect} checks the daemon against it.
   */
  readonly daemonId?: DaemonId | undefined;
  readonly fetch?: FetchLike | undefined;
  /** Deadline of one call in milliseconds; `0` means none. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/** What every call accepts besides the parts of its route. */
export interface CallControl {
  /** Aborts the call: it fails with an `ApiNetworkError` of reason `aborted`. */
  readonly signal?: AbortSignal | undefined;
  /** Overrides the client's deadline for this call; `0` means none. */
  readonly timeoutMs?: number | undefined;
}

/** What the commands of a play or an attempt accept besides the usual call control (N176). */
export interface CommandControl extends CallControl {
  /** Sent as `Idempotency-Key`: a repeat of the command with it does not repeat the effect. */
  readonly idempotencyKey?: string | undefined;
}

function commandHeaders(control: CommandControl): {
  readonly headers?: { readonly 'idempotency-key': string };
} {
  return control.idempotencyKey === undefined
    ? {}
    : { headers: { 'idempotency-key': control.idempotencyKey } };
}

function callControlOf(control: CommandControl): CallControl {
  return {
    ...(control.signal === undefined ? {} : { signal: control.signal }),
    ...(control.timeoutMs === undefined ? {} : { timeoutMs: control.timeoutMs }),
  };
}

/** An object with no keys: it is assignable to a type exactly when all its keys are optional. */
type Empty = Record<string, never>;

/** The request headers of a route as its schema types them (lower-case keys). */
export type RouteHeaders<R extends AnyApiRoute> = R['headers'] extends z.ZodType
  ? z.input<R['headers']>
  : undefined;

type ParamsPart<R extends AnyApiRoute> = R['params'] extends z.ZodType
  ? { readonly params: RouteParams<R> }
  : { readonly params?: undefined };

type QueryPart<R extends AnyApiRoute> = R['query'] extends z.ZodType
  ? Empty extends RouteQuery<R>
    ? { readonly query?: RouteQuery<R> }
    : { readonly query: RouteQuery<R> }
  : { readonly query?: undefined };

type BodyPart<R extends AnyApiRoute> = R['body'] extends z.ZodType
  ? { readonly body: RouteBody<R> }
  : { readonly body?: undefined };

type HeadersPart<R extends AnyApiRoute> = R['headers'] extends z.ZodType
  ? Empty extends RouteHeaders<R>
    ? { readonly headers?: RouteHeaders<R> }
    : { readonly headers: RouteHeaders<R> }
  : { readonly headers?: undefined };

/** The options of a call to route `R`: each part the route has is typed by its schema. */
export type CallOptions<R extends AnyApiRoute> = CallControl &
  ParamsPart<R> &
  QueryPart<R> &
  BodyPart<R> &
  HeadersPart<R>;

/** The options argument is required exactly when the route has a required part. */
export type CallArgs<R extends AnyApiRoute> =
  Empty extends CallOptions<R> ? [options?: CallOptions<R>] : [options: CallOptions<R>];

/** The same options, as the code that sends them sees them. */
interface RuntimeCallOptions extends CallControl {
  readonly params?: Readonly<Record<string, string | number>> | undefined;
  readonly query?: Readonly<Record<string, unknown>> | undefined;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export class ApiClient {
  /** Base URL with no trailing slash. */
  readonly url: string;
  /** The daemon the client was told it talks to, when the list knew it. */
  readonly daemonId: DaemonId | undefined;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.daemonId = options.daemonId;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Calls a `json` route. Resolves with the answer parsed by the route's `response` schema, or
   * rejects with an {@link ApiRequestError} (an error answer of the API), an
   * {@link ApiProtocolError} (an answer outside the contract), an {@link ApiNetworkError} (no
   * answer) or an {@link ApiInputError} (the input does not fit the route; nothing was sent).
   * `sse` and `websocket` routes are not calls: they have their own clients (P10).
   */
  async call<R extends AnyApiRoute>(route: R, ...args: CallArgs<R>): Promise<RouteResponse<R>> {
    const options = (args[0] ?? {}) as RuntimeCallOptions;
    if (route.kind !== 'json') {
      throw new TypeError(
        `Route ${route.id} is a ${route.kind} route: it does not go through call()`,
      );
    }
    const context: ApiErrorContext = { daemonId: this.daemonId, routeId: route.id };
    const request = this.#prepare(route, options, context);
    const { response, text } = await this.#send(route, request, options, context);
    return this.#interpret(route, response, text, context) as RouteResponse<R>;
  }

  /** `GET /v1/status`. */
  status(options: CallControl = {}): Promise<ApiStatus> {
    return this.call(API_ROUTES.getStatus, options);
  }

  // ---- pause, resume and cancel (Phase 7, P2, N176) ----

  /** `POST /v1/plays/:playId/pause`: the play opens nothing new; `mode` overrides `pause.mode`. */
  pausePlay(
    playId: string,
    options: CommandControl & {
      readonly mode?: 'drain' | 'interrupt' | undefined;
      readonly reason?: string | undefined;
    } = {},
  ): Promise<RouteResponse<typeof API_ROUTES.pausePlay>> {
    const { mode, reason, ...control } = options;
    const body = {
      ...(mode === undefined ? {} : { mode }),
      ...(reason === undefined ? {} : { reason }),
    };
    return this.call(API_ROUTES.pausePlay, {
      params: { playId },
      body: Object.keys(body).length === 0 ? undefined : body,
      ...commandHeaders(control),
      ...callControlOf(control),
    });
  }

  /** `POST /v1/plays/:playId/resume`. */
  resumePlay(
    playId: string,
    options: CommandControl & { readonly reason?: string | undefined } = {},
  ): Promise<RouteResponse<typeof API_ROUTES.resumePlay>> {
    const { reason, ...control } = options;
    return this.call(API_ROUTES.resumePlay, {
      params: { playId },
      body: reason === undefined ? undefined : { reason },
      ...commandHeaders(control),
      ...callControlOf(control),
    });
  }

  /** `POST /v1/attempts/:attemptId/pause`: an Actor in flight stops with its checkpoint saved. */
  pauseAttempt(
    attemptId: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.pauseAttempt>> {
    return this.call(API_ROUTES.pauseAttempt, {
      params: { attemptId },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/attempts/:attemptId/resume`: resumes by the policy of the cause `paused`. */
  resumeAttempt(
    attemptId: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.resumeAttempt>> {
    return this.call(API_ROUTES.resumeAttempt, {
      params: { attemptId },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/attempts/:attemptId/cancel`: ends the Actor as cancelled; the Director judges. */
  cancelAttempt(
    attemptId: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.cancelAttempt>> {
    return this.call(API_ROUTES.cancelAttempt, {
      params: { attemptId },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  // ---- orders (Phase 7, P15) ----

  /** `POST /v1/orders`: gives an order (an instruction, a rule or a suspension). */
  createOrder(
    body: CreateOrderBody,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.createOrder>> {
    return this.call(API_ROUTES.createOrder, {
      body,
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/orders/:orderId/extend`: changes the validity (`for` counts from the current end). */
  extendOrder(
    orderId: string,
    validity: ExtendOrderBody['validity'],
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.extendOrder>> {
    return this.call(API_ROUTES.extendOrder, {
      params: { orderId },
      body: { validity },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /**
   * `POST /v1/orders/:orderId/suspend`: gives a local suspension that takes a global order out of
   * one scenario. The order itself is not touched.
   */
  suspendOrder(
    orderId: string,
    body: {
      readonly scenarioId: string;
      readonly text?: string | undefined;
      readonly validity?: OrderValidity | undefined;
    },
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.suspendOrder>> {
    return this.call(API_ROUTES.suspendOrder, {
      params: { orderId },
      body: {
        scenarioId: body.scenarioId,
        ...(body.text === undefined ? {} : { text: body.text }),
        ...(body.validity === undefined ? {} : { validity: body.validity }),
      },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/orders/:orderId/revoke`: ends the order for good, with the reason. */
  revokeOrder(
    orderId: string,
    reason: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.revokeOrder>> {
    return this.call(API_ROUTES.revokeOrder, {
      params: { orderId },
      body: { reason },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /**
   * The handshake: asks `GET /v1/status` and checks what comes back. A different `daemonId` from
   * the one the client was told is a {@link DaemonIdMismatchError} (N168), and an API version
   * this build does not speak is an {@link ApiVersionError}. Resolves with the status.
   */
  async connect(options: CallControl = {}): Promise<ApiStatus> {
    const status = await this.status(options);
    if (this.daemonId !== undefined && status.daemonId !== this.daemonId) {
      throw new DaemonIdMismatchError(
        { expected: this.daemonId, actual: status.daemonId },
        new URL(this.url).origin,
      );
    }
    if (!isSupportedApiVersion(status.apiVersion)) {
      throw new ApiVersionError(status.apiVersion, { daemonId: this.daemonId });
    }
    return status;
  }

  /**
   * The event stream of this daemon (`GET /v1/events`), with the filters, cursor and backoff of
   * `options`. It is not started: add the listeners, then call `start()`. The token stays in the
   * client and goes only in `Authorization`. [proposta]
   */
  events(options: EventStreamOptions = {}): EventStream {
    return new EventStream(
      { url: this.url, token: this.#token, daemonId: this.daemonId, fetch: this.#fetch },
      options,
    );
  }

  /**
   * The chat socket of a scenario of this daemon. It is not started: add the listeners, then call
   * `start()`. Each connection gets its ticket by `POST /v1/chat-tickets` with this client's token.
   * `webSocket` replaces the runtime's `WebSocket` (tests, or a runtime that has none). [proposta]
   */
  chat(
    scenarioId: string,
    options: ChatSocketOptions & { readonly webSocket?: WebSocketConstructor | undefined } = {},
  ): ChatSocket {
    const { webSocket, ...rest } = options;
    return new ChatSocket(
      {
        url: this.url,
        daemonId: this.daemonId,
        webSocket,
        createTicket: (id, signal) =>
          this.call(API_ROUTES.createChatTicket, { body: { scenarioId: id }, signal }),
      },
      scenarioId,
      rest,
    );
  }

  // ---- direct sessions with an Actor (Phase 7, P19) ----

  /** `POST /v1/scenarios/:scenarioId/direct`: opens a session, or asks to confirm `scenario`. */
  openDirectSession(
    scenarioId: string,
    body: OpenDirectBody = {},
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.openDirectSession>> {
    return this.call(API_ROUTES.openDirectSession, {
      params: { scenarioId },
      body,
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `GET /v1/scenarios/:scenarioId/direct`: the open sessions and the last closed ones. */
  listDirectSessions(
    scenarioId: string,
    options: CallControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.listDirectSessions>> {
    return this.call(API_ROUTES.listDirectSessions, { params: { scenarioId }, ...options });
  }

  /** `GET /v1/direct/:sessionId`: the session with what was said and done in it. */
  getDirectSession(
    sessionId: string,
    options: CallControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.getDirectSession>> {
    return this.call(API_ROUTES.getDirectSession, { params: { sessionId }, ...options });
  }

  /** `POST /v1/direct/:sessionId/messages`: a message for the Actor; the turn runs in the background. */
  sendDirectMessage(
    sessionId: string,
    text: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.sendDirectMessage>> {
    return this.call(API_ROUTES.sendDirectMessage, {
      params: { sessionId },
      body: { text },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/direct/:sessionId/commands`: a `/` command of the Executor's client. */
  runDirectCommand(
    sessionId: string,
    text: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.runDirectCommand>> {
    return this.call(API_ROUTES.runDirectCommand, {
      params: { sessionId },
      body: { text },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/direct/:sessionId/cancel`: stops the turn in flight (the session stays open). */
  cancelDirectTurn(
    sessionId: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.cancelDirectTurn>> {
    return this.call(API_ROUTES.cancelDirectTurn, {
      params: { sessionId },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/direct/:sessionId/close`: closes the session and settles its work. */
  closeDirectSession(
    sessionId: string,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.closeDirectSession>> {
    return this.call(API_ROUTES.closeDirectSession, {
      params: { sessionId },
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** `POST /v1/direct/:sessionId/promote`: the result becomes a demand (an idea) or a piece (a play). */
  promoteDirectSession(
    sessionId: string,
    body: DirectPromoteBody,
    options: CommandControl = {},
  ): Promise<RouteResponse<typeof API_ROUTES.promoteDirectSession>> {
    return this.call(API_ROUTES.promoteDirectSession, {
      params: { sessionId },
      body,
      ...commandHeaders(options),
      ...callControlOf(options),
    });
  }

  /** The global reference of a scenario of this daemon (N168). Needs the id of the daemon. */
  scenarioRef(scenarioId: string): ScenarioRef {
    if (this.daemonId === undefined) {
      throw new TypeError('This client does not know the id of its daemon: connect first');
    }
    return { daemonId: this.daemonId, scenarioId };
  }

  #prepare(
    route: AnyApiRoute,
    options: RuntimeCallOptions,
    context: ApiErrorContext,
  ): { url: string; init: RequestInit & { headers: Headers } } {
    const checks = [
      [
        'params',
        route.params,
        route.params === undefined ? options.params : (options.params ?? {}),
      ],
      ['query', route.query, route.query === undefined ? options.query : (options.query ?? {})],
      ['body', route.body, options.body],
    ] as const;
    for (const [part, schema, value] of checks) this.#validate(part, schema, value, context);

    const headers = new Headers();
    const given = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.#validate(
      'headers',
      route.headers,
      route.headers === undefined ? options.headers : given,
      context,
    );
    for (const [name, value] of Object.entries(given)) headers.set(name, value);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${this.#token}`);

    const url = new URL(`${this.url}${routePath(route, options.params ?? {})}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
        if (item !== undefined) url.searchParams.append(key, queryValue(item));
      }
    }
    const init: RequestInit & { headers: Headers } = {
      method: route.method,
      headers,
      redirect: 'manual',
    };
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(options.body);
    }
    return { url: url.toString(), init };
  }

  #validate(
    part: 'params' | 'query' | 'headers' | 'body',
    schema: z.ZodType | undefined,
    value: unknown,
    context: ApiErrorContext,
  ): void {
    if (schema === undefined) {
      if (value !== undefined) {
        throw new ApiInputError(
          { part, issues: [{ path: [], message: `this route takes no ${part}` }] },
          context,
        );
      }
      return;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ApiInputError({ part, issues: invalidInputDetails(parsed.error).issues }, context);
    }
  }

  async #send(
    route: AnyApiRoute,
    request: { url: string; init: RequestInit },
    options: RuntimeCallOptions,
    context: ApiErrorContext,
  ): Promise<{ response: Response; text: string }> {
    const origin = new URL(request.url).origin;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signals = [options.signal, timeout].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      const response = await this.#fetch(request.url, {
        ...request.init,
        ...(signal === undefined ? {} : { signal }),
      });
      return { response, text: await response.text() };
    } catch (cause) {
      const reason =
        options.signal?.aborted === true
          ? 'aborted'
          : timeout?.aborted === true
            ? 'timeout'
            : 'connection';
      throw new ApiNetworkError(
        { reason, origin, ...(reason === 'connection' ? networkDetail(cause) : {}) },
        { ...context, routeId: route.id },
        { cause },
      );
    }
  }

  #interpret(
    route: AnyApiRoute,
    response: Response,
    text: string,
    context: ApiErrorContext,
  ): unknown {
    const status = response.status;
    const body = parseJsonText(text);
    if (response.ok) {
      if (!body.ok) throw new ApiProtocolError({ reason: 'invalid_json', status }, context);
      const parsed = route.response.safeParse(body.value);
      if (!parsed.success) {
        throw new ApiProtocolError(
          { reason: 'invalid_response', status, issues: invalidInputDetails(parsed.error).issues },
          context,
        );
      }
      return parsed.data;
    }
    const error = body.ok ? ApiErrorSchema.safeParse(body.value) : undefined;
    if (error?.success !== true) {
      throw new ApiProtocolError({ reason: 'invalid_error_body', status }, context);
    }
    throw new ApiRequestError(
      {
        status,
        body: error.data.error,
        retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
      },
      context,
    );
  }
}

/** A query value as text; an array is sent as repeated keys by the caller. */
function queryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}
