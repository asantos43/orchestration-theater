// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope } from '@otheater/core';
import type { EventHub } from '../events/event-hub.js';
import type { Logger } from '../logger.js';

/**
 * The counters of `/metrics` that only the events can give (Phase 8, P7; N218). [proposta] The
 * daemon keeps no per-Executor or per-role count of attempts, resumes and failures: the attempt
 * registry has neither the model nor the role, and `usage` is per turn. The events have both, so
 * this follows the hub **from now** and counts. What it means, and what it does not:
 *
 * - the counters are **since this daemon started** (they go back to zero on a restart, which is what a
 *   Prometheus counter does and `rate()` handles). The history of the log is not replayed;
 * - an attempt whose session opened before the daemon started has the Executor `unknown`; one whose
 *   selection was not seen has the role `unknown`;
 * - the memory is bounded: an attempt and a session leave the maps when they end, a play keeps its
 *   newest {@link SELECTIONS_PER_PLAY} selections and the plays kept are capped.
 */

export const SELECTIONS_PER_PLAY = 16;
export const MAX_PLAYS = 1000;
export const MAX_OPEN = 10_000;

export const UNKNOWN = 'unknown';

/** How an attempt ended, as `otheater_attempts_total` says it (from the event that ended it). */
const ATTEMPT_OUTCOMES: Readonly<Record<string, string>> = {
  'attempt.submitted': 'submitted',
  'attempt.cancelled': 'cancelled',
  'attempt.aborted': 'aborted',
};

/**
 * The interruption causes that are not a failure of the Executor: the attempt was paused on
 * purpose, or its profile was removed. [proposta]
 */
const NOT_A_FAILURE: ReadonlySet<string> = new Set(['paused', 'profile_removed']);

export interface EventCount {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `<model>[-<effort>]@<client>/<profile>` from the flat Executor of a payload, or `unknown`. */
export function executorLabel(value: unknown): string {
  const executor = record(value);
  const client = text(executor?.client);
  const profile = text(executor?.profile);
  const model = text(executor?.model);
  if (client === undefined || profile === undefined || model === undefined) return UNKNOWN;
  const effort = text(executor?.effort);
  return `${effort === undefined ? model : `${model}-${effort}`}@${client}/${profile}`;
}

function bump(counts: Map<string, EventCount>, labels: Record<string, string>): void {
  const key = JSON.stringify(labels);
  const known = counts.get(key);
  if (known === undefined) counts.set(key, { labels, value: 1 });
  else counts.set(key, { labels, value: known.value + 1 });
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_OPEN) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
}

export class EventMetrics {
  readonly #attempts = new Map<string, EventCount>();
  readonly #resumes = new Map<string, EventCount>();
  readonly #failures = new Map<string, EventCount>();
  /** The oldest selection of a play that no session has taken yet, to tell a session's role. */
  readonly #selections = new Map<string, { role: string; executor: string }[]>();
  readonly #sessions = new Map<string, string>();
  readonly #attemptExecutor = new Map<string, string>();
  readonly #attemptRole = new Map<string, string>();
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;

  /** Follows the hub from now until {@link stop}. Idempotent; a failure of the follow ends it, not the daemon. */
  start(hub: Pick<EventHub, 'follow'>, logger: Pick<Logger, 'warn'>): void {
    this.#loop ??= (async () => {
      try {
        for await (const event of hub.follow({
          signal: this.#stop.signal,
          filter: { typePrefixes: ['attempt.', 'session.', 'executor.selected'] },
        })) {
          this.observe(event);
        }
      } catch (error) {
        if (!this.#stop.signal.aborted) {
          logger.warn({ err: String(error) }, 'the event counters of /metrics stopped');
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#loop?.catch(() => undefined);
  }

  /** Counts one event. Never throws. */
  observe(event: EventEnvelope): void {
    try {
      this.#observe(event);
    } catch {
      // A payload this does not understand is not worth a failed counter.
    }
  }

  attempts(): readonly EventCount[] {
    return [...this.#attempts.values()];
  }

  resumes(): readonly EventCount[] {
    return [...this.#resumes.values()];
  }

  failures(): readonly EventCount[] {
    return [...this.#failures.values()];
  }

  #observe(event: EventEnvelope): void {
    const payload = event.payload;
    const playId = event.playId ?? text(payload.playId);
    const attemptId = event.attemptId ?? text(payload.attemptId);
    switch (event.type) {
      case 'executor.selected': {
        if (payload.outcome !== 'selected' || playId === undefined) return;
        const role = text(payload.role);
        if (role === undefined) return;
        const list = this.#selections.get(playId) ?? [];
        list.push({ role, executor: executorLabel(payload.executor) });
        if (list.length > SELECTIONS_PER_PLAY) list.shift();
        this.#selections.delete(playId);
        this.#selections.set(playId, list);
        if (this.#selections.size > MAX_PLAYS) {
          const oldest = this.#selections.keys().next();
          if (oldest.done !== true) this.#selections.delete(oldest.value);
        }
        return;
      }
      case 'session.opened': {
        const sessionId = text(payload.sessionId);
        if (sessionId === undefined) return;
        const executor = executorLabel(payload.executor);
        remember(this.#sessions, sessionId, executor);
        if (attemptId === undefined) return;
        remember(this.#attemptExecutor, attemptId, executor);
        const list = playId === undefined ? undefined : this.#selections.get(playId);
        const at = list?.findIndex((entry) => entry.executor === executor) ?? -1;
        const role = list !== undefined && at >= 0 ? list.splice(at, 1)[0]?.role : undefined;
        if (role !== undefined) remember(this.#attemptRole, attemptId, role);
        return;
      }
      case 'session.closed': {
        const sessionId = text(payload.sessionId);
        if (sessionId !== undefined) this.#sessions.delete(sessionId);
        return;
      }
      case 'session.interrupted': {
        const cause = text(payload.cause);
        if (cause === undefined || NOT_A_FAILURE.has(cause)) return;
        const sessionId = text(payload.sessionId);
        const executor =
          payload.from === undefined
            ? ((sessionId === undefined ? undefined : this.#sessions.get(sessionId)) ?? UNKNOWN)
            : executorLabel(payload.from);
        bump(this.#failures, { executor, kind: cause });
        return;
      }
      case 'session.resumed': {
        const executor = executorLabel(payload.to);
        bump(this.#resumes, { executor, reason: text(payload.cause) ?? UNKNOWN });
        if (attemptId !== undefined) remember(this.#attemptExecutor, attemptId, executor);
        const sessionId = text(payload.sessionId);
        if (sessionId !== undefined) remember(this.#sessions, sessionId, executor);
        return;
      }
      default: {
        const outcome = ATTEMPT_OUTCOMES[event.type];
        if (outcome === undefined || attemptId === undefined) return;
        bump(this.#attempts, {
          executor: this.#attemptExecutor.get(attemptId) ?? UNKNOWN,
          role: this.#attemptRole.get(attemptId) ?? UNKNOWN,
          outcome,
        });
        this.#attemptExecutor.delete(attemptId);
        this.#attemptRole.delete(attemptId);
      }
    }
  }
}
