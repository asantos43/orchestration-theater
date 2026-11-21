// SPDX-License-Identifier: MPL-2.0
import type { TelemetryLogRecord, TelemetryMetricPoint, TelemetrySpan } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { encodeOtlp } from './otlp-encode.js';
import { decodeOtlp } from './otlp.js';

const NONE = { scenarioId: null, playId: null, attemptId: null, sessionId: null } as const;
const RESOURCE = { 'service.name': 'otheater', 'otheater.component': 'daemon' };

function span(over: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    ...NONE,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'op',
    kind: 1,
    startTimeUnixNano: 1_700_000_000_123_456_789n,
    endTimeUnixNano: 1_700_000_001_000_000_001n,
    status: 'unset',
    statusMessage: null,
    attributes: { 'a.string': 'x', 'a.int': 7, 'a.double': 1.5, 'a.bool': true },
    resource: RESOURCE,
    ...over,
  };
}

function point(over: Partial<TelemetryMetricPoint> = {}): TelemetryMetricPoint {
  return {
    ...NONE,
    name: 'm',
    unit: null,
    kind: 'gauge',
    timeUnixNano: 20n,
    startTimeUnixNano: null,
    value: 1.5,
    detail: null,
    attributes: {},
    resource: RESOURCE,
    ...over,
  };
}

describe('encodeOtlp: traces', () => {
  it('writes ids in hex, 64-bit times as strings and the status as a number', () => {
    const body = encodeOtlp('traces', [
      span({ parentSpanId: 'c'.repeat(16), status: 'error', statusMessage: 'boom' }),
    ]);
    const request = body as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const out = request.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(out).toMatchObject({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      startTimeUnixNano: '1700000000123456789',
      endTimeUnixNano: '1700000001000000001',
      kind: 1,
      status: { code: 2, message: 'boom' },
    });
    expect(out?.attributes).toEqual([
      { key: 'a.string', value: { stringValue: 'x' } },
      { key: 'a.int', value: { intValue: '7' } },
      { key: 'a.double', value: { doubleValue: 1.5 } },
      { key: 'a.bool', value: { boolValue: true } },
    ]);
    expect(JSON.stringify(body)).not.toContain('"parentSpanId":null');
  });

  it('round-trips through the decoder, with a root span and nested attributes', () => {
    const spans = [
      span(),
      span({
        spanId: 'd'.repeat(16),
        parentSpanId: 'b'.repeat(16),
        attributes: { list: ['a', 1, false], nested: { k: 'v' } },
        status: 'ok',
      }),
    ];
    expect(
      decodeOtlp('traces', JSON.parse(JSON.stringify(encodeOtlp('traces', spans)))).spans,
    ).toEqual(spans);
  });

  it('groups by resource and adds the correlation ids as attributes', () => {
    const body = encodeOtlp('traces', [
      span({ sessionId: 's1', playId: 'p1' }),
      span({ spanId: 'e'.repeat(16), resource: { 'service.name': 'claude-code' } }),
      span({ spanId: 'f'.repeat(16) }),
    ]) as { resourceSpans: { scopeSpans: { spans: { attributes: unknown[] }[] }[] }[] };
    expect(body.resourceSpans).toHaveLength(2);
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(2);
    const attributes = body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes;
    expect(attributes).toContainEqual({
      key: 'otheater.session_id',
      value: { stringValue: 's1' },
    });
    expect(attributes).toContainEqual({ key: 'otheater.play_id', value: { stringValue: 'p1' } });
  });

  it('leaves null attributes out and writes a non-finite number as text', () => {
    const body = encodeOtlp('traces', [
      span({ attributes: { gone: null, inf: Number.POSITIVE_INFINITY } }),
    ]) as { resourceSpans: { scopeSpans: { spans: { attributes: unknown[] }[] }[] }[] };
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes).toEqual([
      { key: 'inf', value: { stringValue: 'Infinity' } },
    ]);
  });
});

describe('encodeOtlp: metrics', () => {
  it('groups points under their metric and keeps the temporality', () => {
    const body = encodeOtlp('metrics', [
      point({ name: 'temp' }),
      point({
        name: 'tokens',
        unit: '{token}',
        kind: 'sum',
        startTimeUnixNano: 10n,
        value: 7,
        detail: { aggregationTemporality: 1, isMonotonic: true },
        attributes: { type: 'input' },
      }),
      point({
        name: 'tokens',
        unit: '{token}',
        kind: 'sum',
        startTimeUnixNano: 10n,
        value: 3,
        detail: { aggregationTemporality: 1, isMonotonic: true },
        attributes: { type: 'output' },
      }),
      point({ name: 'plain', kind: 'sum', startTimeUnixNano: 1n }),
    ]) as {
      resourceMetrics: { scopeMetrics: { metrics: Record<string, unknown>[] }[] }[];
    };
    const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
    expect(metrics.map((metric) => metric.name)).toEqual(['temp', 'tokens', 'plain']);
    const tokens = metrics[1]?.sum as { dataPoints: unknown[]; aggregationTemporality: number };
    expect(tokens.dataPoints).toHaveLength(2);
    expect(tokens).toMatchObject({ aggregationTemporality: 1, isMonotonic: true });
    expect(metrics[2]?.sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: false });
    expect(metrics[0]?.gauge).toBeDefined();
  });

  it('round-trips gauge, sum and histogram points through the decoder', () => {
    const points = [
      point({ name: 'temp', value: 2.5 }),
      point({
        name: 'tokens',
        unit: '{token}',
        kind: 'sum',
        startTimeUnixNano: 10n,
        value: 7,
        detail: { aggregationTemporality: 2, isMonotonic: true },
        attributes: { type: 'input' },
      }),
      point({
        name: 'latency',
        unit: 'ms',
        kind: 'histogram',
        startTimeUnixNano: 1n,
        value: 12,
        detail: {
          count: 3,
          min: 1,
          max: 8,
          bucketCounts: [1, 2],
          explicitBounds: [5],
          aggregationTemporality: 1,
        },
      }),
    ];
    const decoded = decodeOtlp(
      'metrics',
      JSON.parse(JSON.stringify(encodeOtlp('metrics', points))),
    ).metrics;
    expect(decoded).toHaveLength(3);
    expect(decoded).toEqual(expect.arrayContaining(points));
  });
});

describe('encodeOtlp: logs', () => {
  it('round-trips a record and leaves out what it does not have', () => {
    const logs: TelemetryLogRecord[] = [
      {
        ...NONE,
        timeUnixNano: 99n,
        severity: 9,
        severityText: 'INFO',
        body: 'hello',
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        attributes: { k: 'v' },
        resource: RESOURCE,
      },
      {
        ...NONE,
        timeUnixNano: 100n,
        severity: null,
        severityText: null,
        body: null,
        traceId: null,
        spanId: null,
        attributes: {},
        resource: RESOURCE,
      },
    ];
    const body = JSON.parse(JSON.stringify(encodeOtlp('logs', logs))) as {
      resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[];
    };
    expect(body.resourceLogs[0]?.scopeLogs[0]?.logRecords[1]).toEqual({
      timeUnixNano: '100',
      attributes: [],
    });
    expect(decodeOtlp('logs', body).logs).toEqual(logs);
  });
});
