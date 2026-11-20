// SPDX-License-Identifier: MPL-2.0
import type { Clock, EventEnvelope } from '@otheater/core';
import {
  SSE_CONTENT_TYPE,
  queryList,
  sseMessageOf,
  type ApiStreamLagReason,
  type DaemonId,
} from '@otheater/protocol';
import type { DaemonConfig } from '../../config.js';
import type { EventHub } from '../../events/event-hub.js';
import type { Logger } from '../../logger.js';
import type { SituationSink } from '../../situations.js';
import { ApiFailure, type ApiHandlers } from '../handlers.js';

/**
 * `GET /v1/events` (architecture 5.12, P4 of docs/17): the event log as Server-Sent Events.
 *
 * The stream is one loop over `EventHub.follow`: the history after the cursor and the live events
 * are the same read of the log, so there is no switch between them to get wrong. A client that
 * reconnects sends `Last-Event-ID` (or `since`) and gets every later event exactly once.
 *
 * [proposta] The stream is written straight to a `ReadableStream` instead of the `streamSSE` of
 * Hono: a handler of the API receives the parsed request and not a Hono `Context`, which
 * `streamSSE` needs, and the frame is three lines of text. The stream also owns two things
 * `streamSSE` does not give: a queue that stops at a bound (back-pressure, below) and a heartbeat on
 * the injectable clock.
 */

