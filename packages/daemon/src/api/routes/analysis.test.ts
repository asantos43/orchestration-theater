// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { AnalysisReportSchema } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { createSilentLogger } from '../../logger.js';
import { dataPaths } from '../../paths.js';
import { MemoryTelemetryStore } from '../../telemetry/telemetry-fixture.js';
import { makeTempDataDir, NO_CLIENTS } from '../../test-helpers.js';

/** `GET /v1/analysis` (P9, N55 and N217) against the daemon as it starts: the fake clock, no client. */

let tmp: Awaited<ReturnType<typeof makeTempDataDir>> | undefined;
let daemon: DaemonHandle | undefined;

afterEach(async () => {
  await daemon?.stop();
  await tmp?.dispose();
  daemon = undefined;
  tmp = undefined;
});

async function start(telemetry: MemoryTelemetryStore | 'none'): Promise<string> {
  tmp = await makeTempDataDir();
  const clock = new FakeClock(Date.UTC(2026, 10, 21, 15, 0, 0));
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig('backup:\n  when: manual\nanalysis:\n  day_boundary: utc\n'),
    overrides: {
      clock,
      store: new InMemoryStore({ clock }),
      telemetry,
      vault: new InMemorySecretVault(),
    },
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

describe('GET /v1/analysis', () => {
  it('answers a report over the period, with every figure a gap when nothing was measured', async () => {
    const token = await start(new MemoryTelemetryStore());
    const response = await get(
      '/v1/analysis?from=2026-11-01&to=2026-11-07&groupBy=executor',
      token,
    );
    expect(response.status).toBe(200);
    const report = AnalysisReportSchema.parse(await response.json());
    expect(report.period).toMatchObject({ from: '2026-11-01', to: '2026-11-07', scenario: null });
    expect(report.groupBy).toBe('executor');
    expect(report.period.summary.attempts.total).toBe(0);
    expect(report.period.summary.tokens.input).toBeNull();
    expect(report.period.summary.coverage.attemptCoverage).toBeNull();
  });

  it('defaults the period to the last days up to yesterday', async () => {
    const token = await start(new MemoryTelemetryStore());
    const response = await get('/v1/analysis', token);
    expect(response.status).toBe(200);
    const report = AnalysisReportSchema.parse(await response.json());
    expect(report.period.to).toBe('2026-11-20');
    expect(report.period.from).toBe('2026-11-14');
  });

  it.each([
    ['a bad day', '/v1/analysis?from=nope'],
    ['an inverted period', '/v1/analysis?from=2026-11-07&to=2026-11-01'],
    ['an unknown grouping', '/v1/analysis?groupBy=moon'],
    ['half a comparison', '/v1/analysis?compareFrom=2026-10-01'],
  ])('refuses %s with a 400', async (_name, path) => {
    const token = await start(new MemoryTelemetryStore());
    expect((await get(path, token)).status).toBe(400);
  });

  it('answers 503 when the daemon runs without the telemetry base', async () => {
    const token = await start('none');
    const response = await get('/v1/analysis', token);
    expect(response.status).toBe(503);
  });

  it('asks for the token like every other route', async () => {
    await start(new MemoryTelemetryStore());
    expect((await get('/v1/analysis', undefined)).status).toBe(401);
    expect((await get('/v1/analysis', 'wrong-token-0123456789abcdefghijklmnop')).status).toBe(401);
  });
});
