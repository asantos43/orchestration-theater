// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  client,
  methods,
  ndJsonStream,
  type AgentApp,
  type PromptResponse,
  type Stream,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAgent } from './agent.js';
import { approximateTokens, FAKE_OTEL_SERVICE, FakeOtel } from './otel.js';

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A receiver on loopback that records every OTLP POST. `status` is what it answers. */
async function receiver(status = 200): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listening(status = 200): ReturnType<typeof receiver> {
  const server = await receiver(status);
  closers.push(server.close);
  return server;
}

const RESOURCE =
  'otheater.play_id=p1,otheater.stage_id=s1,otheater.attempt_id=a1,otheater.session_id=x1,otheater.client=fake';

function envFor(url: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: `${url}/`,
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok-1',
    OTEL_RESOURCE_ATTRIBUTES: RESOURCE,
    ...extra,
  };
}

type Attributes = { key: string; value: { stringValue?: string; intValue?: string } }[];

function attributesOf(list: unknown): Record<string, string> {
  return Object.fromEntries(
    (list as Attributes).map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? '']),
  );
}

/** Runs `fn` against a session of `target`, which is an in-process agent or a stream. */
async function inSession<T>(
  target: AgentApp | Stream,
  fn: (send: (text: string) => Promise<PromptResponse>) => Promise<T>,
): Promise<T> {
  return client({ name: 'otel-test' }).connectWith(target, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1 });
    const { sessionId } = await cx.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    return fn((text) =>
      cx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
    );
  });
}

function bySignal(received: Received[], signal: string): Received[] {
  return received.filter((r) => r.path === `/v1/${signal}`);
}

describe('FakeOtel.fromEnv', () => {
  it('has no exporter without an endpoint: nothing to send, nothing to read', () => {
    expect(FakeOtel.fromEnv({})).toBeUndefined();
    expect(FakeOtel.fromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ' ' })).toBeUndefined();
    expect(FakeOtel.fromEnv({ OTEL_RESOURCE_ATTRIBUTES: RESOURCE })).toBeUndefined();
  });

  it('refuses a protocol it does not speak and says so', () => {
    const reasons: string[] = [];
    const otel = FakeOtel.fromEnv(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      },
      { onError: (reason) => reasons.push(reason) },
    );
    expect(otel).toBeUndefined();
    expect(reasons).toEqual([expect.stringContaining('grpc')]);
  });

  it('counts a token for every four characters', () => {
    expect([0, 1, 4, 5, 40].map(approximateTokens)).toEqual([0, 1, 1, 2, 10]);
  });
});

