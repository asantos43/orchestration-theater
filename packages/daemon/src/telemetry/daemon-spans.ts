// SPDX-License-Identifier: MPL-2.0
import type { Clock, EventEnvelope, EventLog, TelemetryStore } from '@otheater/core';
import type { EventHub } from '../events/event-hub.js';
import type { Logger } from '../logger.js';
import { situationSubject, situationText, type SituationSink } from '../situations.js';
import { SPAN_NAME } from './span-conventions.js';
import { SpanProjection, directWaitSpan } from './span-projection.js';
import type { DirectWait, WaitRecorder } from './wait-recorder.js';

/**
 * The spans of the daemon (Phase 8, P4; N214 (a); architecture 5.11). [proposta] A projector reads
 * the event log with a cursor of its own, through the hub (history first, then live), folds it with
 * {@link SpanProjection} and writes the spans it closes to the telemetry base. It is never what the
 * orchestration depends on: a failure here is a situation and a retry, not an error.
 *
 * How it stays right:
 * - the ids of the spans come from ids of the log, and the base keeps the first span written under
 *   a `(trace_id, span_id)`, so reading an event twice writes nothing twice;
 * - the cursor lives in the telemetry base (`cursor:daemon-spans`), so a base that was deleted or
 *   recreated has no cursor and the projection starts again at the first event; the projector also
 *   notices a base that was recreated while it runs and does the same;
 * - the cursor saved is a **watermark**: the event before the oldest one that still has an open
 *   span. A daemon that stops with spans open reads them again from there, and what was already
 *   written is ignored by the base;
 * - spans are written to the queue of the base as they close; the cursor is saved in batches (every
 *   {@link CHECKPOINT_EVERY} events, when a play ends, when asked to {@link DaemonSpans.settle} and
 *   when it stops), after the queue is written (`writeCursor` flushes first).
 */

export const DAEMON_SPANS_CURSOR = 'daemon-spans';

/** The cursor is saved after this many events at most. */
export const CHECKPOINT_EVERY = 200;
/** Time to read the log again after a failure, on the daemon's clock. */
export const RETRY_AFTER_MS = 5_000;

export interface DaemonSpansOptions {
  readonly telemetry: TelemetryStore;
  readonly hub: Pick<EventHub, 'follow'>;
  readonly events: Pick<EventLog, 'lastId'>;
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
  readonly situations?: SituationSink | undefined;
  /** `telemetry.daemon_spans.waits`: `all` makes the waits recorded where they happen too. */
  readonly waits: 'all' | 'log' | 'off';
  /** Events read per page; the default of the hub. */
  readonly pageSize?: number | undefined;
}

/** A wait of {@link DaemonSpans.settle}: resolved once the projector has read up to `target`. */
interface Settling {
  readonly target: number;
  readonly resolve: () => void;
}

export class DaemonSpans {
  readonly #o: DaemonSpansOptions;
  readonly #stopSignal = new AbortController();
  #supervisor: Promise<void> | undefined;
  /** Aborts the read now going on; the supervisor starts another one. */
  #run: AbortController | undefined;
  #rewind = false;
  #processed = 0;
  #written = 0;
  #failing = false;
  #running = false;
  #settling: Settling[] = [];
  #projection = new SpanProjection();

  constructor(options: DaemonSpansOptions) {
    this.#o = options;
  }

  /** The spans written since the start (the closing ones of the log and the waits recorded). */
  get written(): number {
    return this.#written;
  }

  /** The id of the last event of the log the projector read. */
  get processedId(): number {
    return this.#processed;
  }

  /** The spans still open (a play, an attempt, a session, a call or a wait that has not ended). */
  get openSpans(): number {
    return this.#projection.open;
  }

