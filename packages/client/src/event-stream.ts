// SPDX-License-Identifier: MPL-2.0
import {
  ApiErrorSchema,
  ApiSseMessageSchema,
  LAST_EVENT_ID_HEADER,
  SSE_CONTENT_TYPE,
  invalidInputDetails,
  streamEvents,
  type ApiSseMessage,
  type DaemonId,
  type EventStreamQuery,
} from '@otheater/protocol';
import {
  ConnectionFailure,
  Listeners,
  ReconnectingConnection,
  type ReconnectOptions,
} from './connection.js';
import {
  ApiInputError,
  ApiNetworkError,
  ApiProtocolError,
  ApiRequestError,
  type ApiClientError,
  type ApiErrorContext,
} from './errors.js';
import { networkDetail, parseJsonText, retryAfterSeconds, type FetchLike } from './http.js';
import { SseParser, readSseText, type SseEvent } from './sse-parser.js';

/**
 * Client of `GET /v1/events` (plan docs/17 P10): a reader of Server-Sent Events of our own over
 * `fetch` with a streamed body, because `EventSource` cannot send `Authorization` (N164: no
 * library either). It keeps one cursor, the id of the last event it has, and reconnects with it in
 * `Last-Event-ID` so the daemon sends what is missing, no more and no less. It runs in Node 24
 * and in a browser.
 */

/** The daemon the stream talks to. The token stays here and goes only in `Authorization`. */
export interface EventStreamTarget {
  /** Base URL of the daemon, as the {@link ApiClient} has it. */
  readonly url: string;
  readonly token: string;
  readonly daemonId?: DaemonId | undefined;
  readonly fetch?: FetchLike | undefined;
}

export interface EventStreamOptions extends ReconnectOptions {
  /** Only the events of these scenarios. Default: all of them. */
  readonly scenario?: string | readonly string[] | undefined;
  /** Only the events whose type starts with one of these prefixes (`play.`, `quota.`). Default: all. */
  readonly types?: string | readonly string[] | undefined;
  /**
   * The id of the last event the caller already has (the first request sends it as `since`).
   * Without it the stream starts at the newest event, with no history.
   */
  readonly since?: number | undefined;
  /**
   * What to do with a message outside the contract. `fail` (default) closes the stream with an
   * {@link ApiProtocolError}; `skip` drops the message, tells {@link EventStream.onInvalid} and goes on.
   * [proposta]
   */
  readonly invalidMessages?: 'fail' | 'skip' | undefined;
  /**
   * Drop a message whose id is not above the last one delivered (a daemon that sends again what
   * the cursor already covers). Default `true`. [proposta]
   */
  readonly dropRepeated?: boolean | undefined;
}

const NUMERIC_ID = /^(0|[1-9][0-9]*)$/;

export class EventStream extends ReconnectingConnection {
  readonly #target: EventStreamTarget;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #query: EventStreamQuery;
  readonly #since: number | undefined;
  readonly #invalidMessages: 'fail' | 'skip';
  readonly #dropRepeated: boolean;
  readonly #messages = new Listeners<[ApiSseMessage]>();
  readonly #invalid = new Listeners<[ApiClientError]>();
  readonly #cursors = new Listeners<[number]>();
  /** The cursor: the id of the last event the stream has, sent as `Last-Event-ID`. */
  #cursor: number | undefined;
  /** Whether the stream has moved the cursor itself (after that, `since` is not used again). */
  #moved = false;
  /** Highest id delivered to the listeners. */
  #delivered: number;

  constructor(target: EventStreamTarget, options: EventStreamOptions = {}) {
    const base = target.url.replace(/\/+$/, '');
    super(
      { origin: new URL(base).origin, daemonId: target.daemonId, routeId: streamEvents.id },
      options,
    );
    this.#target = target;
    this.#base = base;
    this.#fetch = target.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#since = options.since;
    this.#cursor = options.since;
    this.#delivered = options.since ?? 0;
    this.#invalidMessages = options.invalidMessages ?? 'fail';
    this.#dropRepeated = options.dropRepeated ?? true;
    const query: EventStreamQuery = {
      ...(options.scenario === undefined ? {} : { scenario: listOf(options.scenario) }),
      ...(options.types === undefined ? {} : { types: listOf(options.types) }),
      ...(options.since === undefined ? {} : { since: options.since }),
    };
    const parsed = streamEvents.query.safeParse(query);
    if (!parsed.success) {
      throw new ApiInputError(
        { part: 'query', issues: invalidInputDetails(parsed.error).issues },
        { daemonId: target.daemonId, routeId: streamEvents.id },
      );
    }
    this.#query = query;
  }

  /** The id of the last event the stream has (the cursor), or `undefined` before the first. */
  get lastEventId(): number | undefined {
    return this.#cursor;
  }

  /** Watches the messages, in order, each one once. Returns the function that stops watching. */
  onMessage(listener: (message: ApiSseMessage) => void): () => void {
    return this.#messages.add(listener);
  }

  /** Watches the messages dropped under `invalidMessages: 'skip'`. */
  onInvalid(listener: (error: ApiClientError) => void): () => void {
    return this.#invalid.add(listener);
  }

  /**
   * Watches the cursor: called with the last `id:` of a chunk of the stream each time it moves,
   * before the messages that came in the same chunk (so a chunk with several events reports the
   * id of the last one once). A daemon sends the id of its newest event as the first
   * frame of a stream that has no cursor (`0` when the log is empty), so this is how a reader
   * learns the head of the log at the moment the stream opened (the stores of P11 start from
   * it). Returns the function that stops watching. [proposta]
   */
  onCursor(listener: (id: number) => void): () => void {
    return this.#cursors.add(listener);
  }

