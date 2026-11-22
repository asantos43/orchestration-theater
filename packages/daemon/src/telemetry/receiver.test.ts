// SPDX-License-Identifier: MPL-2.0
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { TelemetryBatch } from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { RECEIVER_HOST, TelemetryReceiver, type TelemetryReceiverOptions } from './receiver.js';
import { Redactor } from './redaction.js';
import { sessionSpanId, traceIdForPlay } from './span-ids.js';
import { TelemetrySessions } from './sessions.js';

// The receiver binds the loopback only; every request here goes to 127.0.0.1.

const TOKEN = 'test-token-0123456789';

interface Recorded {
  readonly type: string;
  readonly payload: unknown;
}

function sink(): SituationSink & { readonly seen: Recorded[] } {
  const seen: Recorded[] = [];
  return {
    seen,
    record(type, payload) {
      seen.push({ type, payload });
    },
  };
}

function store(): {
  write(batch: TelemetryBatch): { accepted: number; dropped: number };
  batches: TelemetryBatch[];
} {
  const batches: TelemetryBatch[] = [];
  return {
    batches,
    write(batch) {
      batches.push(batch);
      return { accepted: 1, dropped: 0 };
    },
  };
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  options: {
    readonly path?: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: Buffer | string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: RECEIVER_HOST,
        port,
        path: options.path ?? '/v1/logs',
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    // A 413 may close the connection while the rest of a big body is still being written.
    req.on('error', reject);
    req.end(options.body);
  });
}

const LOGS = {
  resourceLogs: [
    {
      resource: { attributes: [{ key: 'otheater.play_id', value: { stringValue: 'play-1' } }] },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '10',
              body: { stringValue: 'tool_call' },
              attributes: [
                { key: 'user.email', value: { stringValue: 'someone@example.invalid' } },
                { key: 'session.id', value: { stringValue: 's1' } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function json(token: string | null = TOKEN): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  };
}

const running: TelemetryReceiver[] = [];

async function start(
  extra: Partial<Omit<TelemetryReceiverOptions, 'token'>> & { token?: string | null } = {},
): Promise<{
  receiver: TelemetryReceiver;
  records: ReturnType<typeof store>;
  situations: ReturnType<typeof sink>;
  sessions: TelemetrySessions;
}> {
  const records = store();
  const situations = sink();
  const sessions = new TelemetrySessions();
  const { token = TOKEN, ...rest } = extra;
  const receiver = await TelemetryReceiver.start({
    store: records,
    sessions,
    redactor: new Redactor({ mode: 'default' }),
    port: 'auto',
    maxBody: 64 * 1024,
    ...(token === null ? {} : { token }),
    logger: createSilentLogger(),
    situations,
    windowMs: 3_600_000,
    ...rest,
  });
  running.push(receiver);
  return { receiver, records, situations, sessions };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((receiver) => receiver.stop()));
});

describe('TelemetryReceiver: start', () => {
  it('listens on the loopback with a port of its own and tells it (receiver_started)', async () => {
    const { receiver, situations } = await start();
    expect(receiver.url).toBe(`http://127.0.0.1:${String(receiver.port)}`);
    expect(receiver.port).toBeGreaterThan(0);
    expect(situations.seen[0]).toEqual({
      type: 'telemetry.receiver_started',
      payload: { port: receiver.port },
    });
    // Not reachable by a name that is not the loopback's own.
    const reply = await send(receiver.port, {
      headers: { ...json(), host: 'example.invalid' },
      body: JSON.stringify(LOGS),
    });
    expect(reply.status).toBe(403);
  });

  it('generates a token for each start when none is given, and never prints it', async () => {
    const first = await start({ token: null });
    const second = await start({ token: null });
    expect(first.receiver.token).not.toBe(second.receiver.token);
    expect(first.receiver.token.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(first.situations.seen)).not.toContain(first.receiver.token);
  });

  it('refuses a fixed port that is taken, without opening anything else', async () => {
    const { receiver } = await start();
    await expect(start({ port: receiver.port })).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });
});

describe('TelemetryReceiver: accepted', () => {
  it('takes plain JSON, correlates it by the session table and redacts it', async () => {
    const { receiver, records, sessions } = await start();
    sessions.open({
      sessionId: 's1',
      client: 'fake',
      profile: 'p1',
      scenarioId: 'sc-1',
      playId: 'play-1',
      stageId: 'stage-a',
      attemptId: 'play-1/stage-a/1',
    });
    const reply = await send(receiver.port, { headers: json(), body: JSON.stringify(LOGS) });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({});
    expect(records.batches).toHaveLength(1);
    const [record] = records.batches[0]?.logs ?? [];
    expect(record).toMatchObject({
      sessionId: 's1',
      attemptId: 'play-1/stage-a/1',
      scenarioId: 'sc-1',
      playId: 'play-1',
      body: 'tool_call',
    });
    expect(record?.attributes['user.email']).toBeUndefined();
    expect(record?.attributes['otheater.redacted']).toEqual(['user.email']);
  });

  it('takes a gzip body', async () => {
    const { receiver, records } = await start();
    const reply = await send(receiver.port, {
      headers: { ...json(), 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify(LOGS)),
    });
    expect(reply.status).toBe(200);
    expect(records.batches).toHaveLength(1);
  });

  it('answers the three paths and treats an empty request as accepted', async () => {
    const { receiver, records } = await start();
    for (const path of ['/v1/traces', '/v1/metrics', '/v1/logs']) {
      const reply = await send(receiver.port, { path, headers: json(), body: '{}' });
      expect(reply.status, path).toBe(200);
    }
    expect(records.batches).toHaveLength(3);
  });

  it('accepts a content type with a charset', async () => {
    const { receiver } = await start();
    const reply = await send(receiver.port, {
      headers: { ...json(), 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    expect(reply.status).toBe(200);
  });
});

/** A client trace of two spans (a root and its child), the child first, as a batch processor sends it. */
function clientTrace(sessionId: string): unknown {
  const common = {
    traceId: 'c'.repeat(32),
    kind: 1,
    startTimeUnixNano: '10',
    endTimeUnixNano: '20',
    attributes: [{ key: 'session.id', value: { stringValue: sessionId } }],
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              { ...common, spanId: '2'.repeat(16), parentSpanId: '1'.repeat(16), name: 'tool' },
              { ...common, spanId: '1'.repeat(16), name: 'turn' },
            ],
          },
        ],
      },
    ],
  };
}

