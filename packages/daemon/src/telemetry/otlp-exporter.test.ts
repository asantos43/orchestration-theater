// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-non-null-assertion -- the tests look up the requests they just provoked */
import { gunzipSync } from 'node:zlib';
import { Cancelled, Secret, type Clock, type TelemetrySpan } from '@otheater/core';
import { InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { DaemonConfigSchema } from '../config.js';
import { createSilentLogger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { MemoryTelemetryStore } from './telemetry-fixture.js';
import {
  OtlpExporter,
  destinationOf,
  exportCursorName,
  signalUrl,
  type OtlpExporterConfig,
} from './otlp-exporter.js';

const NONE = { scenarioId: null, playId: null, attemptId: null, sessionId: null } as const;
const TIMEOUT_MS = 9_999;
const INTERVAL_MS = 5_000;

function span(index: number): TelemetrySpan {
  return {
    ...NONE,
    traceId: 'a'.repeat(32),
    spanId: index.toString(16).padStart(16, '0'),
    parentSpanId: null,
    name: `op-${String(index)}`,
    kind: 1,
    startTimeUnixNano: 1_700_000_000_000_000_000n + BigInt(index),
    endTimeUnixNano: 1_700_000_001_000_000_000n + BigInt(index),
    status: 'unset',
    statusMessage: null,
    attributes: {},
    resource: { 'service.name': 'otheater' },
  };
}

/** A clock whose waits end at once (and are written down), except the timeout, which waits for a test. */
class TestClock implements Clock {
  t = 1_000_000;
  readonly delays: number[] = [];
  fireTimeout = false;

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // The interval waits for a stop (a wait that ends at once would never let the loop breathe).
    if (ms === INTERVAL_MS || (ms === TIMEOUT_MS && !this.fireTimeout)) {
      return new Promise((_resolve, reject) => {
        const fail = (): void => {
          reject(new Cancelled('cancelled', { cause: signal?.reason }));
        };
        if (signal?.aborted === true) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      });
    }
    if (ms !== TIMEOUT_MS) this.delays.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}

interface Request {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

type Answer = number | 'throw' | 'hang';

function rig(
  over: {
    otlp?: Record<string, unknown>;
    answers?: Answer[];
    secrets?: Record<string, string>;
  } = {},
) {
  const config: OtlpExporterConfig = DaemonConfigSchema.parse({
    telemetry: {
      export: 'otlp',
      otlp: {
        endpoint: 'https://collector.example.test:4318/base/?token=nope',
        headers: { Authorization: 'otlp/token' },
        timeout: '9999ms',
        interval: '5s',
        batch: 2,
        ...over.otlp,
      },
    },
  }).telemetry.otlp;
  const store = new MemoryTelemetryStore();
  const vault = new InMemorySecretVault();
  const clock = new TestClock();
  const requests: Request[] = [];
  const events: { type: string; payload: unknown }[] = [];
  const warnings: unknown[] = [];
  const answers = over.answers ?? [];
  const situations: SituationSink = {
    record(type, payload) {
      events.push({ type, payload });
    },
  };
  const logger = {
    ...createSilentLogger(),
    warn: (fields: unknown) => {
      warnings.push(fields);
    },
    debug: () => undefined,
  };
  const fakeFetch = ((url: string, init: RequestInit) => {
    const answer: Answer = answers.length > 1 ? (answers.shift() ?? 200) : (answers[0] ?? 200);
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body as Uint8Array,
    });
    if (answer === 'throw') return Promise.reject(new TypeError('fetch failed'));
    if (answer === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    }
    return Promise.resolve(new Response(null, { status: answer }));
  }) as unknown as typeof fetch;
  const exporter = new OtlpExporter({
    telemetry: store,
    config,
    vault,
    clock,
    logger: logger as never,
    situations,
    fetch: fakeFetch,
  });
  return { exporter, store, vault, clock, requests, events, warnings, config };
}

function text(request: Request): string {
  const body = request.body;
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
}

describe('OtlpExporter', () => {
  it('builds the URL of a signal and the destination without path, query or user info', () => {
    expect(signalUrl('https://c.test:4318/base/', 'traces')).toBe(
      'https://c.test:4318/base/v1/traces',
    );
    expect(signalUrl('http://127.0.0.1:4318', 'logs')).toBe('http://127.0.0.1:4318/v1/logs');
    expect(destinationOf('https://user:pw@c.test:4318/base/?token=x#y')).toBe(
      'https://c.test:4318',
    );
  });

  it('sends the spans in batches with the vault headers and saves the cursor', async () => {
    const r = rig({ answers: [200] });
    await r.vault.set('otlp/token', new Secret('Bearer top-secret'));
    r.store.write({ spans: [span(1), span(2), span(3), span(4), span(5)] });
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(3);
    expect(r.requests[0]?.url).toBe(
      'https://collector.example.test:4318/base/v1/traces?token=nope',
    );
    expect(r.requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer top-secret',
      'Content-Type': 'application/json',
    });
    const first = JSON.parse(text(r.requests[0]!)) as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
    };
    expect(first.resourceSpans[0]?.scopeSpans[0]?.spans.map((s) => s.name)).toEqual([
      'op-1',
      'op-2',
    ]);
    expect(await r.store.readCursor(exportCursorName('traces'))).toBe(5);
    expect(r.exporter.stats.exported).toBe(5);
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(3);
    r.store.write({ spans: [span(6)] });
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(4);
    expect(r.events).toEqual([]);
  });

  it('sends the three signals to their own paths and leaves out the ones that are off', async () => {
    const r = rig({ otlp: { signals: { logs: 'off' } } });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({
      spans: [span(1)],
      metrics: [
        {
          ...NONE,
          name: 'm',
          unit: null,
          kind: 'gauge',
          timeUnixNano: 1n,
          startTimeUnixNano: null,
          value: 1,
          detail: null,
          attributes: {},
          resource: { 'service.name': 'otheater' },
        },
      ],
      logs: [
        {
          ...NONE,
          timeUnixNano: 1n,
          severity: 9,
          severityText: 'INFO',
          body: 'hi',
          traceId: null,
          spanId: null,
          attributes: {},
          resource: { 'service.name': 'otheater' },
        },
      ],
    });
    await r.exporter.exportOnce();
    expect(r.requests.map((request) => request.url.split('/base')[1]?.split('?')[0])).toEqual([
      '/v1/traces',
      '/v1/metrics',
    ]);
  });

  it('compresses the body with gzip when asked', async () => {
    const r = rig({ otlp: { compression: 'gzip' } });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1)] });
    await r.exporter.exportOnce();
    expect(r.requests[0]?.headers['Content-Encoding']).toBe('gzip');
    const json = gunzipSync(r.requests[0]!.body).toString('utf8');
    expect(JSON.parse(json)).toHaveProperty('resourceSpans');
  });

  it('retries a 503 with the exponential backoff and then goes on', async () => {
    const r = rig({
      answers: [503, 503, 200],
      otlp: { retry: { retries: 3, initial: '1s', max: '30s' } },
    });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1)] });
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(3);
    expect(r.clock.delays).toEqual([1000, 2000]);
    expect(await r.store.readCursor(exportCursorName('traces'))).toBe(1);
    expect(r.events).toEqual([]);
  });

  it('keeps the wait of a fixed backoff and caps the exponential one', async () => {
    const fixed = rig({
      answers: [503],
      otlp: { retry: { retries: 2, backoff: 'fixed', initial: '2s' } },
    });
    await fixed.vault.set('otlp/token', new Secret('t'));
    fixed.store.write({ spans: [span(1)] });
    await fixed.exporter.exportOnce();
    expect(fixed.clock.delays).toEqual([2000, 2000]);
    const capped = rig({
      answers: [503],
      otlp: { retry: { retries: 4, initial: '1s', max: '3s' } },
    });
    await capped.vault.set('otlp/token', new Secret('t'));
    capped.store.write({ spans: [span(1)] });
    await capped.exporter.exportOnce();
    expect(capped.clock.delays).toEqual([1000, 2000, 3000, 3000]);
  });

  it('does not retry an answer that a retry cannot fix', async () => {
    const r = rig({ answers: [401] });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1)] });
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(1);
    expect(r.events).toEqual([
      {
        type: 'telemetry.export_failed',
        payload: {
          destination: 'https://collector.example.test:4318',
          signal: 'traces',
          reason: 'unauthorized',
          status: 401,
          count: 1,
          batches: 1,
          mode: 'drop',
        },
      },
    ]);
  });

  it('drops the batch after the retries, warns, tells the event and goes on', async () => {
    const r = rig({
      answers: ['throw'],
      otlp: { retry: { retries: 1, initial: '1s' }, batch: 5 },
    });
    await r.vault.set('otlp/token', new Secret('Bearer top-secret'));
    r.store.write({ spans: [span(1), span(2)] });
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(2);
    expect(await r.store.readCursor(exportCursorName('traces'))).toBe(2);
    expect(r.exporter.stats.dropped).toEqual({ unreachable: 2 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toEqual({
      type: 'telemetry.export_failed',
      payload: {
        destination: 'https://collector.example.test:4318',
        signal: 'traces',
        reason: 'unreachable',
        status: null,
        count: 2,
        batches: 1,
        mode: 'drop',
      },
    });
    expect(r.warnings).toHaveLength(1);
    const everything = JSON.stringify([r.events, r.warnings]);
    expect(everything).not.toContain('top-secret');
    expect(everything).not.toContain('otlp/token');
    expect(everything).not.toContain('nope');
    expect(everything).not.toContain('/base');
  });

  it('tells a dead destination once per window, with the count of the window', async () => {
    const r = rig({
      answers: [500],
      otlp: { retry: { retries: 0 }, failure_report: '1m', batch: 5 },
    });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1)] });
    await r.exporter.exportOnce();
    r.store.write({ spans: [span(2), span(3)] });
    await r.exporter.exportOnce();
    r.store.write({ spans: [span(4)] });
    await r.exporter.exportOnce();
    expect(r.events).toHaveLength(1);
    r.clock.t += 61_000;
    r.store.write({ spans: [span(5)] });
    await r.exporter.exportOnce();
    expect(r.events.map((event) => (event.payload as { count: number }).count)).toEqual([1, 4]);
    expect((r.events[1]?.payload as { batches: number }).batches).toBe(3);
    expect(r.warnings).toHaveLength(2);
  });

  it('tells what the window still holds when it stops', async () => {
    const r = rig({ answers: [500], otlp: { retry: { retries: 0 }, failure_report: '1h' } });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1)] });
    await r.exporter.exportOnce();
    r.store.write({ spans: [span(2)] });
    await r.exporter.exportOnce();
    expect(r.events).toHaveLength(1);
    await r.exporter.stop();
    expect(r.events).toHaveLength(2);
    expect((r.events[1]?.payload as { count: number }).count).toBe(1);
  });

  it('holds the cursor with on_failure hold and sends the same batch at the next turn', async () => {
    const r = rig({
      answers: [503, 503, 200],
      otlp: { on_failure: 'hold', retry: { retries: 0 } },
    });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1), span(2)] });
    await r.exporter.exportOnce();
    expect(await r.store.readCursor(exportCursorName('traces'))).toBeNull();
    await r.exporter.exportOnce();
    expect(await r.store.readCursor(exportCursorName('traces'))).toBeNull();
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.payload).toMatchObject({ mode: 'hold', count: 2 });
    await r.exporter.exportOnce();
    expect(await r.store.readCursor(exportCursorName('traces'))).toBe(2);
    expect(r.exporter.stats.dropped).toEqual({});
    expect(text(r.requests[2]!)).toBe(text(r.requests[0]!));
  });

  it('sends nothing when a header secret is not in the vault', async () => {
    const r = rig();
    r.store.write({ spans: [span(1)] });
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(0);
    expect(r.events[0]?.payload).toMatchObject({ reason: 'secret_missing', status: null });
  });

  it('calls a request that did not end in time a timeout', async () => {
    const r = rig({ answers: ['hang'], otlp: { retry: { retries: 0 } } });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1)] });
    r.clock.fireTimeout = true;
    await r.exporter.exportOnce();
    expect(r.events[0]?.payload).toMatchObject({ reason: 'timeout' });
  });

  it('tells a base that cannot be read and goes on', async () => {
    const r = rig();
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.readSince = () => Promise.reject(new Error('disk gone'));
    await r.exporter.exportOnce();
    expect(r.requests).toHaveLength(0);
    expect(r.events[0]?.payload).toMatchObject({ reason: 'store_unavailable' });
  });

  it('exports on its own at each interval and stops on request', async () => {
    const r = rig();
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1)] });
    r.exporter.start();
    for (let i = 0; i < 20 && r.requests.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(r.requests).toHaveLength(1);
    await r.exporter.stop();
    const sent = r.requests.length;
    r.store.write({ spans: [span(2)] });
    await r.exporter.exportOnce();
    expect(r.requests.length).toBe(sent);
  });
  it('finish() sends what is left once, with no retry, and holds a batch that fails', async () => {
    const r = rig({ answers: [503], otlp: { retry: { retries: 3 } } });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1), span(2)] });
    await r.exporter.finish();
    expect(r.requests).toHaveLength(1);
    expect(r.clock.delays).toEqual([]);
    expect(await r.store.readCursor(exportCursorName('traces'))).toBeNull();
    expect(r.exporter.stats.dropped).toEqual({});
    // Told as held, whatever on_failure says: the records are still in the base.
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.payload).toMatchObject({ mode: 'hold', count: 2, reason: 'server_error' });
    await r.exporter.stop();
  });

  it('finish() stops at the first failure and takes the batches of a healthy destination', async () => {
    const r = rig({ answers: [200] });
    await r.vault.set('otlp/token', new Secret('t'));
    r.store.write({ spans: [span(1), span(2), span(3)] });
    await r.exporter.finish();
    expect(await r.store.readCursor(exportCursorName('traces'))).toBe(3);
    await r.exporter.stop();
  });
});
