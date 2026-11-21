// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '@otheater/core';
import type {
  WaitEndedPayload,
  WaitEventKind,
  WaitEventOutcome,
  WaitEventReason,
  WaitStartedPayload,
} from '@otheater/protocol';
import type { SituationCorrelation, SituationSink } from '../situations.js';

/**
 * The waits of the daemon that are told in the event log (Phase 8, P15; N222 (a); architecture 5.11):
 * a prompt in the queue for the Director and a session in the queue of the pool. [proposta]
 *
 * The place that waits opens a {@link WaitHandle} when the wait begins and closes it when it ends. A
 * wait that lasts `events.wait_threshold` writes `wait.started`; one that ends before that writes
 * nothing, and `wait.ended` is only written for a wait that has its `wait.started`. The spans
 * (`otheater.wait`) are made from the two events by the projector of the spans, like every other wait
 * the log tells, so they come back when the telemetry base is recreated.
 *
 * Why a timer and not only a check when the wait ends: the log then shows a wait while it goes on
 * (a hook, a plugin or a screen can tell the Producer "waiting for the quota for 1 s"), and a daemon
 * that stops in the middle of a wait leaves its start in the log, which the projector reads as an
 * open span. The check at the end stays as the second way to the same event, for a timer that
 * fires after the wait ended and for a wait that was already older than the threshold when the
 * daemon first saw it (a prompt a restart found in the queue). The timer is one `clock.sleep` that
 * the end of the wait aborts; it never runs in the path of the queue or of the admission, and what
 * it calls (`SituationSink.record`) never throws and never waits, so a wait is never delayed or
 * broken by its own event.
 */

/** The ids a wait can be tied to. Every one is optional: a prompt has no play or attempt. */
export interface WaitCorrelation {
  readonly scenarioId?: string | undefined;
  readonly playId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly role?: string | undefined;
  readonly client?: string | undefined;
  readonly profile?: string | undefined;
}

/** What the place that waits says when the wait begins. */
export interface WaitBegin {
  readonly kind: WaitEventKind;
  /** Makes the wait this one: the id of the prompt, the key of the request to the pool. */
  readonly id: string;
  /** When it began, on the clock of the daemon (a prompt of a past run began before this one). */
  readonly since: number;
  /** Why it waits at first; {@link WaitHandle.hold} adds the others. */
  readonly reason: WaitEventReason;
  readonly correlation?: WaitCorrelation | undefined;
  /** `prompt_queue`: who wrote the prompt and with which priority. */
  readonly prompt?: { readonly source: string; readonly priority: number } | undefined;
}

/** One wait that is going on. Neither call throws or waits; both are idempotent. */
export interface WaitHandle {
  /** One more reason the wait has. */
  hold(reason: WaitEventReason): void;
  /** The wait ended. Writes `wait.ended` if `wait.started` was written. */
  end(outcome: WaitEventOutcome): void;
}

/** What a module that waits is given. */
export interface WaitTracker {
  begin(wait: WaitBegin): WaitHandle;
}

export interface WaitEventsOptions {
  readonly situations: SituationSink;
  readonly clock: Clock;
  /** `events.wait_threshold`: a wait this long (in ms) is told; 0 tells every wait that began. */
  readonly thresholdMs: number;
}

export class WaitEvents implements WaitTracker {
  readonly #o: WaitEventsOptions;
  readonly #timers = new Set<AbortController>();
  #closed = false;

  constructor(options: WaitEventsOptions) {
    this.#o = options;
  }

