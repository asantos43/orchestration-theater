// SPDX-License-Identifier: MPL-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProfileRef } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger, type Logger } from '../logger.js';
import { RecordingSituations } from '../test-helpers.js';
import {
  MINIMAX_DEFAULT_BACKOFF_MS,
  MiniMaxProbeError,
  MiniMaxQuotaProbe,
  shapeOf,
  type UsageCountMeans,
} from './minimax-probe.js';
import { QuotaService } from './service.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const REF: ProfileRef = { client: 'opencode', profile: 'mm' };
const KEY = 'sk-test-0123456789-not-a-real-key';
const RESET = new Date(T0 + 3 * 60 * MIN).toISOString();

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];
const services: QuotaService[] = [];

async function serve(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** The shape of a good answer, as the third-party notes give it [S]. */
function good(total: number, usageCount: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    base_resp: { status_code: 0, status_msg: 'success' },
    data: {
      current_interval_total_count: total,
      current_interval_usage_count: usageCount,
      current_interval_reset_time: RESET,
      ...extra,
    },
  };
}

interface Lines {
  readonly records: Record<string, unknown>[];
  text(): string;
}

function capturingLogger(): { logger: Logger; lines: Lines } {
  const raw: string[] = [];
  const logger: Logger = pino(
    { level: 'debug' },
    { write: (chunk: string) => void raw.push(chunk) },
  );
  return {
    logger,
    lines: {
      get records() {
        return raw.map((line) => JSON.parse(line) as Record<string, unknown>);
      },
      text: () => raw.join(''),
    },
  };
}

interface Setup {
  clock: FakeClock;
  store: InMemoryStore;
  probe: MiniMaxQuotaProbe;
  service: QuotaService;
  lines: Lines;
  situations: RecordingSituations;
}

function setup(
  base: string,
  options: { key?: string | undefined; means?: UsageCountMeans; timeoutMs?: number } = {},
): Setup {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const { logger, lines } = capturingLogger();
  const situations = new RecordingSituations();
  const probe = new MiniMaxQuotaProbe({
    baseUrl: base,
    network: { allowHosts: ['127.0.0.1'], timeoutMs: options.timeoutMs ?? 2000 },
    usageCountMeans: options.means ?? 'remaining',
    keyOf: () => Promise.resolve('key' in options ? options.key : KEY),
    clock,
    logger,
    situations,
  });
  const service = new QuotaService({
    store,
    clock,
    settings: { nearLimitAt: 0.8, staleAfterMs: 10 * MIN, delivery: 'poll', pollEveryMs: 5 * MIN },
    logger: createSilentLogger(),
  });
  service.addProbe('opencode', probe);
  services.push(service);
  return { clock, store, probe, service, lines, situations };
}

