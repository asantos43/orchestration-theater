// SPDX-License-Identifier: MPL-2.0
import {
  CHAT_TICKET_PARAM,
  ChatClientMessageSchema,
  ChatServerMessageSchema,
  invalidInputDetails,
  openChatSocket,
  routePath,
  type ChatClientMessage,
  type ChatServerMessage,
  type ChatTicket,
  type DaemonId,
} from '@otheater/protocol';
import {
  ConnectionFailure,
  Listeners,
  ReconnectingConnection,
  type ReconnectOptions,
} from './connection.js';
import {
  ApiClientError,
  ApiInputError,
  ApiNetworkError,
  ApiProtocolError,
  ApiRequestError,
  ChatNotOpenError,
  type ApiErrorContext,
} from './errors.js';

/**
 * Client of the chat WebSocket (plan docs/17 P10, daemon side in P7): one scenario, both
 * directions, every message checked against the unions of the contract. It trades the token for a
 * one-use ticket (`POST /v1/chat-tickets`) before each connection and opens
 * `GET /v1/scenarios/:id/chat?ticket=...`, so the token never goes in a URL. After a drop it
 * comes back by itself and sends `resume` with the id of the last event it got, so the daemon
 * sends again what is missing. It uses the `WebSocket` of the runtime (Node 24 and browsers), or
 * the one it is given.
 */

/** `readyState` of an open socket (the same constant in Node and in a browser). */
export const WEBSOCKET_OPEN = 1;

/** What the client reads of an event of the socket. */
export interface WebSocketEventLike {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

/** The part of the standard `WebSocket` the client uses; a fake implements the same. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: WebSocketEventLike) => void,
  ): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface ChatSocketTarget {
  /** Base URL of the daemon (`http` or `https`); the socket uses `ws` or `wss` for the same host. */
  readonly url: string;
  readonly daemonId?: DaemonId | undefined;
  /** Gets a one-use ticket for the scenario: the REST call, with the token held by the `ApiClient`. */
  readonly createTicket: (scenarioId: string, signal: AbortSignal) => Promise<ChatTicket>;
  /** The socket class. Default: the `WebSocket` of the runtime. */
  readonly webSocket?: WebSocketConstructor | undefined;
}

export interface ChatSocketOptions extends ReconnectOptions {
  /**
   * The id of the last event the caller already has (from the event stream, say): the first
   * connection sends it as `resume`. Without it the first connection sends no `resume`.
   */
  readonly resumeFrom?: number | undefined;
  /**
   * What to do with a message of the daemon outside the contract. `fail` (default) closes the chat
   * with an {@link ApiProtocolError}; `skip` drops it and tells {@link ChatSocket.onInvalid}. [proposta]
   */
  readonly invalidMessages?: 'fail' | 'skip' | undefined;
}

/** What the Producer sends. `resume` is the client's own business, so it is not here. */
export type ChatOutgoing = Exclude<ChatClientMessage, { type: 'resume' }>;

/** Close code of a client that gives up on a message it cannot accept. */
const PROTOCOL_ERROR_CLOSE_CODE = 1002;
const NORMAL_CLOSE_CODE = 1000;

export class ChatSocket extends ReconnectingConnection {
  readonly #target: ChatSocketTarget;
  readonly #scenarioId: string;
  readonly #base: string;
  readonly #invalidMessages: 'fail' | 'skip';
  readonly #messages = new Listeners<[ChatServerMessage]>();
  readonly #invalid = new Listeners<[ApiClientError]>();
  #cursor: number | undefined;
  #socket: WebSocketLike | undefined;

  constructor(target: ChatSocketTarget, scenarioId: string, options: ChatSocketOptions = {}) {
    const base = target.url.replace(/\/+$/, '');
    super(
      { origin: new URL(base).origin, daemonId: target.daemonId, routeId: openChatSocket.id },
      options,
    );
    const params = openChatSocket.params.safeParse({ id: scenarioId });
    if (!params.success) {
      throw new ApiInputError(
        { part: 'params', issues: invalidInputDetails(params.error).issues },
        { daemonId: target.daemonId, routeId: openChatSocket.id },
      );
    }
    this.#target = target;
    this.#scenarioId = scenarioId;
    this.#base = base;
    this.#cursor = options.resumeFrom;
    this.#invalidMessages = options.invalidMessages ?? 'fail';
  }

