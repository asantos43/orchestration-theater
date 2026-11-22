// SPDX-License-Identifier: MPL-2.0
import type { TelemetryLogRecord, TelemetrySpan } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { reparentLog, reparentSpan, traceResourceExtras } from './reparent.js';
import { attemptSpanId, sessionSpanId, traceIdForAttempt, traceIdForPlay } from './span-ids.js';

const CLIENT_TRACE = 'c'.repeat(32);

function span(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: CLIENT_TRACE,
    spanId: '1'.repeat(16),
    parentSpanId: null,
    name: 'client.turn',
    kind: 1,
    startTimeUnixNano: 1n,
    endTimeUnixNano: 2n,
    status: 'ok',
    statusMessage: null,
    attributes: { 'session.id': 's1' },
    resource: {},
    scenarioId: null,
    playId: 'play-1',
    attemptId: 'play-1/stage-a/1',
    sessionId: 's1',
    ...overrides,
  };
}

function log(overrides: Partial<TelemetryLogRecord> = {}): TelemetryLogRecord {
  return {
    timeUnixNano: 1n,
    severity: 9,
    severityText: 'INFO',
    body: 'tool_call',
    traceId: CLIENT_TRACE,
    spanId: '1'.repeat(16),
    attributes: {},
    resource: {},
    scenarioId: null,
    playId: 'play-1',
    attemptId: 'play-1/stage-a/1',
    sessionId: 's1',
    ...overrides,
  };
}

describe('reparentSpan', () => {
  it('puts the root of the client under the span of its session, in the trace of the play', () => {
    const moved = reparentSpan(span());
    expect(moved.traceId).toBe(traceIdForPlay('play-1'));
    expect(moved.parentSpanId).toBe(sessionSpanId('s1'));
    expect(moved.spanId).toBe('1'.repeat(16));
    expect(moved.attributes).toMatchObject({
      'session.id': 's1',
      'otheater.client.trace_id': CLIENT_TRACE,
    });
    // It had no parent: there is nothing to keep.
    expect(moved.attributes['otheater.client.parent_span_id']).toBeUndefined();
  });

  it('keeps the hierarchy of the client and says which parent it had', () => {
    const child = span({ spanId: '2'.repeat(16), parentSpanId: '1'.repeat(16) });
    const moved = reparentSpan(child);
    expect(moved.traceId).toBe(traceIdForPlay('play-1'));
    expect(moved.parentSpanId).toBe('1'.repeat(16));
    expect(moved.attributes['otheater.client.parent_span_id']).toBe('1'.repeat(16));
    expect(moved.attributes['otheater.client.trace_id']).toBe(CLIENT_TRACE);
  });

  it('hangs from the attempt when only the attempt is known', () => {
    const moved = reparentSpan(span({ sessionId: null }));
    expect(moved.traceId).toBe(traceIdForPlay('play-1'));
    expect(moved.parentSpanId).toBe(attemptSpanId('play-1/stage-a/1'));
  });

  it('uses the trace of the attempt when there is no play (the Director)', () => {
    const moved = reparentSpan(span({ playId: null }));
    expect(moved.traceId).toBe(traceIdForAttempt({ attemptId: 'play-1/stage-a/1' }));
    expect(moved.parentSpanId).toBe(sessionSpanId('s1'));
  });

  it('leaves a span of no known session or attempt as it came', () => {
    const unknown = span({ sessionId: null, attemptId: null, playId: 'play-1' });
    expect(reparentSpan(unknown)).toBe(unknown);
  });

  it('does nothing to a span already in the trace it would be moved to', () => {
    const same = span({ traceId: traceIdForPlay('play-1') });
    const moved = reparentSpan(same);
    expect(moved.attributes['otheater.client.trace_id']).toBeUndefined();
    expect(moved.parentSpanId).toBe(sessionSpanId('s1'));
  });

  it('is the same every time (a batch sent twice lands in the same place)', () => {
    expect(reparentSpan(span())).toEqual(reparentSpan(span()));
  });
});

describe('reparentLog', () => {
  it('follows its span to the new trace and keeps the span id', () => {
    const moved = reparentLog(log());
    expect(moved.traceId).toBe(traceIdForPlay('play-1'));
    expect(moved.spanId).toBe('1'.repeat(16));
    expect(moved.attributes['otheater.client.trace_id']).toBe(CLIENT_TRACE);
  });

  it('leaves a log with no trace, and one of an unknown session, as they came', () => {
    const none = log({ traceId: null, spanId: null });
    expect(reparentLog(none)).toBe(none);
    const unknown = log({ sessionId: null, attemptId: null });
    expect(reparentLog(unknown)).toBe(unknown);
  });
});

describe('traceResourceExtras', () => {
  it('gives the trace of the work of the session', () => {
    expect(traceResourceExtras('fake', { playId: 'play-1', attemptId: 'a1' })).toEqual({
      'otheater.trace_id': traceIdForPlay('play-1'),
    });
    expect(traceResourceExtras('fake', { attemptId: 'a1' })).toEqual({
      'otheater.trace_id': traceIdForAttempt({ attemptId: 'a1' }),
    });
  });

  it('gives nothing to a session that is for no play and no attempt', () => {
    expect(traceResourceExtras('fake', {})).toEqual({});
  });
});