const KNOWN = {
  sessionId: 's1',
  client: 'fake',
  profile: 'p1',
  scenarioId: 'sc-1',
  playId: 'play-1',
  stageId: 'stage-a',
  attemptId: 'play-1/stage-a/1',
} as const;

describe('TelemetryReceiver: one tree (Phase 9, P1)', () => {
  async function post(reparent: 'session' | 'off' | undefined, sessionId: string) {
    const { receiver, records, sessions } = await start(reparent === undefined ? {} : { reparent });
    sessions.open(KNOWN);
    const reply = await send(receiver.port, {
      path: '/v1/traces',
      headers: json(),
      body: JSON.stringify(clientTrace(sessionId)),
    });
    expect(reply.status).toBe(200);
    return records.batches[0]?.spans ?? [];
  }

  it('puts the spans of a known session under its span, in the trace of the daemon', async () => {
    for (const mode of ['session', undefined] as const) {
      const spans = await post(mode, 's1');
      const turn = spans.find((span) => span.name === 'turn');
      const tool = spans.find((span) => span.name === 'tool');
      expect(turn).toMatchObject({
        traceId: traceIdForPlay('play-1'),
        parentSpanId: sessionSpanId('s1'),
        sessionId: 's1',
      });
      // The hierarchy of the client is its own: the child still hangs from the root.
      expect(tool).toMatchObject({
        traceId: traceIdForPlay('play-1'),
        parentSpanId: '1'.repeat(16),
      });
      expect(turn?.attributes['otheater.client.trace_id']).toBe('c'.repeat(32));
      expect(tool?.attributes['otheater.client.parent_span_id']).toBe('1'.repeat(16));
    }
  });

  it('with reparent: off stores them as they came', async () => {
    const spans = await post('off', 's1');
    const turn = spans.find((span) => span.name === 'turn');
    expect(turn).toMatchObject({ traceId: 'c'.repeat(32), parentSpanId: null, sessionId: 's1' });
    expect(turn?.attributes['otheater.client.trace_id']).toBeUndefined();
    expect(spans.find((span) => span.name === 'tool')?.parentSpanId).toBe('1'.repeat(16));
  });

  it('does not touch the spans of a session it does not know', async () => {
    const spans = await post('session', 'someone-elses');
    for (const span of spans) {
      expect(span.traceId).toBe('c'.repeat(32));
      expect(span.sessionId).toBeNull();
      expect(span.attributes['otheater.client.trace_id']).toBeUndefined();
    }
    expect(spans.find((span) => span.name === 'turn')?.parentSpanId).toBeNull();
  });
});

