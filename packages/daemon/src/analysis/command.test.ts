// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { TelemetrySpan } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { AnalysisReportSchema, type AnalysisReport } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { publishDiscovery } from '../api/files.js';
import { main, type CliDeps } from '../cli.js';
import { InstanceLock } from '../instance-lock.js';
import { dataPaths } from '../paths.js';
import { DAEMON_SPAN_RESOURCE, GEN_AI, OT, SPAN_NAME } from '../telemetry/span-conventions.js';
import { MemoryTelemetryStore } from '../telemetry/telemetry-fixture.js';
import { makeTempDataDir } from '../test-helpers.js';
import { formatDuration } from './command.js';

/** The CLI of the analysis (P9, N55 and N217): `ot analysis`, with the daemon stopped and running. */

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const TOKEN = 'token-of-the-test-0123456789abcdefghijklmnop';

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

async function ot(
  argv: readonly string[],
  home: string,
  extra: Partial<CliDeps> = {},
): Promise<Captured & { code: number }> {
  const captured: Captured = { out: [], err: [] };
  const code = await main(argv, {
    env: {},
    platform: 'linux',
    homedir: home,
    out: (line) => captured.out.push(line),
    err: (line) => captured.err.push(line),
    systemLocale: 'en',
    version: '1.2.3',
    ...extra,
  });
  return { ...captured, code };
}

let counter = 0;
function hex(width: number): string {
  counter += 1;
  return counter.toString(16).padStart(width, '0');
}

function span(
  name: string,
  at: number,
  ms: number,
  attrs: Record<string, string | number>,
  options: { client?: boolean; attemptId?: string } = {},
): TelemetrySpan {
  return {
    traceId: hex(32),
    spanId: hex(16),
    parentSpanId: null,
    name,
    kind: 1,
    startTimeUnixNano: BigInt(T0 + at) * 1_000_000n,
    endTimeUnixNano: BigInt(T0 + at + ms) * 1_000_000n,
    status: 'unset',
    statusMessage: null,
    attributes: attrs,
    resource: options.client === true ? { 'service.name': 'codex' } : { ...DAEMON_SPAN_RESOURCE },
    scenarioId: 's1',
    playId: 'p1',
    attemptId: options.attemptId ?? null,
    sessionId: null,
  };
}

/** One day: two stage visits, a quota wait and two attempts, none of them with client telemetry. */
function seededOverrides(): NonNullable<CliDeps['overrides']> {
  const clock = new FakeClock(Date.UTC(2026, 10, 21, 15, 0, 0));
  const store = new InMemoryStore({ clock });
  const telemetry = new MemoryTelemetryStore();
  const attempt = (id: string, at: number, ms: number): TelemetrySpan =>
    span(
      SPAN_NAME.invokeAgent('actor'),
      at,
      ms,
      {
        [GEN_AI.agentId]: id,
        [OT.attemptEnd]: 'completed',
        [OT.role]: 'actor',
        [OT.client]: 'codex',
        [OT.profile]: 'per-process',
      },
      { attemptId: id },
    );
  telemetry.write({
    spans: [
      span(SPAN_NAME.stage, 0, 100_000, { [OT.stage]: 'SCRIPTING' }),
      span(SPAN_NAME.stage, 200_000, 60_000, { [OT.stage]: 'SCRIPTING' }),
      span(SPAN_NAME.wait, 10_000, 30_000, {
        [OT.waitKind]: 'quota',
        [OT.waitMs]: 30_000,
        [OT.client]: 'codex',
        [OT.profile]: 'per-process',
        [OT.role]: 'actor',
      }),
      attempt('a1', 0, 40_000),
      attempt('a2', 200_000, 20_000),
    ],
  });
  return { clock, store, telemetry };
}

async function withConfig(dir: string): Promise<void> {
  await writeFile(dataPaths(dir).config, 'analysis:\n  day_boundary: utc\n');
}

describe('formatDuration', () => {
  it.each([
    [null, 'n/a'],
    [850, '850ms'],
    [1500, '1.5s'],
    [12_400, '12s'],
    [185_000, '3m05s'],
    [7_800_000, '2h10m'],
  ])('writes %s as %s', (ms, text) => {
    expect(formatDuration(ms, 'n/a')).toBe(text);
  });
});