  /** Starts reading the log. Idempotent. */
  start(): void {
    if (this.#supervisor !== undefined) return;
    this.#supervisor = this.#supervise();
  }

  /**
   * Resolves when every event the log had at the call was read, its spans were written and the
   * cursor was saved. Also resolves when the projector is failing or stopped: it never waits for a
   * base that cannot be had. For tests and for shutdown.
   */
  async settle(): Promise<void> {
    if (this.#supervisor === undefined) return;
    let target: number;
    try {
      target = await this.#o.events.lastId();
    } catch {
      return;
    }
    if (this.#processed >= target && this.#running) {
      await this.#checkpoint(this.#projection, this.#processed);
      return;
    }
    await new Promise<void>((resolve) => {
      if (this.#stopSignal.signal.aborted || this.#failing) {
        resolve();
        return;
      }
      this.#settling.push({ target, resolve });
    });
    await this.#o.telemetry.flush().catch(() => undefined);
  }

  /** Reads what is left, saves the cursor and ends. Idempotent. */
  async stop(): Promise<void> {
    if (this.#supervisor === undefined) return;
    if (!this.#stopSignal.signal.aborted) {
      await this.settle().catch(() => undefined);
      this.#stopSignal.abort();
      this.#run?.abort();
      this.#release();
    }
    await this.#supervisor;
  }

  /**
   * Reads the log from the first event again and writes every span (the ones already in the base
   * are ignored). What a recreated base needs; also what a person wants after a change in the
   * conventions. The waits recorded where they happened are not in the log, so they are not back.
   */
  reproject(): void {
    this.#rewind = true;
    this.#run?.abort();
  }

  /**
   * The wait recorder for the places that wait with no event (the queue of prompts, the pool). It
   * does nothing unless `telemetry.daemon_spans.waits` is `all`.
   */
  readonly recordWait: WaitRecorder = (wait: DirectWait) => {
    if (this.#o.waits !== 'all' || this.#stopSignal.signal.aborted) return;
    try {
      const receipt = this.#o.telemetry.write({ spans: [directWaitSpan(wait)] });
      this.#written += receipt.accepted;
    } catch (error) {
      // `write` never throws; a span that cannot even be built is not worth more than a line.
      this.#o.logger.debug({ err: error }, 'a wait span was not recorded');
    }
  };

  // ---- the loop -----------------------------------------------------------------------------------

  /** Read through a method: the flags change while an `await` is pending, which narrowing cannot see. */
  #stopped(): boolean {
    return this.#stopSignal.signal.aborted;
  }

  #rewinding(): boolean {
    return this.#rewind;
  }

  async #supervise(): Promise<void> {
    const stop = this.#stopSignal.signal;
    while (!stop.aborted) {
      const run = new AbortController();
      this.#run = run;
      const onStop = (): void => {
        run.abort();
      };
      stop.addEventListener('abort', onStop, { once: true });
      try {
        await this.#read(run.signal);
      } catch (error) {
        if (this.#stopped()) break;
        this.#failed(error);
        this.#release();
        try {
          await this.#o.clock.sleep(RETRY_AFTER_MS, stop);
        } catch {
          break;
        }
      } finally {
        stop.removeEventListener('abort', onStop);
        this.#running = false;
      }
    }
    this.#release();
  }

  /** One pass of the reading: from the saved cursor (or the first event) until `signal` aborts. */
  async #read(signal: AbortSignal): Promise<void> {
    const { telemetry } = this.#o;
    const rewound = this.#rewind;
    this.#rewind = false;
    const saved = rewound ? null : await telemetry.readCursor(DAEMON_SPANS_CURSOR);
    const afterId = saved ?? 0;
    const projection = new SpanProjection();
    this.#projection = projection;
    this.#processed = afterId;
    this.#running = true;
    let base = await telemetry.health();
    let lastRead = afterId;
    let sinceCheckpoint = 0;
    const events = this.#o.hub.follow({
      afterId,
      signal,
      ...(this.#o.pageSize === undefined ? {} : { pageSize: this.#o.pageSize }),
    });
    for await (const event of events) {
      lastRead = event.id;
      this.#apply(projection, event);
      this.#processed = event.id;
      sinceCheckpoint += 1;
      const ending = event.type === 'play.transitioned' && projection.open === 0;
      if (sinceCheckpoint >= CHECKPOINT_EVERY || ending || this.#due(event.id)) {
        sinceCheckpoint = 0;
        const now = await telemetry.health();
        if (baseWasReplaced(base, now)) {
          // The base is new (or was away): what it should hold is in the log, not in it.
          this.#rewind = true;
          return;
        }
        base = now;
        await this.#checkpoint(projection, lastRead);
        this.#serve(event.id);
      }
    }
    // Stopped, or asked to start again: leave the cursor where it stands.
    if (!this.#rewinding()) await this.#checkpoint(projection, lastRead);
  }

  #apply(projection: SpanProjection, event: EventEnvelope): void {
    const spans = projection.apply(event);
    if (spans.length === 0) return;
    const wanted =
      this.#o.waits === 'off' ? spans.filter((span) => span.name !== SPAN_NAME.wait) : spans;
    if (wanted.length === 0) return;
    const receipt = this.#o.telemetry.write({ spans: wanted });
    this.#written += receipt.accepted;
  }

  /** Someone waits in {@link settle} for an event this one reached. */
  #due(id: number): boolean {
    return this.#settling.some((waiting) => waiting.target <= id);
  }

  #serve(id: number): void {
    const [ready, waiting] = partition(this.#settling, (entry) => entry.target <= id);
    this.#settling = waiting;
    for (const entry of ready) entry.resolve();
  }

  #release(): void {
    const waiting = this.#settling;
    this.#settling = [];
    for (const entry of waiting) entry.resolve();
  }

  /** Saves the watermark. A failure is told and does not stop the reading. */
  async #checkpoint(projection: SpanProjection, lastRead: number): Promise<void> {
    try {
      await this.#o.telemetry.writeCursor(DAEMON_SPANS_CURSOR, projection.watermark(lastRead));
      this.#failing = false;
    } catch (error) {
      this.#failed(error, 'cursor');
    }
  }

  #failed(error: unknown, subject = 'read'): void {
    this.#o.logger.warn({ err: error, subject }, 'the spans of the daemon could not be projected');
    if (this.#failing) return;
    this.#failing = true;
    this.#o.situations?.record('daemon.notice', {
      kind: 'daemon_spans_failed',
      subject: situationSubject(subject),
      detail: situationText(error),
    });
  }
}

/** A base that is not the one the cursor was saved in: recreated, or back after it was away. */
function baseWasReplaced(
  before: { readonly state: string; readonly resets: number },
  now: { readonly state: string; readonly resets: number },
): boolean {
  return now.resets !== before.resets || (before.state === 'no_base' && now.state !== 'no_base');
}

function partition<T>(list: readonly T[], test: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of list) (test(item) ? yes : no).push(item);
  return [yes, no];
}
