// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  GetPlaySpansQuerySchema,
  getPlaySpans,
  getTelemetryStatus,
  PLAY_SPAN_KINDS,
  PlaySpansSchema,
  TelemetryStatusSchema,
} from './telemetry.js';

describe('the spans of a play (P10)', () => {
  const span = {
    spanId: 'a1',
    parentSpanId: null,
    kind: 'play',
    depth: 0,
    label: '',
    detail: null,
    startMs: 1,
    durationMs: 0,
    status: 'unset',
    attemptId: null,
  };

  it('accepts a tree and refuses a kind or a field the tree does not know', () => {
    const tree = { playId: 'P1', spans: [span], playClosed: true, truncated: false };
    expect(PlaySpansSchema.parse(tree)).toEqual(tree);
    expect(() =>
      PlaySpansSchema.parse({ ...tree, spans: [{ ...span, kind: 'unknown' }] }),
    ).toThrow();
    expect(() => PlaySpansSchema.parse({ ...tree, spans: [{ ...span, extra: 1 }] })).toThrow();
    expect(() =>
      PlaySpansSchema.parse({ ...tree, spans: [{ ...span, durationMs: -1 }] }),
    ).toThrow();
  });

  it('lists every kind of span of the daemon, with `other` for one that is not known yet', () => {
    expect(PLAY_SPAN_KINDS).toEqual([
      'play',
      'stage',
      'attempt',
      'session',
      'tool',
      'wait',
      'other',
    ]);
  });

  it('reads the limit from the query string as a number, between 1 and 5000', () => {
    expect(GetPlaySpansQuerySchema.parse({ limit: '40' })).toEqual({ limit: 40 });
    expect(GetPlaySpansQuerySchema.parse({})).toEqual({});
    expect(() => GetPlaySpansQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => GetPlaySpansQuerySchema.parse({ limit: '5001' })).toThrow();
  });

  it('is a read of the play, answering 404 and 503', () => {
    expect(getPlaySpans.method).toBe('GET');
    expect(getPlaySpans.path).toBe('/v1/plays/:playId/spans');
    expect(Object.keys(getPlaySpans.errors)).toEqual(expect.arrayContaining(['404', '503']));
  });
});

describe('the state of the telemetry (P10)', () => {
  const status = {
    state: 'on',
    daemonSpans: true,
    receiver: {
      port: 4318,
      accepted: { traces: 1, metrics: 0, logs: 0 },
      rejected: { format: 0, size: 0, token: 0 },
    },
    base: {
      state: 'ok',
      queued: 0,
      written: 1,
      droppedOverflow: 0,
      discarded: 0,
      resets: 0,
      fileBytes: null,
    },
    export: { mode: 'off', otlp: null, prometheus: false },
  };

  it('accepts the state with and without a receiver, a base or an exporter', () => {
    expect(TelemetryStatusSchema.parse(status)).toEqual(status);
    const off = { ...status, state: 'off', receiver: null, base: null };
    expect(TelemetryStatusSchema.parse(off)).toEqual(off);
    const exporting = {
      ...status,
      export: {
        mode: 'both',
        otlp: { destination: 'http://127.0.0.1:4317', exported: 3, dropped: { network: 1 } },
        prometheus: true,
      },
    };
    expect(TelemetryStatusSchema.parse(exporting)).toEqual(exporting);
  });

  it('refuses a count below zero, a state or an export mode that is not listed', () => {
    expect(() => TelemetryStatusSchema.parse({ ...status, state: 'broken' })).toThrow();
    expect(() =>
      TelemetryStatusSchema.parse({ ...status, export: { ...status.export, mode: 'udp' } }),
    ).toThrow();
    expect(() =>
      TelemetryStatusSchema.parse({
        ...status,
        receiver: { ...status.receiver, rejected: { format: -1, size: 0, token: 0 } },
      }),
    ).toThrow();
  });

  it('takes no query and no body', () => {
    expect(getTelemetryStatus.method).toBe('GET');
    expect(getTelemetryStatus.path).toBe('/v1/telemetry');
  });
});
