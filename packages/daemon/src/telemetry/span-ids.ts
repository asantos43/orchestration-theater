// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';

/**
 * The ids of the spans of the daemon (Phase 8, P4). [proposta] Every id is a hash of ids the event
 * log already has, so projecting the log again gives the same spans (the base keeps the first one
 * written under a `(trace_id, span_id)`), and so a client can be told, before it starts, the trace
 * and the span its own spans hang from.
 *
 * The functions here are pure and stable: changing one changes every span ever written, so the
 * prefixes below are part of the format.
 */

function digest(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function traceHex(...parts: readonly string[]): string {
  return digest('otheater/trace', ...parts).slice(0, 32);
}

function spanHex(...parts: readonly string[]): string {
  return digest('otheater/span', ...parts).slice(0, 16);
}

/** The ids that decide which trace a span belongs to. */
export interface TraceScope {
  readonly playId?: string | null | undefined;
  readonly attemptId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
}

/**
 * The trace (32 hex) of a play: every span of a play, from `otheater.play` down to the tool calls
 * of its attempts, is in it, so the tree reads as one.
 */
export function traceIdForPlay(playId: string): string {
  return traceHex('play', playId);
}

/**
 * The `otheater.trace_id` of an attempt: the trace of its play, so the spans a client exports for
 * the attempt (P2, P3) are in the same trace as the daemon spans they hang from. An attempt with no
 * play (the Director's) has a trace of its own, from its id; a scope with only a session gets the
 * trace of the session. `undefined` when the scope has no id at all, and then there is no span.
 */
export function traceIdForAttempt(scope: TraceScope): string | undefined {
  if (scope.playId !== undefined && scope.playId !== null) return traceIdForPlay(scope.playId);
  if (scope.attemptId !== undefined && scope.attemptId !== null) {
    return traceHex('attempt', scope.attemptId);
  }
  if (scope.sessionId !== undefined && scope.sessionId !== null) {
    return traceHex('session', scope.sessionId);
  }
  return undefined;
}

/** The trace of something that has no play, attempt or session (a prompt of the queue). */
export function traceIdForKey(kind: string, key: string): string {
  return traceHex(kind, key);
}

export function playSpanId(playId: string): string {
  return spanHex('play', playId);
}

/** A stage is a visit of a state: its id comes from the play and the event that entered it. */
export function stageSpanId(playId: string, enteredAtEventId: number): string {
  return spanHex('stage', playId, String(enteredAtEventId));
}

export function attemptSpanId(attemptId: string): string {
  return spanHex('attempt', attemptId);
}

/**
 * The span of a session. It depends on the session id alone, so whoever knows the id of the session
 * (a client, through the resource attributes of P3) knows the span its own spans hang from.
 */
export function sessionSpanId(sessionId: string): string {
  return spanHex('session', sessionId);
}

export function toolSpanId(scope: string, callId: string): string {
  return spanHex('tool', scope, callId);
}

/** A wait: `kind` is {@link WaitKind}; `key` is what makes it this one (an event id, a prompt id). */
export function waitSpanId(kind: string, ...key: readonly string[]): string {
  return spanHex('wait', kind, ...key);
}