describe('ot analysis (P9, N55 and N217)', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise((done) => {
            server.close(() => {
              done(undefined);
            });
          }),
      ),
    );
  });

  describe('with the daemon stopped', () => {
    it('builds the missing days and prints the times, the waits and the gaps readably', async () => {
      const tmp = await makeTempDataDir();
      try {
        await withConfig(tmp.dir);
        const result = await ot(
          ['analysis', '--from', '2026-11-10', '--to', '2026-11-10', '--data-dir', tmp.dir],
          tmp.dir,
          { overrides: seededOverrides() },
        );
        expect(result.err).toEqual([]);
        expect(result.code).toBe(0);
        const text = result.out.join('\n');
        expect(text).toContain('2026-11-10');
        // two visits of SCRIPTING, 160 s in all
        expect(text).toMatch(/SCRIPTING.*2m40s/);
        expect(text).toMatch(/quota.*30s/);
        // the clients exported nothing: the tokens and the cost are a gap, never zero
        expect(text).toMatch(/Tokens.*n\/a/);
        expect(text).toMatch(/0%/);
      } finally {
        await tmp.dispose();
      }
    });

    it('--json prints the report as the route gives it, and it parses', async () => {
      const tmp = await makeTempDataDir();
      try {
        await withConfig(tmp.dir);
        const result = await ot(
          [
            'analysis',
            '--from',
            '2026-11-10',
            '--to',
            '2026-11-10',
            '--group-by',
            'executor',
            '--json',
            '--data-dir',
            tmp.dir,
          ],
          tmp.dir,
          { overrides: seededOverrides() },
        );
        expect(result.code).toBe(0);
        expect(result.out).toHaveLength(1);
        const report = AnalysisReportSchema.parse(JSON.parse(result.out[0] ?? ''));
        expect(report.groupBy).toBe('executor');
        // the stage visits belong to no Executor: they sit under the empty key
        expect(report.groups.map((group) => group.key)).toEqual(['', 'codex/per-process']);
        expect(report.period.summary.coverage.attemptCoverage).toBe(0);
        expect(report.period.summary.tokens.input).toBeNull();
      } finally {
        await tmp.dispose();
      }
    });

    it('speaks pt-BR when asked', async () => {
      const tmp = await makeTempDataDir();
      try {
        await withConfig(tmp.dir);
        const result = await ot(
          ['analysis', '--from', '2026-11-10', '--to', '2026-11-10', '--data-dir', tmp.dir],
          tmp.dir,
          { overrides: seededOverrides(), systemLocale: 'pt-BR' },
        );
        expect(result.code).toBe(0);
        expect(result.out.join('\n')).toContain('n/d');
      } finally {
        await tmp.dispose();
      }
    });

    it('says so, and exits 1, when the telemetry base is off', async () => {
      const tmp = await makeTempDataDir();
      try {
        const overrides = { ...seededOverrides(), telemetry: 'none' as const };
        const result = await ot(['analysis', '--data-dir', tmp.dir], tmp.dir, { overrides });
        expect(result.code).toBe(1);
        expect(result.err.join('\n')).toMatch(/telemetry/i);
        expect(result.out).toEqual([]);
      } finally {
        await tmp.dispose();
      }
    });

    it('turns a period the service refuses into a usage error', async () => {
      const tmp = await makeTempDataDir();
      try {
        const result = await ot(
          ['analysis', '--from', '2026-11-11', '--to', '2026-11-10', '--data-dir', tmp.dir],
          tmp.dir,
          { overrides: seededOverrides() },
        );
        expect(result.code).toBe(2);
        expect(result.err.at(-1)).toBe('Run "ot --help" for usage.');
      } finally {
        await tmp.dispose();
      }
    });
  });

  it.each([
    ['a bad day', ['analysis', '--from', '10/11/2026'], /--from/],
    ['a bad group-by', ['analysis', '--group-by', 'moon'], /executor/],
    ['half a compare pair', ['analysis', '--compare-from', '2026-11-01'], /--compare-from/],
    ['compare-scenario alone', ['analysis', '--compare-scenario', 's2'], /--scenario/],
  ])(
    'exits 2 with a hint for %s, before touching the data folder',
    async (_name, argv, message) => {
      const tmp = await makeTempDataDir();
      try {
        const result = await ot([...argv, '--data-dir', tmp.dir], tmp.dir);
        expect(result.code).toBe(2);
        expect(result.err.join('\n')).toMatch(message);
        expect(result.err.at(-1)).toBe('Run "ot --help" for usage.');
        expect(result.out).toEqual([]);
      } finally {
        await tmp.dispose();
      }
    },
  );

  it('lists the command in the help of both languages', async () => {
    const tmp = await makeTempDataDir();
    try {
      const en = await ot(['--help', '--data-dir', tmp.dir], tmp.dir);
      expect(en.out.join('\n')).toContain('analysis');
      const pt = await ot(['--help', '--data-dir', tmp.dir], tmp.dir, { systemLocale: 'pt-BR' });
      expect(pt.out.join('\n')).toContain('analysis');
    } finally {
      await tmp.dispose();
    }
  });

  describe('with the daemon running', () => {
    const REPORT: AnalysisReport = AnalysisReportSchema.parse({
      period: {
        from: '2026-11-10',
        to: '2026-11-10',
        scenario: null,
        summary: emptySummary(),
        bottlenecks: [],
      },
      groupBy: 'day',
      groups: [],
      compare: null,
      readyThrough: '2026-11-10',
      missingDays: 0,
      percentilesApproximate: false,
    });

    async function withDaemon(
      tmpDir: string,
      respond: (
        url: string,
        authorization: string | undefined,
      ) => { status: number; body: unknown },
    ): Promise<{ requests: string[]; release: () => Promise<void> }> {
      const paths = dataPaths(tmpDir);
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
        const { status, body } = respond(request.url ?? '', request.headers.authorization);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      servers.push(server);
      await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
      const { port } = server.address() as AddressInfo;
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      await mkdir(paths.dataDir, { recursive: true });
      await publishDiscovery(paths.apiDiscovery, {
        url: `http://127.0.0.1:${String(port)}`,
        daemonId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        pid: process.pid,
        apiVersion: 1,
      });
      await writeFile(paths.apiToken, `${TOKEN}\n`);
      return { requests, release: () => lock.release() };
    }

    it('asks the route with the token and the query, and prints the report', async () => {
      const tmp = await makeTempDataDir();
      try {
        const daemon = await withDaemon(tmp.dir, (_url, authorization) =>
          authorization === `Bearer ${TOKEN}`
            ? { status: 200, body: REPORT }
            : { status: 401, body: {} },
        );
        try {
          const result = await ot(
            [
              'analysis',
              '--from',
              '2026-11-10',
              '--to',
              '2026-11-10',
              '--scenario',
              's1',
              '--group-by',
              'role',
              '--data-dir',
              tmp.dir,
            ],
            tmp.dir,
          );
          expect(result.err).toEqual([]);
          expect(result.code).toBe(0);
          expect(daemon.requests).toEqual([
            'GET /v1/analysis?from=2026-11-10&to=2026-11-10&groupBy=role&scenario=s1',
          ]);
          expect(result.out.join('\n')).toContain('2026-11-10');
          const json = await ot(['analysis', '--json', '--data-dir', tmp.dir], tmp.dir);
          expect(AnalysisReportSchema.safeParse(JSON.parse(json.out.join('\n'))).success).toBe(
            true,
          );
        } finally {
          await daemon.release();
        }
      } finally {
        await tmp.dispose();
      }
    });

    it.each([
      [401, 1, /401/],
      [400, 2, /./],
      [503, 1, /telemetry/i],
      [500, 1, /HTTP 500/],
    ])('maps the status %s to the exit code %s', async (status, code, message) => {
      const tmp = await makeTempDataDir();
      try {
        const daemon = await withDaemon(tmp.dir, () => ({ status, body: {} }));
        try {
          const result = await ot(['analysis', '--data-dir', tmp.dir], tmp.dir);
          expect(result.code).toBe(code);
          expect(result.err.join('\n')).toMatch(message);
          expect(result.out).toEqual([]);
        } finally {
          await daemon.release();
        }
      } finally {
        await tmp.dispose();
      }
    });

    it('fails with the api-token missing, without asking the daemon', async () => {
      const tmp = await makeTempDataDir();
      try {
        const daemon = await withDaemon(tmp.dir, () => ({ status: 200, body: REPORT }));
        try {
          await rm(dataPaths(tmp.dir).apiToken);
          const result = await ot(['analysis', '--data-dir', tmp.dir], tmp.dir);
          expect(result.code).toBe(1);
          expect(result.err.join('\n')).toMatch(/api-token/);
          expect(daemon.requests).toEqual([]);
        } finally {
          await daemon.release();
        }
      } finally {
        await tmp.dispose();
      }
    });
  });
});

function emptySummary(): unknown {
  return {
    attempts: { total: 0, byEnd: {}, duration: emptyStat() },
    rejections: 0,
    approvedDemands: 0,
    interruptions: {},
    stages: {},
    waits: {},
    tokens: { input: null, output: null, cached: null },
    cost: {
      realUsd: null,
      apiEquivalentUsd: null,
      realPerApprovedDemandUsd: null,
      apiEquivalentPerApprovedDemandUsd: null,
    },
    coverage: {
      attempts: 0,
      attemptsWithClientTelemetry: 0,
      attemptCoverage: null,
      usageTurns: 0,
      usageTurnsWithTokens: 0,
      tokenCoverage: null,
      usageTurnsWithCost: 0,
      costCoverage: null,
      origins: [],
    },
  };
}

function emptyStat(): unknown {
  return { count: 0, sumMs: null, p50Ms: null, p95Ms: null, maxMs: null };
}
