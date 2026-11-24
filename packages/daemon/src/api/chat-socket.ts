// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  InvalidInput,
  NotFound,
  isOTheaterError,
  type EventEnvelope,
  type JsonValue,
  type Store,
} from '@otheater/core';
import {
  ChatClientMessageSchema,
  ChatDirectorReplyPayloadSchema,
  ChatAskClosedPayloadSchema,
  ChatAskPayloadSchema,
  CHAT_DROP_REASONS,
  CHAT_ERROR_COMMAND_MAX,
  CHAT_ERROR_SOURCE_SHELL,
  IdeaQueueHeldPayloadSchema,
  ScenarioSystemMessagePayloadSchema,
  ShellCommandFinishedPayloadSchema,
  ShellCommandStartedPayloadSchema,
  apiError,
  apiErrorCodeOf,
  invalidInputDetails,
  type ApiErrorCode,
  type ChatClientMessage,
  type ChatServerMessage,
  type ChatWait,
} from '@otheater/protocol';
import type { WSContext } from 'hono/ws';
import type { WebSocket } from 'ws';
import type { EventHub } from '../events/event-hub.js';
import type { Logger } from '../logger.js';
import type { ProducerChannel } from '../orchestration/channel.js';
import {
  commandOf as shellCommandOf,
  isShellCommand,
  type ShellCommandService,
} from '../shell/service.js';
import type { SituationSink } from '../situations.js';
import type { SlashCommandService } from '../slash/index.js';
import { ChatTickets } from './chat-tickets.js';
import { redactDetails, redactPaths } from './error-paths.js';
import { ApiFailure, type ApiSocketEvents } from './handlers.js';
import { jsonDepthExceeds } from './json-depth.js';
import type { ApiServer } from './server.js';

/**
 * The chat WebSocket of the API (P7 of docs/17): the poll of the Producer channel, pushed, and the
 * messages of the Producer in the single prompt queue. Every message of the daemon carries the id
 * of the event that produced it, so one cursor serves the stream and the chat, and a connection
 * that drops comes back with `resume` and gets what it missed, once.
 */

/** The `details` of an error of the API. */
type Details = Readonly<Record<string, JsonValue>>;

/** What the routes read from `api.chat` (the config; every one has a default there). */
export interface ChatRoutesOptions {
  readonly api: ApiServer;
  readonly channel: ProducerChannel;
  readonly store: Store;
  readonly hub: EventHub;
  readonly situations: SituationSink;
  readonly logger: Logger;
  /** The `!` command of the Producer (N43). Without it a message that starts with `!` is refused. */
  readonly shell?: ShellCommandService | undefined;
  readonly now: () => number;
  /** `api.chat.ticket_ttl`. */
  readonly ticketTtlMs: number;
  /** `api.chat.max_tickets`: tickets that may wait at once. */
  readonly maxTickets: number;
  /** `api.chat.max_sockets`: chat sockets open at once. */
  readonly maxSockets: number;
  /** `api.chat.max_queued_messages`: messages of one socket received and not yet handled. */
  readonly maxQueuedMessages: number;
  /** `api.chat.heartbeat`. */
  readonly heartbeatMs: number;
  /** `api.chat.state_interval`. */
  readonly stateIntervalMs: number;
  /** `api.chat.resume_window`. */
  readonly resumeWindowMs: number;
  /**
   * The registry of the `/` commands (P3 of Phase 7), asked for at each `command` message: the
   * services it reads are built after the chat routes. Absent, or off (`chat.slash_commands`),
   * the line goes to the Director as typed.
   */
  readonly commands?: (() => SlashCommandService | undefined) | undefined;
}

/** The types of event the chat turns into messages. The filter of the hub takes them as prefixes. */
const FEED_TYPES = [
  'chat.director_reply',
  'chat.ask',
  'chat.ask_closed',
  'scenario.system_message',
  'idea.queue_held',
  'play.transitioned',
  'chat.shell_command',
] as const;

/** Events read per page when a resume looks for the questions the replay will bring. */
const ASK_SCAN_PAGE = 500;

/**
 * What a `history` counts: the events that make an entry of the chat of the Producer (a reply, a
 * notice, a stop of the queue, a play, a `!` command). The questions are not counted: they are
 * cards, and the replay brings the ones that still wait anyway.
 */