describe('the fake agent with telemetry', () => {
  it('sends a span, the token metrics and one log per tool, with the token and the correlation', async () => {
    const server = await listening();
    const otel = FakeOtel.fromEnv(envFor(server.url));
    await inSession(createFakeAgent({ ...(otel === undefined ? {} : { otel }) }), async (send) => {
      const response = await send('#script:tool-call {"title":"read file","output":"done"}');
      expect(response.stopReason).toBe('end_turn');
    });

    expect(server.received.map((r) => r.path).sort()).toEqual([
      '/v1/logs',
      '/v1/metrics',
      '/v1/traces',
    ]);
    for (const r of server.received) {
      expect(r.headers.authorization).toBe('Bearer tok-1');
      expect(r.headers['content-type']).toBe('application/json');
    }

    const resourceOf = (r: Received | undefined, key: string): Record<string, string> => {
      const root = (r?.body[key] as { resource: { attributes: unknown } }[] | undefined)?.[0];
      return attributesOf(root?.resource.attributes);
    };
    for (const [path, key] of [
      ['traces', 'resourceSpans'],
      ['metrics', 'resourceMetrics'],
      ['logs', 'resourceLogs'],
    ] as const) {
      expect(resourceOf(bySignal(server.received, path)[0], key)).toMatchObject({
        'service.name': FAKE_OTEL_SERVICE,
        'otheater.play_id': 'p1',
        'otheater.stage_id': 's1',
        'otheater.attempt_id': 'a1',
        'otheater.session_id': 'x1',
        'otheater.client': 'fake',
      });
    }

    const spans = (
      bySignal(server.received, 'traces')[0]?.body.resourceSpans as {
        scopeSpans: {
          spans: {
            traceId: string;
            spanId: string;
            name: string;
            attributes: unknown;
            status: { code: number };
          }[];
        }[];
      }[]
    )[0]?.scopeSpans[0]?.spans;
    expect(spans).toHaveLength(1);
    expect(spans?.[0]).toMatchObject({ name: 'fake_agent.turn', status: { code: 1 } });
    expect(spans?.[0]?.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(spans?.[0]?.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(attributesOf(spans?.[0]?.attributes)).toMatchObject({
      script: 'tool-call',
      stop_reason: 'end_turn',
      tool_calls: '1',
      model: 'fake-model',
    });

    const logs = (
      bySignal(server.received, 'logs')[0]?.body.resourceLogs as {
        scopeLogs: { logRecords: { body: unknown; attributes: unknown; traceId: string }[] }[];
      }[]
    )[0]?.scopeLogs[0]?.logRecords;
    expect(logs).toHaveLength(1);
    expect(logs?.[0]?.body).toEqual({ stringValue: 'tool_call' });
    expect(logs?.[0]?.traceId).toBe(spans?.[0]?.traceId);
    expect(attributesOf(logs?.[0]?.attributes)).toMatchObject({
      'tool.name': 'read file',
      'tool.call_id': 'call-1',
    });
  });

  it('counts the tokens of the turn: the prompt as input and the agent text as output', async () => {
    const server = await listening();
    const otel = FakeOtel.fromEnv(envFor(server.url));
    const prompt = 'x'.repeat(40);
    await inSession(createFakeAgent({ ...(otel === undefined ? {} : { otel }) }), (send) =>
      send(prompt),
    );
    const points = (
      bySignal(server.received, 'metrics')[0]?.body.resourceMetrics as {
        scopeMetrics: {
          metrics: {
            name: string;
            sum: { dataPoints: { attributes: unknown; asInt: string }[] };
          }[];
        }[];
      }[]
    )[0]?.scopeMetrics[0]?.metrics[0];
    expect(points?.name).toBe('fake_agent.token.usage');
    const byType = Object.fromEntries(
      (points?.sum.dataPoints ?? []).map((p): [string, string] => [
        attributesOf(p.attributes).type ?? '',
        p.asInt,
      ]),
    );
    expect(byType).toEqual({ input: '10', output: '10' });
  });

  it('a usage-signal turn reports the tokens and the model it announced', async () => {
    const server = await listening();
    const otel = FakeOtel.fromEnv(envFor(server.url));
    await inSession(createFakeAgent({ ...(otel === undefined ? {} : { otel }) }), (send) =>
      send(
        '#script:usage-signal {"model":"gpt-6-sol","inputTokens":50,"outputTokens":7,"repeat":2}',
      ),
    );
    const metric = (
      bySignal(server.received, 'metrics')[0]?.body.resourceMetrics as {
        scopeMetrics: {
          metrics: { sum: { dataPoints: { attributes: unknown; asInt: string }[] } }[];
        }[];
      }[]
    )[0]?.scopeMetrics[0]?.metrics[0];
    const points = (metric?.sum.dataPoints ?? []).map((p) => ({
      ...attributesOf(p.attributes),
      value: p.asInt,
    }));
    expect(points).toMatchObject([
      { type: 'input', model: 'gpt-6-sol', value: '100' },
      { type: 'output', model: 'gpt-6-sol', value: '14' },
    ]);
  });

  it('a turn without tool calls sends no log, and a failed turn marks the span as an error', async () => {
    const server = await listening();
    const otel = FakeOtel.fromEnv(envFor(server.url));
    await inSession(createFakeAgent({ ...(otel === undefined ? {} : { otel }) }), async (send) => {
      await send('hello');
      expect(bySignal(server.received, 'logs')).toHaveLength(0);
      await expect(send('#script:fail {"message":"boom"}')).rejects.toThrow();
    });
    const traces = bySignal(server.received, 'traces').map(
      (r) =>
        (r.body.resourceSpans as { scopeSpans: { spans: { status: { code: number } }[] }[] }[])[0]
          ?.scopeSpans[0]?.spans[0]?.status.code,
    );
    expect(traces).toEqual([1, 2]);
  });

  it('leaves out a signal whose exporter is none', async () => {
    const server = await listening();
    const otel = FakeOtel.fromEnv(envFor(server.url, { OTEL_TRACES_EXPORTER: 'none' }));
    await inSession(createFakeAgent({ ...(otel === undefined ? {} : { otel }) }), (send) =>
      send('#script:tool-call {"title":"t","output":"o"}'),
    );
    expect(server.received.map((r) => r.path).sort()).toEqual(['/v1/logs', '/v1/metrics']);
  });

  it('without otel it sends nothing and the turn is the same', async () => {
    const server = await listening();
    const response = await inSession(createFakeAgent(), (send) => send('plain'));
    expect(response.stopReason).toBe('end_turn');
    expect(server.received).toEqual([]);
  });

  it('a receiver that is down or refuses does not fail the turn, and is reported once', async () => {
    const server = await listening(401);
    const reasons: string[] = [];
    const otel = FakeOtel.fromEnv(envFor(server.url), { onError: (r) => reasons.push(r) });
    await inSession(createFakeAgent({ ...(otel === undefined ? {} : { otel }) }), async (send) => {
      expect((await send('one')).stopReason).toBe('end_turn');
      expect((await send('two')).stopReason).toBe('end_turn');
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('401');
    expect(reasons[0]).not.toContain('tok-1');
  });
});

describe('fake-agent binary with OTEL_* in the environment', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

  async function runTurn(env: Record<string, string>): Promise<void> {
    if (!existsSync(cli)) throw new Error('dist/cli.js not found: run `pnpm build` first');
    const child = spawn(process.execPath, [cli], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const exited = new Promise<void>((done) =>
      child.once('exit', () => {
        done();
      }),
    );
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    try {
      await inSession(stream, (send) => send('#script:tool-call {"title":"t","output":"o"}'));
    } finally {
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill();
      }, 2000);
      await exited;
      clearTimeout(timer);
    }
  }

  it('exports to the receiver with the token and the correlation it was started with', async () => {
    const server = await listening();
    await runTurn(envFor(server.url));
    expect(server.received.map((r) => r.path).sort()).toEqual([
      '/v1/logs',
      '/v1/metrics',
      '/v1/traces',
    ]);
    expect(server.received.every((r) => r.headers.authorization === 'Bearer tok-1')).toBe(true);
    const spans = bySignal(server.received, 'traces')[0]?.body.resourceSpans as {
      resource: { attributes: unknown };
    }[];
    expect(attributesOf(spans[0]?.resource.attributes)).toMatchObject({
      'otheater.attempt_id': 'a1',
      'otheater.session_id': 'x1',
    });
  });

  it('sends nothing without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
    const server = await listening();
    await runTurn({
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok-1',
      OTEL_RESOURCE_ATTRIBUTES: RESOURCE,
    });
    expect(server.received).toEqual([]);
  });
});
