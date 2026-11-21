// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import type { TelemetrySpan } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { PlaySpansSchema, TelemetryStatusSchema } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { createSilentLogger } from '../../logger.js';
import { dataPaths } from '../../paths.js';
import { MemoryTelemetryStore } from '../../telemetry/telemetry-fixture.js';
import { makeTempDataDir, NO_CLIENTS } from '../../test-helpers.js';

/** `GET /v1/plays/:playId/spans` and `GET /v1/telemetry` (P10) against the daemon as it starts. */

let tmp: Awaited<ReturnType<typeof makeTempDataDir>> | undefined;
let daemon: DaemonHandle | undefined;

afterEach(async () => {
  await daemon?.stop();
  await tmp?.dispose();
  daemon = undefined;
  tmp = undefined;
});

async function start(
  telemetry: MemoryTelemetryStore | 'none',
  yaml = 'backup:\n  when: manual\n',
): Promise<string> {
  tmp = await makeTempDataDir();
  const clock = new FakeClock(Date.UTC(2026, 10, 21, 15, 0, 0));
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(yaml),
    overrides: { clock, store: new InMemoryStore({ clock }), telemetry },
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  return (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
}

async function get(path: string, token: string | undefined): Promise<Response> {
  return fetch(`${daemon?.api.url ?? ''}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function seedPlay(id: string): Promise<void> {
  await daemon?.store.scenarios.create({
    id: 'sc1',
    kind: 'project',
    flowId: 'software',
    name: 'Scenario',
    folder: tmp?.dir ?? '',
    profile: 'software',
    conventions: {},
    configOverride: {},
  });
  await daemon?.store.plays.create({
    id,
    scenarioId: 'sc1',
    need: 'something',
    flowId: 'software',
    flowVersion: 1,
    state: 'PLANNING',
  });
}

function stageSpan(
  spanId: string,
  parent: string | null,
  startMs: number,
  endMs: number,
): TelemetrySpan {
  return {
    traceId: 'b'.repeat(32),
    spanId,
    parentSpanId: parent,
    name: 'otheater.stage',
    kind: 1,
    startTimeUnixNano: BigInt(startMs) * 1_000_000n,
    endTimeUnixNano: BigInt(endMs) * 1_000_000n,
    status: 'ok',
    statusMessage: null,
    attributes: { 'otheater.stage': 'PLANNING' },
    resource: { 'otheater.component': 'daemon' },
    scenarioId: 'sc1',
    playId: 'play1',
    attemptId: null,
    sessionId: null,
  };
}

describe('GET /v1/plays/:playId/spans', () => {
  it('answers the tree of the spans the daemon made for the play', async () => {
    const telemetry = new MemoryTelemetryStore();
    telemetry.write({
      spans: [stageSpan('0000000000000002', null, 5, 9), stageSpan('0000000000000001', null, 1, 4)],
    });
    const token = await start(telemetry);
    await seedPlay('play1');
    const response = await get('/v1/plays/play1/spans', token);
    expect(response.status).toBe(200);
    const body = PlaySpansSchema.parse(await response.json());
    expect(body.spans.map((s) => [s.spanId, s.kind, s.label, s.durationMs])).toEqual([
      ['0000000000000001', 'stage', 'PLANNING', 3],
      ['0000000000000002', 'stage', 'PLANNING', 4],
    ]);
    expect(body.playClosed).toBe(false);
  });

  it('takes a limit, and refuses a bad one', async () => {
    const telemetry = new MemoryTelemetryStore();
    telemetry.write({
      spans: [stageSpan('0000000000000002', null, 5, 9), stageSpan('0000000000000001', null, 1, 4)],
    });
    const token = await start(telemetry);
    await seedPlay('play1');
    const body = PlaySpansSchema.parse(
      await (await get('/v1/plays/play1/spans?limit=1', token)).json(),
    );
    expect(body).toMatchObject({ truncated: true });
    expect(body.spans).toHaveLength(1);
    expect((await get('/v1/plays/play1/spans?limit=0', token)).status).toBe(400);
  });

  it('answers 404 for a play that does not exist', async () => {
    const token = await start(new MemoryTelemetryStore());
    expect((await get('/v1/plays/nope/spans', token)).status).toBe(404);
  });

  it('answers 503 when the daemon runs without the telemetry base', async () => {
    const token = await start('none');
    await seedPlay('play1');
    expect((await get('/v1/plays/play1/spans', token)).status).toBe(503);
  });

  it('asks for the token like every other route', async () => {
    await start(new MemoryTelemetryStore());
    expect((await get('/v1/plays/play1/spans', undefined)).status).toBe(401);
  });
});

describe('GET /v1/telemetry', () => {
  it('answers the state of the telemetry with the base and the export', async () => {
    const token = await start(new MemoryTelemetryStore());
    const response = await get('/v1/telemetry', token);
    expect(response.status).toBe(200);
    const body = TelemetryStatusSchema.parse(await response.json());
    expect(body.base?.state).toBe('ok');
    expect(body.export).toEqual({ mode: 'off', otlp: null, prometheus: false });
    expect(['on', 'no_receiver']).toContain(body.state);
  });

  it('says there is no base when the daemon runs without it', async () => {
    const token = await start('none');
    const body = TelemetryStatusSchema.parse(await (await get('/v1/telemetry', token)).json());
    expect(body.state).toBe('no_base');
    expect(body.base).toBeNull();
    expect(body.receiver).toBeNull();
  });

  it('says it is off when telemetry is off', async () => {
    const token = await start(
      new MemoryTelemetryStore(),
      'backup:\n  when: manual\ntelemetry:\n  enabled: off\n',
    );
    const body = TelemetryStatusSchema.parse(await (await get('/v1/telemetry', token)).json());
    expect(body.state).toBe('off');
  });

  it('asks for the token like every other route', async () => {
    await start(new MemoryTelemetryStore());
    expect((await get('/v1/telemetry', undefined)).status).toBe(401);
  });
});