const HISTORY_TYPES: ReadonlySet<string> = new Set([
  'chat.director_reply',
  'scenario.system_message',
  'idea.queue_held',
  'play.transitioned',
  'chat.shell_command.started',
]);
/** How many ids of the log a `history` looks at in one window, going back from the head. */
const HISTORY_WINDOW = 2000;
/** How far back (in ids of the log) a `history` looks at most. [proposta] */
const HISTORY_SCAN_MAX = 200_000;

/** Close codes that say the client broke the protocol (RFC 6455): protocol, data, size. */
const PROTOCOL_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1009]);

/** What a refusal of the socket says to the client. */
const CLOSE = {
  stop: { code: 1001, reason: 'The daemon is stopping' },
  rotated: { code: 1008, reason: 'The API token was rotated' },
  overflow: { code: 1008, reason: 'Too many messages are waiting to be handled' },
  feed: { code: 1011, reason: 'The daemon could not read the events' },
} as const;

/**
 * Registers `createChatTicket` and `openChatSocket`. Returns the tickets, for the tests that need
 * to look at them.
 */
export function registerChatRoutes(options: ChatRoutesOptions): ChatTickets {
  const { api, store } = options;
  const tickets = new ChatTickets({
    ttlMs: options.ticketTtlMs,
    now: options.now,
    maxTickets: options.maxTickets,
    epoch: () => api.tokenEpoch,
  });
  // A rotation revokes what the old token vouched for: the tickets it issued go with it. The sockets
  // already open close themselves (each session listens too).
  api.onTokenRotated(() => {
    tickets.clear();
  });
  api.handlers.register('createChatTicket', async ({ body, tokenEpoch }) => {
    if ((await store.scenarios.get(body.scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${body.scenarioId}"`);
    }
    // The token that asked is checked again here, after the await: a rotation in between is a 401.
    return tickets.issue(body.scenarioId, tokenEpoch);
  });
  api.handlers.register(
    'openChatSocket',
    async ({ params, query, request, upgrade }) => {
      if (upgrade === undefined || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        throw new ApiFailure('invalid_input', 'This route opens a WebSocket');
      }
      // [proposta] A ceiling on the sockets: `ws` counts the ones that are open; the ones in the
      // middle of the upgrade are bounded by `api.chat.max_tickets` (each needs a ticket).
      if (api.openSockets.size >= options.maxSockets) {
        throw new ApiFailure('unavailable', 'Too many chat sockets are open', {
          details: { maxSockets: options.maxSockets },
          headers: { 'retry-after': '1' },
        });
      }
      // One try: the ticket is spent whatever happens next. `redeem` only says yes to a ticket that
      // was asked for with the token that is current, and the epoch read here is that token's.
      if (!tickets.redeem(query.ticket, params.id)) return api.rejectTicket(request);
      const epoch = api.tokenEpoch;
      if ((await store.scenarios.get(params.id)) === undefined) {
        throw new NotFound(`There is no scenario "${params.id}"`);
      }
      // A rotation during the await above: the ticket vouched for a token that is gone.
      if (api.tokenEpoch !== epoch) return api.rejectTicket(request);
      return upgrade(new ChatSession(options, params.id, epoch).events());
    },
    // A socket is opened with a ticket that a command already waited the gate for.
    { command: false },
  );
  return tickets;
}

/** One open chat socket. */
class ChatSession {
  readonly #options: ChatRoutesOptions;
  readonly #scenarioId: string;
  readonly #stop = new AbortController();
  readonly #asksSent = new Set<string>();
  /** The epoch of the token this socket was opened under (`ApiServer.tokenEpoch`). */
  readonly #epoch: number;
  #ws: WSContext<WebSocket> | undefined;
  #raw: WebSocket | undefined;
  #release: (() => void) | undefined;
  #timers: NodeJS.Timeout[] = [];
  #unsubscribe: (() => void) | undefined;
  #onStop: (() => void) | undefined;
  #resumeTimer: NodeJS.Timeout | undefined;
  /** The inbox: messages of the client are handled one at a time, in order. */
  #inbox: Promise<void> = Promise.resolve();
  /** Messages received and not yet handled, against `api.chat.max_queued_messages`. */
  #queued = 0;
  /** The feed and the state go out in order, one step at a time. */
  #outbox: Promise<void> = Promise.resolve();
  #started = false;
  /** The feed began because the resume window ended, with no word from the client (P26). */
  #startedByWindow = false;
  #closed = false;
  #reason:
    'daemon_stop' | 'token_rotated' | 'no_pong' | 'feed_failed' | 'protocol_error' | undefined;
  #ponged = true;
  /** The id of the last event of the feed this connection went through (the cursor of its messages). */
  #cursor = 0;
  /** The head of the log when the feed started: an ask of an event after it is live. */
  #head = 0;
  #waitsSent: string | undefined;
  #busySent: boolean | undefined;

  constructor(options: ChatRoutesOptions, scenarioId: string, epoch: number) {
    this.#options = options;
    this.#scenarioId = scenarioId;
    this.#epoch = epoch;
  }

  events(): ApiSocketEvents {
    return {
      onOpen: (_event, ws) => {
        this.#open(ws);
      },
      onMessage: (event) => {
        const data: unknown = event.data;
        // A client that sends faster than the daemon handles does not grow the queue without end.
        if (this.#queued >= this.#options.maxQueuedMessages) {
          if (!this.#closed && this.#reason === undefined) {
            this.#reason = 'protocol_error';
            this.#options.api.recordMessageRejected();
            this.#end(CLOSE.overflow);
          }
          return;
        }
        this.#queued += 1;
        const done = (): void => {
          this.#queued -= 1;
        };
        this.#inbox = this.#inbox.then(() => this.#receive(data)).then(done, done);
      },
      onClose: (event) => {
        this.#closedBy(event.code);
      },
      onError: (event) => {
        this.#options.logger.warn(
          { err: (event as { error?: unknown }).error, scenarioId: this.#scenarioId },
          'a chat socket failed',
        );
      },
    };
  }

  // ---- life of the socket ----

  #open(ws: WSContext<WebSocket>): void {
    const { api, channel, heartbeatMs, resumeWindowMs } = this.#options;
    this.#ws = ws;
    this.#raw = ws.raw;
    // An open socket counts as somebody watching the scenario (N89).
    this.#release = channel.watch(this.#scenarioId);
    this.#raw?.on('pong', () => {
      this.#ponged = true;
    });
    const beat = setInterval(() => {
      if (!this.#ponged) {
        this.#reason = 'no_pong';
        this.#raw?.terminate();
        return;
      }
      this.#ponged = false;
      try {
        this.#raw?.ping();
      } catch (error) {
        this.#options.logger.warn({ err: error }, 'a chat ping failed');
      }
    }, heartbeatMs);
    beat.unref();
    this.#timers.push(beat);
    this.#unsubscribe = api.onTokenRotated(() => {
      this.#reason = 'token_rotated';
      this.#end(CLOSE.rotated);
    });
    // The token may have been rotated between the ticket and this open: the listener above would
    // never hear of it, so the epoch says it.
    if (api.tokenEpoch !== this.#epoch) {
      this.#reason = 'token_rotated';
      this.#end(CLOSE.rotated);
    }
    const stop = (): void => {
      this.#reason = 'daemon_stop';
      this.#end(CLOSE.stop);
    };
    if (api.stopSignal.aborted) stop();
    else {
      api.stopSignal.addEventListener('abort', stop, { once: true });
      this.#onStop = () => {
        api.stopSignal.removeEventListener('abort', stop);
      };
    }
    // A client with a cursor says `resume` first; one with none says nothing, and this is its wait.
    this.#resumeTimer = setTimeout(() => {
      this.#inbox = this.#inbox.then(() => {
        if (!this.#started) this.#startedByWindow = true;
        return this.#start(undefined);
      });
    }, resumeWindowMs);
    this.#resumeTimer.unref();
  }

  #end(close: { readonly code: number; readonly reason: string }): void {
    try {
      this.#ws?.close(close.code, close.reason);
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'a chat socket could not be closed');
    }
  }

  #closedBy(code: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop.abort();
    clearTimeout(this.#resumeTimer);
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.#unsubscribe?.();
    this.#onStop?.();
    this.#release?.();
    const reason =
      this.#reason ?? (PROTOCOL_CLOSE_CODES.has(code) ? 'protocol_error' : 'client_closed');
    // A message too big for the socket ends it before the route sees it: that is a refusal too.
    if (code === 1009) this.#options.api.recordMessageRejected();
    this.#options.situations.record(
      'api.chat_closed',
      { reason, code: code >= 1000 && code <= 4999 ? code : null },
      { scenarioId: this.#scenarioId },
    );
  }

  // ---- what the client says ----

  async #receive(data: unknown): Promise<void> {
    if (this.#closed) return;
    try {
      const message = this.#parse(data);
      if (message === undefined) return;
      if (message.type === 'resume') {
        if (this.#started) {
          this.#refuse('invalid_input', 'resume is only taken as the first message');
          return;
        }
        await this.#start(message.lastEventId);
        return;
      }
      if (message.type === 'history') {
        if (this.#started) {
          // A `history` that lost the race with the window (a busy machine) is a chat that opens
          // without history, not a mistake of the client: the feed is live, so it is counted and
          // nothing else. After a message of the client it is a refusal, as `resume` is.
          if (this.#startedByWindow) this.#options.api.recordMessageRejected();
          else this.#refuse('invalid_input', 'history is only taken as the first message');
          return;
        }
        await this.#start(await this.#historyStart(message.count));
        return;
      }
      // Whoever speaks before the window ends has no cursor: the feed starts now, before the
      // message goes in, so what the message makes the daemon say is not missed.
      await this.#start(undefined);
      this.#startedByWindow = false;
      await this.#handle(message);
    } catch (error) {
      this.#fail(error);
    }
  }

  #parse(data: unknown): ChatClientMessage | undefined {
    if (typeof data !== 'string') {
      this.#refuse('invalid_input', 'The chat takes text frames only');
      return undefined;
    }
    const maxDepth = this.#options.api.maxJsonDepth;
    if (jsonDepthExceeds(data, maxDepth)) {
      this.#refuse('invalid_input', 'The message is nested too deep', {
        details: { reason: 'json_too_deep', maxDepth },
      });
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.#refuse('invalid_input', 'The message is not JSON');
      return undefined;
    }
    const parsed = ChatClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.#refuse('invalid_input', 'The message does not fit the chat contract', {
        details: invalidInputDetails(parsed.error),
      });
      return undefined;
    }
    return parsed.data;
  }

  async #handle(
    message: Exclude<ChatClientMessage, { type: 'resume' | 'history' }>,
  ): Promise<void> {
    const { channel } = this.#options;
    switch (message.type) {
      case 'message':
        // N43: a message that starts with `!` is a command for the worktree, not a message for the
        // Director; its end comes back as events (`shell_started`, `shell_finished`).
        if (isShellCommand(message.text)) {
          await this.#shell(message.text, message.attachments ?? [], message.clientId);
          return;
        }
        // The single prompt queue, with the Producer's source: `prompt.queued` is the record.
        await channel.send(this.#scenarioId, message.text, message.attachments ?? []);
        return;
      case 'command': {
        // [proposta] The registry answers with a `command_result`; without it (or with the commands
        // off) the line goes to the Director as typed, like a message.
        const slash = this.#options.commands?.();
        if (!slash?.enabled()) {
          await channel.send(this.#scenarioId, message.text);
          return;
        }
        const result = await slash.execute(this.#scenarioId, {
          text: message.text,
          confirm: message.confirm,
        });
        this.#send({ type: 'command_result', eventId: null, result });
        return;
      }
      case 'answer':
        await channel.answer(message.decisionId, message.answer);
        return;
    }
  }

  async #shell(
    text: string,
    attachments: readonly string[],
    clientId: string | undefined,
  ): Promise<void> {
    const { shell } = this.#options;
    try {
      if (attachments.length > 0) {
        throw new InvalidInput('A ! command takes no attachments');
      }
      if (shell === undefined) {
        throw new AdapterUnavailable('The ! command is not available in this daemon');
      }
      await shell.start(this.#scenarioId, text);
    } catch (error) {
      // N205: the refusal of a `!` line says it is one, and which (the answers of several lines in
      // flight may come in any order).
      this.#fail(error, {
        source: CHAT_ERROR_SOURCE_SHELL,
        command: shellCommandOf(text).slice(0, CHAT_ERROR_COMMAND_MAX),
        ...(clientId === undefined ? {} : { clientId }),
      });
    }
  }

  #fail(error: unknown, origin: Details = {}): void {
    const code = apiErrorCodeOf(error);
    if (code === 'internal') {
      this.#options.logger.error(
        { err: error, scenarioId: this.#scenarioId },
        'a chat message failed',
      );
    }
    this.#sendError(
      code,
      code !== 'internal' && isOTheaterError(error)
        ? error.message
        : 'The daemon failed this message',
      Object.keys(origin).length === 0 ? undefined : origin,
    );
  }

  /** A message of the client the daemon refused: the same record as any other refusal. */
  #refuse(code: ApiErrorCode, message: string, extra: { readonly details?: Details } = {}): void {
    this.#options.api.recordMessageRejected();
    this.#sendError(code, message, extra.details);
  }

  #sendError(code: ApiErrorCode, message: string, details?: Details): void {
    // No absolute path of the machine goes to the client (the log has the whole text).
    this.#send({
      type: 'error',
      eventId: null,
      error: apiError(code, redactPaths(message), redactDetails(details)).error,
    });
  }

  #send(message: ChatServerMessage): void {
    const ws = this.#ws;
    if (this.#closed || ws?.readyState !== 1) return;
    ws.send(JSON.stringify(message));
  }

  // ---- what the daemon says ----

  /**
   * Starts the feed. `afterId` is the cursor of a `resume`; without it the feed is live from the
   * head of the log, and what is pending now comes first (the asks, then the state). Only the first
   * call does anything.
   */
  async #start(afterId: number | undefined): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    clearTimeout(this.#resumeTimer);
    const { store, channel, stateIntervalMs } = this.#options;
    const head = await store.events.lastId();
    this.#head = head;
    let from = head;
    if (afterId !== undefined) {
      if (afterId > head) {
        // A cursor from another log (the data of the daemon was reset): nothing to resend.
        this.#refuse('invalid_input', 'lastEventId is ahead of the log; the chat starts from now', {
          details: { lastEventId: afterId, lastId: head },
        });
      } else {
        from = afterId;
      }
    }
    this.#cursor = from;
    // What waits for the Producer now is told as the first thing, from the state of the store and
    // not only from the log (N179, item 3): a decision made before `chat.ask` existed, or whose
    // event was not written, has no event to replay. [proposta] The frame carries the cursor the
    // feed starts from (the head of the log on a fresh socket, the cursor of a resume), never an id
    // the client has not got the events of.
    const replayed =
      afterId !== undefined && afterId <= head
        ? await this.#askedBetween(afterId, head)
        : new Set<string>();
    const state = await channel.state(this.#scenarioId);
    for (const ask of state.asks) {
      // The replay brings this one with its own event, in its place among the other messages.
      if (replayed.has(ask.id)) continue;
      this.#asksSent.add(ask.id);
      this.#send({
        type: 'ask',
        eventId: Math.max(1, from),
        decisionId: ask.id,
        kind: ask.kind,
        playId: ask.playId,
        input: ask.input,
      });
    }
    await this.#pushState(true);
    void this.#follow(from);
    const timer = setInterval(() => {
      void this.#step(undefined, () => this.#pushState(false));
    }, stateIntervalMs);
    timer.unref();
    this.#timers.push(timer);
  }

  /**
   * The cursor a `history` of `count` starts the feed from: the id before the oldest of the last
   * `count` events of this scenario that the chat shows. `undefined` when there is none (or `count`
   * is 0): the feed is then live. The log has no read by scenario, so it is read backwards in
   * windows of ids and stops when it has enough or has gone {@link HISTORY_SCAN_MAX} ids back.
   */
  async #historyStart(count: number): Promise<number | undefined> {
    if (count <= 0) return undefined;
    const { store } = this.#options;
    const head = await store.events.lastId();
    let oldest: number | undefined;
    let found = 0;
    let upTo = head;
    while (upTo > 0 && found < count && head - upTo < HISTORY_SCAN_MAX) {
      const after = Math.max(0, upTo - HISTORY_WINDOW);
      const ids = await this.#shownBetween(after, upTo);
      for (let at = ids.length - 1; at >= 0 && found < count; at -= 1) {
        oldest = ids[at];
        found += 1;
      }
      upTo = after;
    }
    return oldest === undefined ? undefined : oldest - 1;
  }

  /** The ids, ascending, of the events of this scenario that a `history` counts, with `after < id <= upTo`. */
  async #shownBetween(after: number, upTo: number): Promise<number[]> {
    const { store } = this.#options;
    const ids: number[] = [];
    let cursor = after;
    while (cursor < upTo) {
      const page = await store.events.readFrom(cursor, ASK_SCAN_PAGE);
      if (page.length === 0) break;
      for (const event of page) {
        if (event.id > upTo) return ids;
        cursor = event.id;
        if (event.scenarioId === this.#scenarioId && HISTORY_TYPES.has(event.type)) {
          ids.push(event.id);
        }
      }
    }
    return ids;
  }

  /** The decisions of this scenario that a `chat.ask` of the ids `after < id <= upTo` announces. */
  async #askedBetween(after: number, upTo: number): Promise<Set<string>> {
    const { store } = this.#options;
    const asked = new Set<string>();
    let cursor = after;
    while (cursor < upTo) {
      const page = await store.events.readFrom(cursor, ASK_SCAN_PAGE);
      if (page.length === 0) break;
      for (const event of page) {
        if (event.id > upTo) return asked;
        cursor = event.id;
        if (event.type !== 'chat.ask' || event.scenarioId !== this.#scenarioId) continue;
        const payload = ChatAskPayloadSchema.safeParse(event.payload);
        if (payload.success) asked.add(payload.data.decisionId);
      }
    }
    return asked;
  }

  async #follow(afterId: number): Promise<void> {
    const { hub } = this.#options;
    try {
      for await (const event of hub.follow({
        afterId,
        filter: { scenarioIds: [this.#scenarioId], typePrefixes: FEED_TYPES },
        signal: this.#stop.signal,
      })) {
        await this.#step(event, async () => {
          await this.#deliver(event);
          this.#cursor = event.id;
          await this.#pushState(false);
        });
      }
    } catch (error) {
      if (this.#closed || this.#stop.signal.aborted) return;
      this.#options.logger.error(
        { err: error, scenarioId: this.#scenarioId },
        'the chat feed failed',
      );
      this.#reason = 'feed_failed';
      this.#end(CLOSE.feed);
    }
  }

  /** Runs `work` after the one before it, so the messages go out in the order of the events. */
  #step(event: EventEnvelope | undefined, work: () => Promise<void>): Promise<void> {
    const next = this.#outbox.then(async () => {
      if (this.#closed) return;
      try {
        await work();
      } catch (error) {
        this.#options.logger.warn(
          { err: error, scenarioId: this.#scenarioId },
          'a chat message could not be prepared',
        );
        this.#dropped('prepare_failed', event);
      }
    });
    this.#outbox = next;
    return next;
  }

  async #deliver(event: EventEnvelope): Promise<void> {
    const eventId = event.id;
    switch (event.type) {
      case 'chat.director_reply': {
        const payload = ChatDirectorReplyPayloadSchema.safeParse(event.payload);
        if (!payload.success) {
          this.#skipped(event);
          return;
        }
        this.#send({
          type: 'director_reply',
          eventId,
          replyId: payload.data.replyId,
          text: payload.data.text,
          // The Director's reply is kept whole today; parts are for a later step.
          final: true,
          // N183: the marks of a reply the daemon generated for a silent turn.
          ...(payload.data.generated === undefined
            ? {}
            : {
                generated: true as const,
                ...(payload.data.tools === undefined ? {} : { tools: payload.data.tools }),
                ...(payload.data.playId === undefined ? {} : { playId: payload.data.playId }),
              }),
        });
        return;
      }
      case 'chat.ask': {
        const payload = ChatAskPayloadSchema.safeParse(event.payload);
        if (!payload.success) {
          this.#skipped(event);
          return;
        }
        const { decisionId } = payload.data;
        // Once per connection: the first state of a fresh socket may already have told it.
        if (this.#asksSent.has(decisionId)) return;
        // An ask that was answered (or cancelled) since is not one any more.
        const ask = await this.#options.channel.pendingAsk(this.#scenarioId, decisionId, {
          live: event.id > this.#head,
        });
        if (ask === undefined) return;
        this.#asksSent.add(decisionId);
        this.#send({
          type: 'ask',
          eventId,
          decisionId,
          kind: ask.kind,
          playId: ask.playId,
          input: ask.input,
        });
        return;
      }
      case 'chat.ask_closed': {
        const payload = ChatAskClosedPayloadSchema.safeParse(event.payload);
        if (!payload.success) {
          this.#skipped(event);
          return;
        }
        // Sent even to a connection that never showed the ask: its client may have it from an
        // earlier connection, and the message of a question it does not know is harmless.
        this.#send({
          type: 'ask_closed',
          eventId,
          decisionId: payload.data.decisionId,
          state: payload.data.state,
        });
        return;
      }
      case 'scenario.system_message': {
        const payload = ScenarioSystemMessagePayloadSchema.safeParse(event.payload);
        if (!payload.success) {
          this.#skipped(event);
          return;
        }
        this.#send({ type: 'system', eventId, message: payload.data });
        return;
      }
      case 'chat.shell_command.started': {
        const payload = ShellCommandStartedPayloadSchema.safeParse(event.payload);
        if (!payload.success) {
          this.#skipped(event);
          return;
        }
        this.#send({ type: 'shell_started', eventId, command: payload.data });
        return;
      }
      case 'chat.shell_command.finished': {
        const payload = ShellCommandFinishedPayloadSchema.safeParse(event.payload);
        if (!payload.success) {
          this.#skipped(event);
          return;
        }
        // The event carries no output: the snippet is read from its attachment.
        const snippet =
          this.#options.shell === undefined
            ? ''
            : await this.#options.shell.snippetOf(this.#scenarioId, payload.data.attachmentId);
        this.#send({ type: 'shell_finished', eventId, result: payload.data, snippet });
        return;
      }
      case 'idea.queue_held': {
        const payload = IdeaQueueHeldPayloadSchema.safeParse(event.payload);
        if (!payload.success) {
          this.#skipped(event);
          return;
        }
        this.#send({ type: 'queue_held', eventId, held: payload.data });
        return;
      }
      case 'play.transitioned': {
        const to = (event.payload as { to?: unknown } | null)?.to;
        if (event.playId === undefined || typeof to !== 'string') {
          this.#skipped(event);
          return;
        }
        this.#send({ type: 'play_state', eventId, playId: event.playId, state: to });
        return;
      }
      default:
        return;
    }
  }

  #skipped(event: EventEnvelope): void {
    this.#options.logger.warn(
      { type: event.type, eventId: event.id, scenarioId: this.#scenarioId },
      'an event does not fit its chat message; it was not sent',
    );
    this.#dropped('unfit', event);
  }

  /** A message that was not sent is a situation, not only a line of the log. */
  #dropped(reason: (typeof CHAT_DROP_REASONS)[number], event: EventEnvelope | undefined): void {
    this.#options.situations.record(
      'api.chat_message_dropped',
      { reason, eventId: event?.id ?? null, eventType: event?.type ?? null },
      { scenarioId: this.#scenarioId },
    );
  }

  /**
   * `waits` and `busy` are the state of the moment, not events: they come from the scenario, are
   * sent when they change (and once when the feed starts) and carry the cursor of the feed, so a
   * client never takes from them an id it has not got the events of.
   */
  async #pushState(force: boolean): Promise<void> {
    const state = await this.#options.channel.state(this.#scenarioId);
    const eventId = Math.max(1, this.#cursor);
    const waits: ChatWait[] = state.waits.map((wait) => ({
      role: wait.role,
      playId: wait.playId,
      demandId: wait.demandId,
      on: wait.on.map((item) => ({ profile: item.profile, reason: item.reason })),
      until: wait.until,
    }));
    const key = JSON.stringify(waits);
    if (force || key !== this.#waitsSent) {
      this.#waitsSent = key;
      this.#send({ type: 'waits', eventId, waits });
    }
    if (force || state.busy !== this.#busySent) {
      this.#busySent = state.busy;
      this.#send({ type: 'busy', eventId, busy: state.busy });
    }
  }
}