  /** The id of the last event of the daemon the client has (the cursor of `resume`), if any. */
  get lastEventId(): number | undefined {
    return this.#cursor;
  }

  /** Watches the messages of the daemon, in order. Returns the function that stops watching. */
  onMessage(listener: (message: ChatServerMessage) => void): () => void {
    return this.#messages.add(listener);
  }

  /** Watches the messages dropped under `invalidMessages: 'skip'`. */
  onInvalid(listener: (error: ApiClientError) => void): () => void {
    return this.#invalid.add(listener);
  }

  /**
   * Sends a message. It is checked against the contract first (`ApiInputError`, nothing sent). If
   * the socket is not open it throws {@link ChatNotOpenError} and queues nothing: after a drop the
   * daemon may or may not have got the message, and sending it twice is worse than asking.
   */
  send(message: ChatOutgoing): void {
    const context = this.#context();
    const parsed = ChatClientMessageSchema.safeParse(message);
    if (!parsed.success || parsed.data.type === 'resume') {
      throw new ApiInputError(
        {
          part: 'body',
          issues: parsed.success
            ? [{ path: ['type'], message: 'resume is sent by the client itself' }]
            : invalidInputDetails(parsed.error).issues,
        },
        context,
      );
    }
    const socket = this.#socket;
    if (this.state !== 'open' || socket?.readyState !== WEBSOCKET_OPEN) {
      throw new ChatNotOpenError(this.state, context);
    }
    try {
      socket.send(JSON.stringify(parsed.data));
    } catch (cause) {
      throw new ApiNetworkError(
        { reason: 'connection', origin: new URL(this.#base).origin, detail: 'send failed' },
        context,
        { cause },
      );
    }
  }

  protected override onClosed(): void {
    this.#messages.clear();
    this.#invalid.clear();
  }

  protected override async connectOnce(signal: AbortSignal, opened: () => void): Promise<void> {
    const context = this.#context();
    const origin = new URL(this.#base).origin;
    let ticket: ChatTicket;
    try {
      ticket = await this.#target.createTicket(this.#scenarioId, signal);
    } catch (thrown) {
      if (signal.aborted) return;
      throw ticketFailure(thrown, context);
    }
    if (signal.aborted) return;

    const Socket = this.#target.webSocket ?? runtimeWebSocket();
    if (Socket === undefined) {
      throw new ConnectionFailure({
        error: new ApiNetworkError(
          { reason: 'connection', origin, detail: 'no WebSocket in this runtime' },
          context,
        ),
        retryable: false,
      });
    }
    let socket: WebSocketLike;
    try {
      socket = new Socket(this.#socketUrl(ticket.ticket));
    } catch (cause) {
      throw new ConnectionFailure({
        error: new ApiNetworkError(
          { reason: 'connection', origin, detail: 'bad socket URL' },
          context,
          {
            cause,
          },
        ),
        retryable: false,
      });
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let wasOpen = false;
      const finish = (failure?: ConnectionFailure): void => {
        if (settled) return;
        settled = true;
        this.#socket = undefined;
        signal.removeEventListener('abort', onAbort);
        if (failure === undefined) resolve();
        else reject(failure);
      };
      // `finish` comes first: a socket may answer `close` at once, and that must not count as a drop.
      const onAbort = (): void => {
        finish();
        try {
          socket.close(NORMAL_CLOSE_CODE);
        } catch {
          // A socket that cannot close is already gone.
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      socket.addEventListener('open', () => {
        if (settled) return;
        wasOpen = true;
        this.#socket = socket;
        // First thing on a connection that follows an earlier one: say where we were.
        if (this.#cursor !== undefined) {
          const resume: ChatClientMessage = { type: 'resume', lastEventId: this.#cursor };
          try {
            socket.send(JSON.stringify(resume));
          } catch (cause) {
            finish(
              new ConnectionFailure({
                error: new ApiNetworkError(
                  { reason: 'connection', origin, detail: 'resume failed' },
                  context,
                  { cause },
                ),
                retryable: true,
              }),
            );
            return;
          }
        }
        opened();
      });
      socket.addEventListener('message', (event) => {
        if (settled) return;
        const failure = this.#receive(event.data, context);
        if (failure === undefined) return;
        finish(failure);
        try {
          socket.close(PROTOCOL_ERROR_CLOSE_CODE, 'message outside the contract');
        } catch {
          // See above.
        }
      });
      socket.addEventListener('error', () => {
        // The event carries no reason (a browser hides it); the `close` that follows ends the connection.
      });
      socket.addEventListener('close', (event) => {
        const code = event.code === undefined ? '' : ` (code ${String(event.code)})`;
        finish(
          new ConnectionFailure({
            error: new ApiNetworkError(
              {
                reason: 'connection',
                origin,
                detail: wasOpen ? `socket closed${code}` : `socket did not open${code}`,
              },
              context,
            ),
            retryable: true,
          }),
        );
      });
    });
  }

  #context(): ApiErrorContext {
    return { daemonId: this.#target.daemonId, routeId: openChatSocket.id };
  }

  /** `ws(s)://host/v1/scenarios/:id/chat?ticket=...`: the ticket is the only secret in the URL, and it works once. */
  #socketUrl(ticket: string): string {
    const url = new URL(`${this.#base}${routePath(openChatSocket, { id: this.#scenarioId })}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set(CHAT_TICKET_PARAM, ticket);
    return url.toString();
  }

  /** Delivers a frame of the daemon. Returns a failure when the chat must close because of it. */
  #receive(data: unknown, context: ApiErrorContext): ConnectionFailure | undefined {
    // 101: the status of the upgrade, the only HTTP status this exchange has.
    const status = 101;
    let error: ApiProtocolError | undefined;
    let message: ChatServerMessage | undefined;
    if (typeof data !== 'string') {
      error = new ApiProtocolError({ reason: 'invalid_stream', status }, context);
    } else {
      let json: unknown;
      try {
        json = JSON.parse(data) as unknown;
      } catch {
        error = new ApiProtocolError({ reason: 'invalid_json', status }, context);
      }
      if (error === undefined) {
        const parsed = ChatServerMessageSchema.safeParse(json);
        if (parsed.success) message = parsed.data;
        else {
          error = new ApiProtocolError(
            {
              reason: 'invalid_response',
              status,
              issues: invalidInputDetails(parsed.error).issues,
            },
            context,
          );
        }
      }
    }
    if (message !== undefined) {
      if (message.eventId !== null) this.#cursor = Math.max(this.#cursor ?? 0, message.eventId);
      this.#messages.emit(message);
      return undefined;
    }
    if (error === undefined) return undefined;
    if (this.#invalidMessages === 'skip') {
      this.#invalid.emit(error);
      return undefined;
    }
    return new ConnectionFailure({ error, retryable: false });
  }
}

/** The `WebSocket` of the runtime (Node 24, a browser), or `undefined` where there is none. */
function runtimeWebSocket(): WebSocketConstructor | undefined {
  return typeof WebSocket === 'undefined' ? undefined : WebSocket;
}

/** The failure of the ticket call as the loop reads it: retry what may pass, stop at what will not. */
function ticketFailure(thrown: unknown, context: ApiErrorContext): ConnectionFailure {
  if (thrown instanceof ApiNetworkError) {
    return new ConnectionFailure({ error: thrown, retryable: thrown.reason !== 'aborted' });
  }
  if (thrown instanceof ApiRequestError) {
    return new ConnectionFailure({
      error: thrown,
      retryable: thrown.status >= 500,
      retryAfterMs:
        thrown.retryAfterSeconds === undefined ? undefined : thrown.retryAfterSeconds * 1000,
    });
  }
  if (thrown instanceof ApiProtocolError) {
    return new ConnectionFailure({ error: thrown, retryable: thrown.status >= 500 });
  }
  if (thrown instanceof ApiClientError) {
    return new ConnectionFailure({ error: thrown, retryable: false });
  }
  return new ConnectionFailure({
    error: new ApiClientError(
      `${context.routeId ?? 'chat'}: the ticket call failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      context,
      { cause: thrown },
    ),
    retryable: false,
  });
}
