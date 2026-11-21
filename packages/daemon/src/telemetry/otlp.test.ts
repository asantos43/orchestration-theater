// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { decodeOtlp, OtlpDecodeError } from './otlp.js';

// Reduced fixtures: the shape of the OTLP/JSON a client sends, with made-up values only.
const RESOURCE = {
  attributes: [
    { key: 'service.name', value: { stringValue: 'fake-client' } },
    { key: 'otheater.play_id', value: { stringValue: 'play-1' } },
  ],
};
const TRACE_ID = 'ABCDEF0123456789ABCDEF0123456789';
const SPAN_ID = '0123456789abcdef';

function tracesBody(span: Record<string, unknown>): unknown {
  return {
    resourceSpans: [{ resource: RESOURCE, scopeSpans: [{ spans: [span] }] }],
  };
}

describe('decodeOtlp: traces', () => {
  it('turns a span into the record of the port, with no correlation', () => {
    const batch = decodeOtlp(
      'traces',
      tracesBody({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        parentSpanId: '0000000000000000',
        name: 'fake.turn',
        kind: 'SPAN_KIND_CLIENT',
        startTimeUnixNano: '1700000000000000001',
        endTimeUnixNano: 1700000001000000000,
        status: { code: 2, message: 'boom' },
        attributes: [
          { key: 'n', value: { intValue: '42' } },
          { key: 'big', value: { intValue: '9223372036854775807' } },
          { key: 'ratio', value: { doubleValue: 0.5 } },
          { key: 'ok', value: { boolValue: true } },
          { key: 'name', value: { stringValue: 'x' } },
          {
            key: 'list',
            value: { arrayValue: { values: [{ stringValue: 'a' }, { intValue: 1 }] } },
          },
          {
            key: 'map',
            value: { kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } },
          },
        ],
      }),
    );
    expect(batch.spans).toHaveLength(1);
    const [span] = batch.spans ?? [];
    expect(span).toMatchObject({
      traceId: TRACE_ID.toLowerCase(),
      spanId: SPAN_ID,
      parentSpanId: null,
      name: 'fake.turn',
      kind: 3,
      startTimeUnixNano: 1700000000000000001n,
      endTimeUnixNano: 1700000001000000000n,
      status: 'error',
      statusMessage: 'boom',
      scenarioId: null,
      playId: null,
      attemptId: null,
      sessionId: null,
      resource: { 'service.name': 'fake-client', 'otheater.play_id': 'play-1' },
      attributes: {
        n: 42,
        // A 64-bit integer a double cannot hold stays as text, never rounded.
        big: '9223372036854775807',
        ratio: 0.5,
        ok: true,
        name: 'x',
        list: ['a', 1],
        map: { k: 'v' },
      },
    });
  });

  it('accepts a numeric kind and status, and an unset status', () => {
    const batch = decodeOtlp(
      'traces',
      tracesBody({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        name: 's',
        kind: 2,
        startTimeUnixNano: '1',
        endTimeUnixNano: '2',
        status: { code: 1 },
      }),
    );
    expect(batch.spans?.[0]).toMatchObject({ kind: 2, status: 'ok', statusMessage: null });
  });

  it('refuses an id that is not hex', () => {
    expect(() =>
      decodeOtlp(
        'traces',
        tracesBody({
          traceId: 'not-hex',
          spanId: SPAN_ID,
          name: 's',
          startTimeUnixNano: '1',
          endTimeUnixNano: '2',
        }),
      ),
    ).toThrow(OtlpDecodeError);
  });

  it('refuses a time that is not a number', () => {
    expect(() =>
      decodeOtlp(
        'traces',
        tracesBody({
          traceId: TRACE_ID,
          spanId: SPAN_ID,
          name: 's',
          startTimeUnixNano: 'yesterday',
          endTimeUnixNano: '2',
        }),
      ),
    ).toThrow(OtlpDecodeError);
  });

  it('treats an empty request as an empty batch and refuses what is not a request', () => {
    expect(decodeOtlp('traces', {})).toEqual({ spans: [] });
    expect(() => decodeOtlp('traces', [])).toThrow(OtlpDecodeError);
    expect(() => decodeOtlp('traces', 'text')).toThrow(OtlpDecodeError);
    expect(() => decodeOtlp('traces', { resourceSpans: 3 })).toThrow(OtlpDecodeError);
  });
});