describe('MiniMaxQuotaProbe: a good reading', () => {
  it('asks GET /v1/token_plan/remains with the key in the Authorization header only', async () => {
    const seen: {
      method?: string | undefined;
      url?: string | undefined;
      auth?: string | undefined;
    } = {};
    const base = await serve((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      json(res, good(1500, 1200));
    });
    const { service, lines } = setup(base);
    await service.refresh(REF);
    expect(seen).toEqual({
      method: 'GET',
      url: '/v1/token_plan/remains',
      auth: `Bearer ${KEY}`,
    });
    expect(lines.text()).not.toContain(KEY);
  });

  it('is ok with room: 1200 left of 1500 is 20 percent used', async () => {
    const base = await serve((_req, res) => {
      json(res, good(1500, 1200));
    });
    const { service, probe } = setup(base);
    expect(probe.capabilities()).toEqual({
      windows: ['5h'],
      delivery: 'poll',
      precision: 'exact',
    });
    const status = await service.refresh(REF);
    expect(status).toMatchObject({ state: 'ok' });
    expect(status.windows).toHaveLength(1);
    expect(status.windows[0]).toMatchObject({
      window: '5h',
      usedPercent: 20,
      resetsAt: Date.parse(RESET),
      fresh: true,
      source: 'probe',
    });
  });

  it('is near_limit when little is left: 150 left of 1500 is 90 percent used', async () => {
    const base = await serve((_req, res) => {
      json(res, good(1500, 150));
    });
    const { service } = setup(base);
    expect(await service.refresh(REF)).toMatchObject({ state: 'near_limit' });
  });

  it('reads the count as USED when the key says so', async () => {
    const base = await serve((_req, res) => {
      json(res, good(1500, 1200));
    });
    const { service } = setup(base, { means: 'used' });
    const status = await service.refresh(REF);
    expect(status).toMatchObject({ state: 'near_limit' });
    expect(status.windows[0]).toMatchObject({ window: '5h', usedPercent: 80 });
  });

  it('reports the weekly window too when the answer has it, as an extra', async () => {
    const base = await serve((_req, res) => {
      json(
        res,
        good(100, 50, {
          current_weekly_total_count: 1000,
          current_weekly_usage_count: 100,
          current_weekly_reset_time: '2026-11-23T00:00:00+08:00',
        }),
      );
    });
    const { service } = setup(base);
    const status = await service.refresh(REF);
    const weekly = status.windows.find((w) => w.window === 'weekly');
    expect(weekly).toMatchObject({ usedPercent: 90, resetsAt: Date.parse('2026-11-22T16:00:00Z') });
    expect(status.state).toBe('near_limit');
  });

  it('accepts a reset time as epoch seconds', async () => {
    const seconds = Math.floor((T0 + 60 * MIN) / 1000);
    const base = await serve((_req, res) => {
      json(res, {
        base_resp: { status_code: 0 },
        data: {
          current_interval_total_count: 10,
          current_interval_usage_count: 10,
          current_interval_reset_time: seconds,
        },
      });
    });
    const { service } = setup(base);
    const status = await service.refresh(REF);
    expect(status.windows[0]).toMatchObject({ usedPercent: 0, resetsAt: seconds * 1000 });
  });
});

