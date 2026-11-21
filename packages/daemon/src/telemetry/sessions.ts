// SPDX-License-Identifier: MPL-2.0
import type { JsonValue, TelemetryAttributes, TelemetryCorrelation } from '@otheater/core';

/**
 * The sessions the daemon has open, as far as the telemetry needs them (Phase 8, P2, N212;
 * architecture 5.11, "correlação"). A client that serves many sessions in one process (Codex,
 * OpenCode) exports with the resource of the process, which cannot name an attempt; what ties its
 * records to one is the session id it writes in each record (`conversation.id` for Codex,
 * `session.id` for Claude Code and the fake agent), which is the ACP session id. This table is
 * where the receiver finds the play, the attempt and the scenario of that id.
 *
 * A closed session stays in the table for {@link TelemetrySessionsOptions.graceMs}: a client
 * flushes its last batch after the session ended, and those records are still the session's.
 * [proposta] The grace period and the ceiling are constants here, not keys: they only bound memory.
 */

/** What the table keeps of one open session. */
export interface TelemetrySessionEntry {
  readonly sessionId: string;
  readonly client: string;
  readonly profile: string;
  readonly scenarioId: string | null;
  readonly playId: string | null;
  /** The stage the attempt runs for (`stage-<name>` demand), when it is one. */
  readonly stageId: string | null;
  readonly attemptId: string | null;
}

export interface TelemetrySessionsOptions {
  /** How long a closed session is still found. Default 5 minutes. */
  readonly graceMs?: number;
  /** Most sessions held, open and closed together; the oldest closed go first. Default 4096. */
  readonly max?: number;
  readonly now?: () => number;
}

/** Attribute names a client writes its own session id in, in the order they are tried. */
export const SESSION_ID_ATTRIBUTES = ['session.id', 'conversation.id'] as const;

export class TelemetrySessions {
  readonly #entries = new Map<string, TelemetrySessionEntry>();
  /** Closed sessions, oldest first: session id to the time it closed. */
  readonly #closed = new Map<string, number>();
  readonly #byAttempt = new Map<string, string>();
  readonly #graceMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: TelemetrySessionsOptions = {}) {
    this.#graceMs = options.graceMs ?? 300_000;
    this.#max = options.max ?? 4096;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  open(entry: TelemetrySessionEntry): void {
    this.#prune();
    this.#entries.set(entry.sessionId, entry);
    this.#closed.delete(entry.sessionId);
    if (entry.attemptId !== null) this.#byAttempt.set(entry.attemptId, entry.sessionId);
  }

  close(sessionId: string): void {
    if (!this.#entries.has(sessionId)) return;
    this.#closed.delete(sessionId);
    this.#closed.set(sessionId, this.#now());
    this.#prune();
  }

  get(sessionId: string): TelemetrySessionEntry | undefined {
    this.#prune();
    return this.#entries.get(sessionId);
  }

  /** The latest session of an attempt (a retried attempt id is a new one, so this is the only one). */
  ofAttempt(attemptId: string): TelemetrySessionEntry | undefined {
    const sessionId = this.#byAttempt.get(attemptId);
    return sessionId === undefined ? undefined : this.get(sessionId);
  }

  /**
   * The ids a record belongs to. In order of trust: the session the record names (the table is the
   * daemon's own knowledge); then the ids the resource carries (`otheater.*`, set at launch), with
   * the session of the attempt when the resource names the attempt but not the session. What no
   * source knows stays `null`.
   */
  correlate(attributes: TelemetryAttributes, resource: TelemetryAttributes): TelemetryCorrelation {
    for (const name of SESSION_ID_ATTRIBUTES) {
      const named = text(attributes[name]) ?? text(resource[name]);
      if (named === null) continue;
      const entry = this.get(named);
      if (entry !== undefined) {
        return {
          scenarioId: entry.scenarioId,
          playId: entry.playId,
          attemptId: entry.attemptId,
          sessionId: entry.sessionId,
        };
      }
    }
    const attemptId = text(resource['otheater.attempt_id']);
    const declared = text(resource['otheater.session_id']);
    const entry =
      declared === null
        ? attemptId === null
          ? undefined
          : this.ofAttempt(attemptId)
        : this.get(declared);
    return {
      scenarioId: entry?.scenarioId ?? text(resource['otheater.scenario_id']),
      playId: text(resource['otheater.play_id']) ?? entry?.playId ?? null,
      attemptId: attemptId ?? entry?.attemptId ?? null,
      sessionId: declared ?? entry?.sessionId ?? null,
    };
  }

  #prune(): void {
    const now = this.#now();
    for (const [sessionId, closedAt] of this.#closed) {
      const overflow = this.#entries.size > this.#max;
      if (now - closedAt < this.#graceMs && !overflow) break;
      this.#closed.delete(sessionId);
      const entry = this.#entries.get(sessionId);
      this.#entries.delete(sessionId);
      if (entry?.attemptId != null && this.#byAttempt.get(entry.attemptId) === sessionId) {
        this.#byAttempt.delete(entry.attemptId);
      }
    }
  }
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