describe('decodeOtlp: metrics', () => {
  it('reads gauge, sum and histogram points', () => {
    const batch = decodeOtlp('metrics', {
      resourceMetrics: [
        {
          resource: RESOURCE,
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'tokens',
                  unit: '{token}',
                  sum: {
                    dataPoints: [
                      {
                        startTimeUnixNano: '10',
                        timeUnixNano: '20',
                        asInt: '7',
                        attributes: [{ key: 'type', value: { stringValue: 'input' } }],
                      },
                    ],
                  },
                },
                { name: 'temp', gauge: { dataPoints: [{ timeUnixNano: '30', asDouble: 1.5 }] } },
                {
                  name: 'latency',
                  unit: 'ms',
                  histogram: {
                    dataPoints: [
                      {
                        startTimeUnixNano: '1',
                        timeUnixNano: '2',
                        count: '3',
                        sum: 12,
                        min: 1,
                        max: 8,
                        bucketCounts: ['1', '2'],
                        explicitBounds: [5],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(batch.metrics).toHaveLength(3);
    expect(batch.metrics?.[0]).toMatchObject({
      name: 'tokens',
      unit: '{token}',
      kind: 'sum',
      value: 7,
      timeUnixNano: 20n,
      startTimeUnixNano: 10n,
      attributes: { type: 'input' },
      detail: null,
    });
    expect(batch.metrics?.[1]).toMatchObject({
      name: 'temp',
      kind: 'gauge',
      value: 1.5,
      unit: null,
      startTimeUnixNano: null,
    });
    expect(batch.metrics?.[2]).toMatchObject({
      name: 'latency',
      kind: 'histogram',
      value: 12,
      detail: { count: 3, min: 1, max: 8, bucketCounts: [1, 2], explicitBounds: [5] },
    });
  });

  it('refuses a data point with a bad value type', () => {
    expect(() =>
      decodeOtlp('metrics', {
        resourceMetrics: [
          { scopeMetrics: [{ metrics: [{ name: 'm', sum: { dataPoints: [{ asInt: 'x' }] } }] }] },
        ],
      }),
    ).toThrow(OtlpDecodeError);
  });
});

describe('decodeOtlp: logs', () => {
  it('reads a record with a text body, its severity and its ids', () => {
    const batch = decodeOtlp('logs', {
      resourceLogs: [
        {
          resource: RESOURCE,
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '5',
                  severityNumber: 'SEVERITY_NUMBER_INFO2',
                  severityText: 'INFO',
                  body: { stringValue: 'tool_call' },
                  traceId: TRACE_ID,
                  spanId: '0000000000000000',
                  attributes: [{ key: 'tool', value: { stringValue: 'read' } }],
                },
                { observedTimeUnixNano: '6', severityNumber: 17, body: { intValue: '3' } },
              ],
            },
          ],
        },
      ],
    });
    expect(batch.logs).toHaveLength(2);
    expect(batch.logs?.[0]).toMatchObject({
      timeUnixNano: 5n,
      severity: 10,
      severityText: 'INFO',
      body: 'tool_call',
      traceId: TRACE_ID.toLowerCase(),
      spanId: null,
      attributes: { tool: 'read' },
    });
    expect(batch.logs?.[1]).toMatchObject({ timeUnixNano: 6n, severity: 17, body: '3' });
  });

  it('keeps a structured body as its JSON text', () => {
    const batch = decodeOtlp('logs', {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1',
                  body: { kvlistValue: { values: [{ key: 'a', value: { intValue: 1 } }] } },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(batch.logs?.[0]?.body).toBe('{"a":1}');
  });

  it('caps the depth of a nested value', () => {
    let value: unknown = { stringValue: 'deep' };
    for (let level = 0; level < 20; level += 1) {
      value = { arrayValue: { values: [value] } };
    }
    const batch = decodeOtlp('logs', {
      resourceLogs: [
        {
          scopeLogs: [{ logRecords: [{ timeUnixNano: '1', attributes: [{ key: 'k', value }] }] }],
        },
      ],
    });
    expect(JSON.stringify(batch.logs?.[0]?.attributes)).not.toContain('deep');
  });
});