describe('MiniMaxQuotaProbe: no reading', () => {
  it('takes base_resp 1004 as no reading, never as exhausted, and keeps the profile unknown', async () => {
    // [V] what a fake key got in Phase 0: HTTP 200 with this body.
    const base = await serve((_req, res) => {
      json(res, { base_resp: { status_code: 1004, status_msg: `login fail ${KEY}` } });
    });
    const { service, probe, lines } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'no_reading' });
    const status = await service.refresh(REF);
    expect(status).toMatchObject({ state: 'unknown', untilReset: null });
    expect(status.windows).toEqual([]);
    expect(lines.text()).toContain('1004');
    expect(lines.text()).not.toContain(KEY);
  });

  it('takes an unknown body as unknown and logs its shape, never its values', async () => {
    const body = { base_resp: { status_code: 0 }, data: { remains: 'secret-ish-value-42', n: 7 } };
    const base = await serve((_req, res) => {
      json(res, body);
    });
    const { service, probe, lines } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'unknown_format' });
    expect(await service.refresh(REF)).toMatchObject({ state: 'unknown' });
    const warn = lines.records.find((r) =>
      String(r.msg).includes('format the probe does not know'),
    );
    expect(warn).toBeDefined();
    expect(warn?.shape).toEqual([
      'base_resp.status_code:number',
      'data.n:number',
      'data.remains:string',
    ]);
    expect(lines.text()).not.toContain('secret-ish-value-42');
  });

  it('logs one unknown shape once, not on every poll', async () => {
    const base = await serve((_req, res) => {
      json(res, { hello: 'world' });
    });
    const { probe, lines } = setup(base);
    await probe.read(REF).catch(() => undefined);
    await probe.read(REF).catch(() => undefined);
    const warns = lines.records.filter((r) =>
      String(r.msg).includes('format the probe does not know'),
    );
    expect(warns).toHaveLength(1);
  });

  it.each([
    ['not JSON', 'plain text'],
    ['a total of zero', JSON.stringify(good(0, 0))],
    ['a count above the total', JSON.stringify(good(100, 101))],
    ['a negative count', JSON.stringify(good(100, -1))],
    ['a count that is not a number', JSON.stringify(good(100, '5'))],
    [
      'a reset that is not a time',
      JSON.stringify({
        base_resp: { status_code: 0 },
        data: {
          current_interval_total_count: 10,
          current_interval_usage_count: 5,
          current_interval_reset_time: 'tomorrow-ish',
        },
      }),
    ],
    [
      'a weekly window with a field missing',
      JSON.stringify(good(100, 50, { current_weekly_total_count: 10 })),
    ],
    ['no data', JSON.stringify({ base_resp: { status_code: 0 } })],
    ['an array', '[]'],
  ])('is unknown_format for %s', async (_name, text) => {
    const base = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(text);
    });
    const { service, probe } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'unknown_format' });
    expect(await service.refresh(REF)).toMatchObject({ state: 'unknown' });
  });

  it('is unknown when the server does not answer in time', async () => {
    const base = await serve(() => {
      // never answers
    });
    const { service, probe } = setup(base, { timeoutMs: 80 });
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'timeout' });
    expect(await service.refresh(REF)).toMatchObject({ state: 'unknown' });
  });

  it('is unknown on a 5xx and says the key was refused on a 401', async () => {
    let status = 503;
    const base = await serve((_req, res) => {
      json(res, { error: 'x' }, status);
    });
    const { service, probe } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'http_error' });
    status = 401;
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(await service.refresh(REF)).toMatchObject({ state: 'unknown' });
  });

  it('does not call at all without a key in the vault', async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits += 1;
      json(res, good(10, 5));
    });
    const { service, probe } = setup(base, { key: undefined });
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'no_key' });
    expect(await service.refresh(REF)).toMatchObject({ state: 'unknown' });
    expect(hits).toBe(0);
  });

  it('does not call a host outside its policy', async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits += 1;
      json(res, good(10, 5));
    });
    const { clock } = setup(base);
    const { logger } = capturingLogger();
    const probe = new MiniMaxQuotaProbe({
      baseUrl: base,
      network: { allowHosts: ['api.minimax.io'], timeoutMs: 500 },
      usageCountMeans: 'remaining',
      keyOf: () => Promise.resolve(KEY),
      clock,
      logger,
    });
    await expect(probe.read(REF)).rejects.toThrow(/allowlist/);
    expect(hits).toBe(0);
  });
});

describe('MiniMaxQuotaProbe: 429', () => {
  it('leaves the state alone, does not mark exhausted, and waits for Retry-After', async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits += 1;
      res.setHeader('retry-after', '120');
      json(res, { error: 'slow' }, 429);
    });
    const { service, probe, clock } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(await service.refresh(REF)).toMatchObject({ state: 'unknown' });
    expect(hits).toBe(1);
    // Within the wait the endpoint is not touched again.
    await clock.advance(60_000);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(hits).toBe(1);
    // Past it, the probe calls again.
    await clock.advance(61_000);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(hits).toBe(2);
  });

  it('waits a minute when the 429 says nothing, and recovers on the next good answer', async () => {
    let mode: 'limited' | 'good' = 'limited';
    const base = await serve((_req, res) => {
      if (mode === 'limited') json(res, {}, 429);
      else json(res, good(100, 90));
    });
    const { service, probe, clock } = setup(base);
    await expect(probe.read(REF)).rejects.toBeInstanceOf(MiniMaxProbeError);
    mode = 'good';
    await clock.advance(MINIMAX_DEFAULT_BACKOFF_MS + 1);
    expect(await service.refresh(REF)).toMatchObject({ state: 'ok' });
  });
});