describe('TelemetryReceiver: refused', () => {
  it('401 for a wrong token and for no token, and nothing is stored', async () => {
    const { receiver, records } = await start();
    for (const token of ['wrong-token', null]) {
      const reply = await send(receiver.port, {
        headers: json(token),
        body: JSON.stringify(LOGS),
      });
      expect(reply.status).toBe(401);
    }
    const malformed = await send(receiver.port, {
      headers: { ...json(null), authorization: TOKEN },
      body: '{}',
    });
    expect(malformed.status).toBe(401);
    expect(records.batches).toHaveLength(0);
  });

  it('403 for a request with an Origin (a page in a browser), even with the token', async () => {
    const { receiver, records } = await start();
    const reply = await send(receiver.port, {
      headers: { ...json(), origin: 'http://example.invalid' },
      body: JSON.stringify(LOGS),
    });
    expect(reply.status).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    expect(records.batches).toHaveLength(0);
  });

  it('415 for a protobuf body', async () => {
    const { receiver, records } = await start();
    const reply = await send(receiver.port, {
      headers: { ...json(), 'content-type': 'application/x-protobuf' },
      body: Buffer.from([0x0a, 0x02, 0x08, 0x01]),
    });
    expect(reply.status).toBe(415);
    expect(records.batches).toHaveLength(0);
  });

  it('415 for an encoding other than gzip', async () => {
    const { receiver } = await start();
    const reply = await send(receiver.port, {
      headers: { ...json(), 'content-encoding': 'br' },
      body: '{}',
    });
    expect(reply.status).toBe(415);
  });

  it('413 for a body larger than max_body, announced or not', async () => {
    const { receiver, records } = await start({ maxBody: 1024 });
    const big = JSON.stringify({ pad: 'x'.repeat(4096) });
    const announced = await send(receiver.port, { headers: json(), body: big });
    expect(announced.status).toBe(413);
    // No Content-Length: a chunked request is counted as it arrives.
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: RECEIVER_HOST,
          port: receiver.port,
          path: '/v1/logs',
          method: 'POST',
          headers: { ...json(), 'transfer-encoding': 'chunked' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(big.slice(0, 2048));
      req.write(big.slice(2048));
      req.end();
    });
    expect(chunked).toBe(413);
    expect(records.batches).toHaveLength(0);
  });

  it('413 for a small gzip that is large once unzipped', async () => {
    const { receiver } = await start({ maxBody: 1024 });
    const bomb = gzipSync(JSON.stringify({ pad: 'x'.repeat(200_000) }));
    expect(bomb.length).toBeLessThan(1024);
    const reply = await send(receiver.port, {
      headers: { ...json(), 'content-encoding': 'gzip' },
      body: bomb,
    });
    expect(reply.status).toBe(413);
  });

  it('400 for invalid JSON, a bad gzip and a body that is not an OTLP request', async () => {
    const { receiver } = await start();
    expect((await send(receiver.port, { headers: json(), body: '{not json' })).status).toBe(400);
    expect(
      (
        await send(receiver.port, {
          headers: { ...json(), 'content-encoding': 'gzip' },
          body: 'plainly not gzip',
        })
      ).status,
    ).toBe(400);
    expect((await send(receiver.port, { headers: json(), body: '[]' })).status).toBe(400);
  });

  it('404 for another path and 405 for another method', async () => {
    const { receiver } = await start();
    expect(
      (await send(receiver.port, { path: '/v1/other', headers: json(), body: '{}' })).status,
    ).toBe(404);
    const get = await send(receiver.port, { method: 'GET', headers: json() });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
  });
});