  protected override onClosed(): void {
    this.#messages.clear();
    this.#invalid.clear();
    this.#cursors.clear();
  }

  protected override async connectOnce(signal: AbortSignal, opened: () => void): Promise<void> {
    const context: ApiErrorContext = this.#context();
    const response = await this.#request(signal, context);
    if (response === undefined) return;
    await this.#checkResponse(response, context);
    const body = response.body;
    if (body === null) {
      throw new ConnectionFailure({
        error: new ApiProtocolError({ reason: 'invalid_stream', status: response.status }, context),
        retryable: false,
      });
    }
    opened();

    const parser = new SseParser();
    try {
      for await (const text of readSseText(body)) {
        const items = parser.write(text);
        this.#followCursor(parser.lastEventId);
        for (const item of items) {
          if (item.kind === 'retry') this.setServerRetry(item.ms);
          else if (item.kind === 'event') this.#receive(item, response.status, context);
        }
      }
    } catch (thrown) {
      if (thrown instanceof ConnectionFailure || signal.aborted) throw thrown;
      throw new ConnectionFailure({
        error: new ApiNetworkError(
          { reason: 'connection', origin: new URL(this.#base).origin, ...networkDetail(thrown) },
          context,
          { cause: thrown },
        ),
        retryable: true,
      });
    }
  }

  #context(): ApiErrorContext {
    return { daemonId: this.#target.daemonId, routeId: streamEvents.id };
  }

  /** Sends the request. `undefined` means the stream was closed while it was in flight. */
  async #request(signal: AbortSignal, context: ApiErrorContext): Promise<Response | undefined> {
    const url = new URL(`${this.#base}${streamEvents.path}`);
    const query = { ...this.#query };
    // The first request carries `since`; once the stream has a cursor of its own, the header does.
    const useSince = !this.#moved && this.#since !== undefined;
    if (!useSince) delete query.since;
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
        url.searchParams.append(key, String(item));
      }
    }
    const headers = new Headers({
      accept: SSE_CONTENT_TYPE,
      'cache-control': 'no-cache',
      authorization: `Bearer ${this.#target.token}`,
    });
    if (!useSince && this.#cursor !== undefined) {
      headers.set(LAST_EVENT_ID_HEADER, String(this.#cursor));
    }
    try {
      return await this.#fetch(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal,
      });
    } catch (cause) {
      if (signal.aborted) return undefined;
      throw new ConnectionFailure({
        error: new ApiNetworkError(
          { reason: 'connection', origin: url.origin, ...networkDetail(cause) },
          context,
          { cause },
        ),
        retryable: true,
      });
    }
  }

  /** A success that is a stream passes; anything else is a failure, retryable only for 5xx. */
  async #checkResponse(response: Response, context: ApiErrorContext): Promise<void> {
    const status = response.status;
    if (response.ok) {
      const type = response.headers.get('content-type') ?? '';
      if (!type.toLowerCase().includes(SSE_CONTENT_TYPE)) {
        throw new ConnectionFailure({
          error: new ApiProtocolError({ reason: 'invalid_stream', status }, context),
          retryable: false,
        });
      }
      return;
    }
    // 401, 403, 404 and every other 4xx will not change by asking again; a 5xx may.
    const retryable = status >= 500;
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
    const text = await response.text().catch(() => '');
    const json = parseJsonText(text);
    const error = json.ok ? ApiErrorSchema.safeParse(json.value) : undefined;
    throw new ConnectionFailure({
      error:
        error?.success === true
          ? new ApiRequestError(
              { status, body: error.data.error, retryAfterSeconds: retryAfter },
              context,
            )
          : new ApiProtocolError({ reason: 'invalid_error_body', status }, context),
      retryable,
      retryAfterMs: retryAfter === undefined ? undefined : retryAfter * 1000,
    });
  }

  /**
   * The last event id of the stream, as the specification keeps it, moves the cursor. It moves
   * also for an `id:` with no data (a server may send the newest id as the first frame, so a
   * stream that falls before any event still resumes from there); an empty one clears it.
   */
  #followCursor(lastEventId: string): void {
    if (lastEventId === '') {
      if (this.#cursor !== undefined && this.#moved) this.#cursor = undefined;
      return;
    }
    if (!NUMERIC_ID.test(lastEventId)) return;
    const id = Number(lastEventId);
    if (id === this.#cursor) return;
    this.#cursor = id;
    this.#moved = true;
    this.#cursors.emit(id);
  }

  #receive(item: SseEvent, status: number, context: ApiErrorContext): void {
    let data: unknown;
    try {
      data = JSON.parse(item.data) as unknown;
    } catch {
      this.#reject(new ApiProtocolError({ reason: 'invalid_json', status }, context));
      return;
    }
    const parsed = ApiSseMessageSchema.safeParse({ id: item.id, event: item.event, data });
    if (!parsed.success) {
      this.#reject(
        new ApiProtocolError(
          { reason: 'invalid_response', status, issues: invalidInputDetails(parsed.error).issues },
          context,
        ),
      );
      return;
    }
    const message = parsed.data;
    if (this.#dropRepeated && message.data.id <= this.#delivered) return;
    this.#delivered = Math.max(this.#delivered, message.data.id);
    this.#messages.emit(message);
  }

  /** A message outside the contract: closes the stream or drops the message, as asked. */
  #reject(error: ApiProtocolError): void {
    if (this.#invalidMessages === 'skip') {
      this.#invalid.emit(error);
      return;
    }
    throw new ConnectionFailure({ error, retryable: false });
  }
}

function listOf(value: string | readonly string[]): string[] {
  return typeof value === 'string' ? [value] : [...value];
}