describe('MiniMaxQuotaProbe: an earlier reading survives a failed one', () => {
  it('keeps the last good reading until it goes stale, then the profile is unknown', async () => {
    let answer: () => unknown = () => good(100, 10);
    const base = await serve((_req, res) => {
      json(res, answer());
    });
    const { service, clock } = setup(base);
    expect(await service.refresh(REF)).toMatchObject({ state: 'near_limit' });
    answer = () => ({ base_resp: { status_code: 1004 } });
    await clock.advance(5 * MIN);
    expect(await service.refresh(REF)).toMatchObject({ state: 'near_limit' });
    await clock.advance(6 * MIN);
    expect(await service.refresh(REF)).toMatchObject({ state: 'unknown' });
  });
});

describe('MiniMaxQuotaProbe: what it also tells as events (P24, N146)', () => {
  const PROFILE = 'opencode/mm';

  it('quota.probe_failed rate_limited: the 429, with the wait, every time (it is not gated)', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('retry-after', '120');
      json(res, { error: 'slow' }, 429);
    });
    const { probe, clock, situations } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'rate_limited' });
    await clock.advance(121_000);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(situations.of('quota.probe_failed')).toEqual([
      { profile: PROFILE, reason: 'rate_limited', status: 429, backoffMs: 120_000 },
      { profile: PROFILE, reason: 'rate_limited', status: 429, backoffMs: 120_000 },
    ]);
  });

  it('quota.probe_failed unauthorized: a 401 once, like the log', async () => {
    const base = await serve((_req, res) => {
      json(res, { error: 'no' }, 401);
    });
    const { probe, situations } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'unauthorized' });
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(situations.of('quota.probe_failed')).toEqual([
      { profile: PROFILE, reason: 'unauthorized', status: 401 },
    ]);
  });

  it('quota.probe_failed no_key: no key in the vault, once, and the key is never in the event', async () => {
    const base = await serve((_req, res) => {
      json(res, good(100, 90));
    });
    const { probe, situations } = setup(base, { key: undefined });
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'no_key' });
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'no_key' });
    expect(situations.of('quota.probe_failed')).toEqual([{ profile: PROFILE, reason: 'no_key' }]);
  });

  it('quota.probe_failed no_reading: base_resp that is not a success, with the key masked out of the text', async () => {
    const base = await serve((_req, res) => {
      json(res, { base_resp: { status_code: 1004, status_msg: `login fail ${KEY}` } });
    });
    const { probe, situations } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'no_reading' });
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'no_reading' });
    expect(situations.of('quota.probe_failed')).toEqual([
      { profile: PROFILE, reason: 'no_reading', status: 1004, detail: 'login fail [key]' },
    ]);
    expect(JSON.stringify(situations.recorded)).not.toContain(KEY);
  });

  it('quota.probe_failed unknown_format: a body it does not know, once per shape, with no values', async () => {
    const base = await serve((_req, res) => {
      json(res, { base_resp: { status_code: 0 }, data: { remains: 'secret-ish-value-42' } });
    });
    const { probe, situations } = setup(base);
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'unknown_format' });
    await expect(probe.read(REF)).rejects.toMatchObject({ reason: 'unknown_format' });
    expect(situations.of('quota.probe_failed')).toEqual([
      { profile: PROFILE, reason: 'unknown_format', detail: 'data does not fit' },
    ]);
    expect(JSON.stringify(situations.recorded)).not.toContain('secret-ish-value-42');
  });

  it('says nothing on a good answer', async () => {
    const base = await serve((_req, res) => {
      json(res, good(100, 90));
    });
    const { probe, situations } = setup(base);
    await probe.read(REF);
    expect(situations.recorded).toEqual([]);
  });
});

describe('shapeOf', () => {
  it('lists paths and types, sorted, and caps the list', () => {
    expect(shapeOf({ b: [1, 2], a: { c: null, d: 'x' } })).toEqual([
      'a.c:null',
      'a.d:string',
      'b:array(2)',
      'b[]:number',
    ]);
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${String(i)}`, i]));
    expect(shapeOf(wide, 10)).toHaveLength(10);
  });
});