describe('TelemetryReceiver: events', () => {
  it('tells the refused batches by reason, aggregated, with no content and no token', async () => {
    const { receiver, situations } = await start({ maxBody: 1024 });
    await send(receiver.port, { headers: json('bad'), body: '{}' });
    await send(receiver.port, { headers: json('bad'), body: '{}' });
    await send(receiver.port, {
      headers: { ...json(), 'content-type': 'application/x-protobuf' },
      body: 'x',
    });
    await send(receiver.port, {
      path: '/v1/traces',
      headers: json(),
      body: JSON.stringify({ pad: 'y'.repeat(4096) }),
    });
    receiver.flushSituations();
    const rejected = situations.seen
      .filter((item) => item.type === 'telemetry.batch_rejected')
      .map((item) => item.payload);
    expect(rejected).toEqual(
      expect.arrayContaining([
        { reason: 'token', signal: 'logs', count: 2 },
        { reason: 'format', signal: 'logs', count: 1 },
        { reason: 'size', signal: 'traces', count: 1 },
      ]),
    );
    expect(rejected).toHaveLength(3);
    expect(JSON.stringify(situations.seen)).not.toContain(TOKEN);
    // Told once: the window starts again.
    receiver.flushSituations();
    expect(situations.seen.filter((item) => item.type === 'telemetry.batch_rejected')).toHaveLength(
      3,
    );
  });

  it('counts the batches taken and refused since the start, and the windows do not clear it (P10)', async () => {
    const { receiver } = await start({ maxBody: 1024 });
    expect(receiver.stats).toEqual({
      accepted: { traces: 0, metrics: 0, logs: 0 },
      rejected: { format: 0, size: 0, token: 0 },
    });
    await send(receiver.port, { headers: json(), body: JSON.stringify(LOGS) });
    await send(receiver.port, { path: '/v1/traces', headers: json(), body: '{}' });
    await send(receiver.port, { headers: json('bad'), body: '{}' });
    await send(receiver.port, {
      headers: { ...json(), 'content-type': 'application/x-protobuf' },
      body: 'x',
    });
    await send(receiver.port, {
      path: '/v1/traces',
      headers: json(),
      body: JSON.stringify({ pad: 'y'.repeat(4096) }),
    });
    receiver.flushSituations();
    expect(receiver.stats).toEqual({
      accepted: { traces: 1, metrics: 0, logs: 1 },
      rejected: { format: 1, size: 1, token: 1 },
    });
  });

  it('tells what the redaction removed, by name, aggregated (telemetry.redacted)', async () => {
    const { receiver, situations } = await start();
    await send(receiver.port, { headers: json(), body: JSON.stringify(LOGS) });
    await send(receiver.port, { headers: json(), body: JSON.stringify(LOGS) });
    receiver.flushSituations();
    const redacted = situations.seen.filter((item) => item.type === 'telemetry.redacted');
    expect(redacted).toEqual([
      {
        type: 'telemetry.redacted',
        payload: { mode: 'default', count: 2, records: 2, names: ['user.email'] },
      },
    ]);
    expect(JSON.stringify(redacted)).not.toContain('example.invalid');
  });

  it('tells the last window when it stops', async () => {
    const { receiver, situations } = await start();
    await send(receiver.port, { headers: json('bad'), body: '{}' });
    await receiver.stop();
    await receiver.stop();
    expect(situations.seen.filter((item) => item.type === 'telemetry.batch_rejected')).toHaveLength(
      1,
    );
  });

  it('stops listening', async () => {
    const { receiver } = await start();
    const { port } = receiver;
    await receiver.stop();
    await expect(send(port, { headers: json(), body: '{}' })).rejects.toThrow();
  });
});
