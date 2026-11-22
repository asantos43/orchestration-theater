// SPDX-License-Identifier: MPL-2.0
import type { TelemetryLogRecord, TelemetrySpan } from '@otheater/core';
import { OT } from './span-conventions.js';
import type { TelemetryContext } from './client-telemetry.js';
import { attemptSpanId, sessionSpanId, traceIdForAttempt } from './span-ids.js';

/**
 * The single tree of spans (Phase 9, P1; N230 (2)). A client exports its spans in a trace of its own
 * (there is no W3C propagation through ACP), so they sat next to the tree of the daemon and were tied
 * to it only by attribute. This puts them under it. [proposta] The rules:
 * - **Only what is known**: the receiver has already tied the record to a session or an attempt
 *   (`TelemetrySessions.correlate`). A record with neither is left exactly as it came.
 * - **The trace** becomes the one the daemon gives that session (`traceIdForAttempt`: the trace of
 *   the play, or of the attempt that has no play), so a span of the client and the spans of the
 *   daemon of the same work read as one trace.
 * - **The root of the client** (a span with no parent) hangs from the span of the session
 *   (`sessionSpanId`), or from the span of the attempt when only the attempt is known. A span that
 *   has a parent keeps it: the client's own hierarchy is not touched. A client that exports a child
 *   before its parent is no problem, because the new parent depends on the correlation alone.
 * - **What the client said** is not lost: the trace id it used is in `otheater.client.trace_id`, and
 *   the parent it had, when it had one, in `otheater.client.parent_span_id`.
 * - **Logs** that name a trace follow their spans to the new trace (the span id stays).
 * Everything here is a pure function of the record and its correlation, so a batch sent twice lands
 * in the same place and the base keeps one of them.
 */

interface Placement {
  readonly traceId: string;
  /** The span the root of the client hangs from. */
  readonly parentSpanId: string;
}

/** Where the daemon's tree has room for a record of this session or attempt; `undefined` when it has none. */
function placementOf(record: {
  readonly playId: string | null;
  readonly attemptId: string | null;
  readonly sessionId: string | null;
}): Placement | undefined {
  const { playId, attemptId, sessionId } = record;
  const traceId = traceIdForAttempt({ playId, attemptId, sessionId });
  if (traceId === undefined) return undefined;
  if (sessionId !== null) return { traceId, parentSpanId: sessionSpanId(sessionId) };
  if (attemptId !== null) return { traceId, parentSpanId: attemptSpanId(attemptId) };
  return undefined;
}

export function reparentSpan(span: TelemetrySpan): TelemetrySpan {
  const placement = placementOf(span);
  if (placement === undefined) return span;
  const moved = span.traceId !== placement.traceId;
  const attributes = {
    ...span.attributes,
    ...(moved ? { [OT.clientTraceId]: span.traceId } : {}),
    ...(moved && span.parentSpanId !== null ? { [OT.clientParentSpanId]: span.parentSpanId } : {}),
  };
  return {
    ...span,
    traceId: placement.traceId,
    // A span of the client that has a parent keeps it; the root of the client hangs from the session.
    parentSpanId: span.parentSpanId ?? placement.parentSpanId,
    attributes,
  };
}

export function reparentLog(record: TelemetryLogRecord): TelemetryLogRecord {
  if (record.traceId === null) return record;
  const placement = placementOf(record);
  if (placement === undefined || record.traceId === placement.traceId) return record;
  return {
    ...record,
    traceId: placement.traceId,
    attributes: { ...record.attributes, [OT.clientTraceId]: record.traceId },
  };
}

/**
 * The `resourceExtras` of `ClientTelemetry` (P2 left the hook, Phase 9, P1 connects it): the
 * `otheater.trace_id` of the work a session is opened for, in the resource the client exports with,
 * so a span of the client says in which trace the daemon will place it. [proposta] The parent is not
 * given: the span of a session depends on the session id, which the client assigns after it was
 * launched, so only the receiver, which has the table of sessions, can name it. No ids, no extras.
 */
export function traceResourceExtras(
  _client: string,
  context: TelemetryContext,
): Record<string, string> {
  const traceId = traceIdForAttempt({
    playId: context.playId,
    attemptId: context.attemptId,
  });
  return traceId === undefined ? {} : { [OT.traceId]: traceId };
}