  begin(wait: WaitBegin): WaitHandle {
    return new TrackedWait(this, this.#o, wait);
  }

  /** Stops every timer and writes nothing more. For the shutdown of the daemon. */
  close(): void {
    this.#closed = true;
    for (const timer of this.#timers) timer.abort();
    this.#timers.clear();
  }

  /** @internal Used by {@link TrackedWait}. */
  get closed(): boolean {
    return this.#closed;
  }

  /** @internal Used by {@link TrackedWait}. */
  track(timer: AbortController, on: boolean): void {
    if (on) this.#timers.add(timer);
    else this.#timers.delete(timer);
  }
}

function correlationOf(wait: WaitBegin): SituationCorrelation {
  const { correlation } = wait;
  return {
    scenarioId: correlation?.scenarioId,
    playId: correlation?.playId,
    attemptId: correlation?.attemptId,
  };
}

/** The fields both events carry; an absent value is left out (the payloads are strict). */
function common(wait: WaitBegin, reasons: ReadonlySet<WaitEventReason>) {
  const { correlation, prompt } = wait;
  return {
    waitId: wait.id,
    kind: wait.kind,
    reasons: [...reasons].sort(),
    since: wait.since,
    ...(correlation?.scenarioId === undefined ? {} : { scenarioId: correlation.scenarioId }),
    ...(correlation?.playId === undefined ? {} : { playId: correlation.playId }),
    ...(correlation?.attemptId === undefined ? {} : { attemptId: correlation.attemptId }),
    ...(correlation?.role === undefined ? {} : { role: correlation.role }),
    ...(correlation?.client === undefined ? {} : { client: correlation.client }),
    ...(correlation?.profile === undefined ? {} : { profile: correlation.profile }),
    ...(prompt === undefined
      ? {}
      : { promptSource: prompt.source, promptPriority: prompt.priority }),
  };
}

class TrackedWait implements WaitHandle {
  readonly #owner: WaitEvents;
  readonly #o: WaitEventsOptions;
  readonly #wait: WaitBegin;
  readonly #reasons: Set<WaitEventReason>;
  readonly #timer = new AbortController();
  #started = false;
  #ended = false;

  constructor(owner: WaitEvents, options: WaitEventsOptions, wait: WaitBegin) {
    this.#owner = owner;
    this.#o = options;
    this.#wait = wait;
    this.#reasons = new Set([wait.reason]);
    if (owner.closed) {
      this.#ended = true;
      return;
    }
    const remaining = options.thresholdMs - (options.clock.now() - wait.since);
    if (remaining <= 0) {
      this.#start();
      return;
    }
    owner.track(this.#timer, true);
    void options.clock.sleep(remaining, this.#timer.signal).then(
      () => {
        this.#owner.track(this.#timer, false);
        this.#start();
      },
      () => undefined,
    );
  }

  hold(reason: WaitEventReason): void {
    if (!this.#ended) this.#reasons.add(reason);
  }

  end(outcome: WaitEventOutcome): void {
    if (this.#ended) return;
    const now = this.#o.clock.now();
    // The timer may be a moment behind a wait that already reached the threshold.
    if (!this.#started && now - this.#wait.since >= this.#o.thresholdMs) this.#start();
    this.#ended = true;
    this.#timer.abort();
    this.#owner.track(this.#timer, false);
    if (!this.#started || this.#owner.closed) return;
    const payload: WaitEndedPayload = {
      ...common(this.#wait, this.#reasons),
      outcome,
      waitedMs: Math.max(0, now - this.#wait.since),
    };
    this.#tell(() => {
      this.#o.situations.record('wait.ended', payload, correlationOf(this.#wait));
    });
  }

  #start(): void {
    if (this.#started || this.#ended || this.#owner.closed) return;
    this.#started = true;
    const payload: WaitStartedPayload = {
      ...common(this.#wait, this.#reasons),
      thresholdMs: this.#o.thresholdMs,
    };
    this.#tell(() => {
      this.#o.situations.record('wait.started', payload, correlationOf(this.#wait));
    });
  }

  /** `record` never throws; the guard keeps a wait from ever depending on that. */
  #tell(write: () => void): void {
    try {
      write();
    } catch {
      // A wait is not worth more than its event.
    }
  }
}
