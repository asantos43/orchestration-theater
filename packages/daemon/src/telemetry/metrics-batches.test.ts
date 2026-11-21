// SPDX-License-Identifier: MPL-2.0
import { request as httpRequest } from 'node:http';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { EventMetrics } from './metrics-events.js';
import { MetricsCollector } from './metrics.js';
import { RECEIVER_HOST, TelemetryReceiver } from './receiver.js';
import { Redactor } from './redaction.js';
import { TelemetrySessions } from './sessions.js';

/**
 * The batches the receiver refused, by reason, as `GET /metrics` shows them (Phase 9, P2; N225 (3)):
 * a real receiver on the loopback, refusing for each reason, and the collector reading its `stats`.
 */

const TOKEN = 'test-token-0123456789';

function post(
  port: number,
  headers: Record<string, string>,
  body: string,
  path = '/v1/logs',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: RECEIVER_HOST, port, path, method: 'POST', headers },
      (response) => {
        response.resume();
        response.on('end', () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const running: TelemetryReceiver[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((receiver) => receiver.stop()));
});

async function rig() {
  const receiver = await TelemetryReceiver.start({
    store: { write: () => ({ accepted: 1, dropped: 0 }) },
    sessions: new TelemetrySessions(),
    redactor: new Redactor({ mode: 'default' }),
    port: 'auto',
    maxBody: 1024,
    token: TOKEN,
    logger: createSilentLogger(),
    situations: {
      record: () => {
        // Nothing here reads the events of the receiver.
      },
    },
    windowMs: 3_600_000,
  });
  running.push(receiver);
  const collector = new MetricsCollector({
    clock: new FakeClock(1_800_000_000_000),
    store: {
      quotaSnapshots: { list: () => Promise.resolve([]) },
      usage: { list: () => Promise.resolve([]) },
      promptQueue: { list: () => Promise.resolve([]) },
    } as never,
    pool: () => undefined,
    events: new EventMetrics(),
    receiver: () => receiver.stats,
    cacheTtl: 0,
    logger: createSilentLogger(),
  });
  const json = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  return { receiver, collector, json };
}

const line = (text: string, reason: string): string | undefined =>
  text
    .split('\n')
    .find((row) => row.startsWith(`otheater_telemetry_batches_rejected_total{reason="${reason}"}`));

describe('otheater_telemetry_batches_rejected_total', () => {
  it('starts at zero for every reason', async () => {
    const { collector } = await rig();
    const text = await collector.render();
    for (const reason of ['format', 'size', 'token']) {
      expect(line(text, reason)).toMatch(/ 0$/u);
    }
  });

  it('counts each reason as the receiver refuses, and what it takes is not counted', async () => {
    const { receiver, collector, json } = await rig();
    // token: twice, one without the header and one with a wrong token
    await post(receiver.port, { 'content-type': 'application/json' }, '{}');
    await post(receiver.port, { ...json, authorization: 'Bearer wrong' }, '{}');
    // format: a content type that is not JSON, and a body that is not JSON
    await post(receiver.port, { ...json, 'content-type': 'application/x-protobuf' }, 'x');
    await post(receiver.port, json, 'not json');
    await post(receiver.port, json, '{}', '/v1/unknown');
    // size: a body over `max_body`
    await post(receiver.port, json, JSON.stringify({ pad: 'y'.repeat(4096) }));
    // accepted: not in this counter
    await post(receiver.port, json, JSON.stringify({ resourceLogs: [] }));
    const text = await collector.render();
    expect(line(text, 'token')).toMatch(/ 2$/u);
    expect(line(text, 'format')).toMatch(/ 3$/u);
    expect(line(text, 'size')).toMatch(/ 1$/u);
    // The counters of the text are the `stats` of the receiver, the same that `GET /v1/telemetry` shows.
    expect(receiver.stats.rejected).toEqual({ format: 3, size: 1, token: 2 });
  });
});