/** The frame of one stored event: `id` is the id of the log, `event` the type, `data` the envelope. */
export function eventFrame(envelope: EventEnvelope, daemonId: DaemonId): string {
  const message = sseMessageOf(envelope, daemonId);
  return `id: ${message.id}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

/** A frame with an `id` and nothing else: it moves the cursor of the client and fires no event. */
export function cursorFrame(id: number): string {
  return `id: ${String(id)}\n\n`;
}

/** `retry:` frame: the reconnection delay the client waits. */
export function retryFrame(ms: number): string {
  return `retry: ${String(ms)}\n\n`;
}

/** A comment line: a client ignores it, and a proxy sees traffic. */
export const HEARTBEAT_FRAME = ': heartbeat\n\n';

/** Frames the stream holds for a client that does not read. Past it the writer waits. [proposta] */
const OUTGOING_FRAMES = 16;

export type EventStreamsConfig = DaemonConfig['api']['sse'];

export interface EventRouteDeps {
  readonly handlers: ApiHandlers;
  /** `api.onTokenRotated`: closes the open streams, which were opened with the old token. */
  readonly onTokenRotated: (listener: () => void) => () => void;
  readonly daemonId: DaemonId;
  readonly hub: EventHub;
  /** The id of the newest event of the log (`EventLog.lastId`). */
  readonly lastId: () => Promise<number>;
  /** The injectable clock of the daemon: the heartbeat sleeps on it, so a test drives it. */
  readonly clock: Clock;
  readonly config: EventStreamsConfig;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
  /** Where `api.stream_lagged` goes. Default: nowhere. */
  readonly situations?: SituationSink;
}

export interface EventStreams {
  /** Streams open now. */
  readonly openCount: () => number;
}

/**
 * Registers the handler of `streamEvents`. The streams end when the client goes away, when the
 * daemon stops (the signal of the call, and `hub.close()`), and when the token is rotated.
 */
export function registerEventRoutes(deps: EventRouteDeps): EventStreams {
  const { config, clock, hub, daemonId } = deps;
  const open = new Set<AbortController>();
  const lag = new LagReporter(deps);

  // The token that opened a stream is gone: no stream outlives the rotation.
  deps.onTokenRotated(() => {
    for (const stream of [...open]) stream.abort();
  });

  deps.handlers.register('streamEvents', async ({ query, headers, signal }) => {
    if (open.size >= config.max_streams) {
      throw new ApiFailure('unavailable', 'Too many event streams are open', {
        details: { maxStreams: config.max_streams },
        headers: { 'retry-after': String(Math.max(1, Math.ceil(config.retry / 1000))) },
      });
    }
    // Counted before the first await, so a burst of requests cannot pass the ceiling.
    const own = new AbortController();
    open.add(own);
    let begin: { readonly cursor: number; readonly announce: boolean };
    try {
      // `Last-Event-ID` wins over `since`: the first is what a reconnection of the browser sends.
      const asked =
        headers['last-event-id'] === undefined ? query.since : Number(headers['last-event-id']);
      const head = await deps.lastId();
      // [proposta] A cursor ahead of the log (a restored backup) is moved back to the newest event,
      // and told to the client in a cursor frame, so it never waits for ids that will not come.
      begin = {
        cursor: asked === undefined ? head : Math.min(asked, head),
        announce: asked === undefined || asked > head,
      };
    } catch (error) {
      open.delete(own);
      throw error;
    }
    const { cursor, announce: announceCursor } = begin;
    const stop = AbortSignal.any([signal, own.signal]);
    const filter = {
      scenarioIds: queryList(query.scenario),
      typePrefixes: queryList(query.types),
    };
    const encoder = new TextEncoder();
    let room: (() => void) | undefined;
    let sent = cursor;

    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          // The writer waits for room, and wakes when the client reads (`pull`) or the stream stops.
          stop.addEventListener(
            'abort',
            () => {
              room?.();
            },
            { once: true },
          );
          /** Writes one frame; waits while the client does not read, so nothing piles up in memory. */
          const write = async (text: string): Promise<boolean> => {
            let reported = false;
            while (!stop.aborted && (controller.desiredSize ?? 0) <= 0) {
              if (!reported) {
                reported = true;
                lag.stalled(() => sent);
              }
              await new Promise<void>((resolve) => {
                room = resolve;
              });
            }
            if (stop.aborted) return false;
            controller.enqueue(encoder.encode(text));
            return true;
          };
          const heartbeat = async (): Promise<void> => {
            if (config.heartbeat === 0) return;
            for (;;) {
              try {
                await clock.sleep(config.heartbeat, stop);
              } catch {
                return; // cancelled: the stream is closing
              }
              // A client that does not read gets no heartbeat: the next frame is already waiting.
              if ((controller.desiredSize ?? 0) > 0)
                controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
            }
          };
          const run = async (): Promise<void> => {
            try {
              if (!(await write(retryFrame(config.retry)))) return;
              if (announceCursor && !(await write(cursorFrame(cursor)))) return;
              void heartbeat();
              for await (const envelope of hub.follow({
                afterId: cursor,
                filter,
                signal: stop,
                onLag: ({ unseen }) => {
                  lag.overflowed(unseen);
                },
              })) {
                if (!(await write(eventFrame(envelope, daemonId)))) return;
                sent = envelope.id;
              }
            } catch (error) {
              if (!stop.aborted) {
                // The log failed (a closed store): the client reconnects with its cursor.
                deps.logger.warn({ err: error }, 'an event stream ended with an error');
              }
            } finally {
              own.abort();
              open.delete(own);
              try {
                controller.close();
              } catch {
                // Already closed or cancelled by the client.
              }
            }
          };
          void run();
        },
        pull() {
          const wake = room;
          room = undefined;
          wake?.();
        },
        cancel() {
          own.abort();
        },
      },
      new CountQueuingStrategy({ highWaterMark: OUTGOING_FRAMES }),
    );
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': `${SSE_CONTENT_TYPE}; charset=utf-8`,
        'cache-control': 'no-store, no-transform',
        // A reverse proxy must not hold the frames back.
        'x-accel-buffering': 'no',
      },
    });
  });

  return { openCount: () => open.size };
}

/**
 * The `api.stream_lagged` events, with the same rate limit as `api.client_rejected` (P3): at most
 * one per reason per window (`api.sse.lagged_events.every`), counting what it held back.
 */
class LagReporter {
  readonly #deps: EventRouteDeps;
  readonly #state = new Map<ApiStreamLagReason, { lastAt: number; suppressed: number }>();

  constructor(deps: EventRouteDeps) {
    this.#deps = deps;
  }

  /** The hub says a subscriber is behind: `unseen` live events left unread. */
  overflowed(unseen: number): void {
    this.#record('buffer_overflow', unseen);
  }

  /** The client stopped reading. `sent` is the last id written to it; the gap is read from the log. */
  stalled(sent: () => number): void {
    void this.#deps
      .lastId()
      .then((head) => {
        this.#record('backpressure', Math.max(0, head - sent()));
      })
      .catch(() => undefined);
  }

  #record(reason: ApiStreamLagReason, behind: number): void {
    const { clock, config, situations, logger } = this.#deps;
    const at = clock.now();
    const state = this.#state.get(reason);
    if (state !== undefined && at - state.lastAt < config.lagged_events.every) {
      state.suppressed += 1;
      logger.debug({ reason, behind }, 'an event stream is behind');
      return;
    }
    this.#state.set(reason, { lastAt: at, suppressed: 0 });
    logger.warn({ reason, behind }, 'an event stream is behind');
    situations?.record('api.stream_lagged', { reason, behind, suppressed: state?.suppressed ?? 0 });
  }
}
