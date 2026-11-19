// SPDX-License-Identifier: MPL-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  client,
  methods,
  type ClientContext,
  type McpServer,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAgent } from './agent.js';
import { McpClient, McpClientError } from './mcp-client.js';
import { parseScriptSpec } from './scripts.js';

interface Seen {
  readonly method: string;
  readonly authorization: string | undefined;
  readonly params: unknown;
}

/** A stub of the framework server: it answers the three JSON-RPC methods and records the calls. */
interface Stub {
  url: string;
  readonly seen: Seen[];
  /** What the stub answers to `tools/call`, by tool name. */
  readonly replies: Map<string, { isError?: boolean; text: string }>;
  /** Forces an HTTP status for every request (401 for a bad token). */
  status: number;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function startStub(asEventStream = false): Promise<Stub> {
  const seen: Seen[] = [];
  const replies = new Map<string, { isError?: boolean; text: string }>();
  const stub = { seen, replies, status: 200 } as Stub;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const body = JSON.parse(await readBody(request)) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.push({
        method: body.method,
        authorization: request.headers.authorization,
        params: body.params,
      });
      if (stub.status !== 200) {
        response.writeHead(stub.status).end('{}');
        return;
      }
      if (body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (body.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} };
      } else if (body.method === 'tools/list') {
        result = { tools: [{ name: 'submit' }, { name: 'a_tool' }] };
      } else if (body.method === 'tools/call') {
        const name = String(body.params?.name);
        const reply = replies.get(name) ?? { text: '{"ok":true}' };
        result = {
          content: [{ type: 'text', text: reply.text }],
          ...(reply.isError === true ? { isError: true } : {}),
        };
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      if (asEventStream) {
        response
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(`event: message\ndata: ${payload}\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end(payload);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${String(port)}/mcp`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  return stub;
}

let sandbox: string;
const stubs: Stub[] = [];

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'fake-agent-mcp-'));
});

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  await rm(sandbox, { recursive: true, force: true });
});

async function stub(asEventStream = false): Promise<Stub> {
  const started = await startStub(asEventStream);
  stubs.push(started);
  return started;
}

function httpServer(url: string, token = 'tok-1', name = 'otheater'): McpServer {
  return {
    type: 'http',
    name,
    url,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  };
}

/** Opens a session with `mcpServers`, runs the prompt, and returns what the agent said. */
async function run(
  mcpServers: McpServer[],
  prompt: string,
  options: { reload?: boolean } = {},
): Promise<{ chunks: string[]; updates: SessionUpdate[] }> {
  const updates: SessionUpdate[] = [];
  const app = client({ name: 'fake-agent-mcp-test' }).onNotification(
    methods.client.session.update,
    ({ params }) => {
      updates.push(params.update);
    },
  );
  await app.connectWith(createFakeAgent(), async (cx: ClientContext) => {
    const init = await cx.request(methods.agent.initialize, { protocolVersion: 1 });
    expect(init.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    let sessionId: string;
    if (options.reload === true) {
      sessionId = 'earlier-session';
      await cx.request(methods.agent.session.load, { sessionId, cwd: sandbox, mcpServers });
    } else {
      ({ sessionId } = await cx.request(methods.agent.session.new, { cwd: sandbox, mcpServers }));
    }
    await cx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
  });
  const chunks = updates.flatMap((u) =>
    u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : [],
  );
  return { chunks, updates };
}

describe('mcp scripts: parsing', () => {
  it('mcp-call and submit have defaults', () => {
    expect(parseScriptSpec('mcp-call')).toEqual({
      name: 'mcp-call',
      server: 'otheater',
      arguments: {},
      list: true,
    });
    expect(parseScriptSpec('submit')).toEqual({
      name: 'submit',
      server: 'otheater',
      tool: 'submit',
      output: { result: 'done' },
      repeat: 1,
    });
    expect(() => parseScriptSpec('submit {"repeat":0}')).toThrow();
    expect(() => parseScriptSpec('mcp-call {"unknown":1}')).toThrow();
  });
});

describe('McpClient', () => {
  it('runs initialize, tools/list and tools/call with the headers of the session', async () => {
    const s = await stub();
    const client = new McpClient({
      name: 'otheater',
      url: s.url,
      headers: { Authorization: 'Bearer abc' },
    });
    await client.initialize();
    expect(await client.listTools()).toEqual(['submit', 'a_tool']);
    const outcome = await client.callTool('submit', { result: 1 });
    expect(outcome).toMatchObject({ isError: false, text: '{"ok":true}' });
    expect(s.seen.map((call) => call.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    expect(s.seen.every((call) => call.authorization === 'Bearer abc')).toBe(true);
    expect(s.seen[3]?.params).toEqual({ name: 'submit', arguments: { result: 1 } });
  });

  it('reads an event-stream answer and reports an HTTP failure', async () => {
    const sse = await stub(true);
    const viaSse = new McpClient({ name: 'otheater', url: sse.url, headers: {} });
    await viaSse.initialize();
    expect(await viaSse.listTools()).toEqual(['submit', 'a_tool']);
    sse.status = 401;
    const failure = await viaSse.listTools().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpClientError);
    expect((failure as McpClientError).status).toBe(401);
  });
});

/**
 * A stub of the stdio shim (N161): a Node script that answers the same three methods, one JSON-RPC
 * line per line, and puts its `OT_TEST_TOKEN` in the reply of a call, to show the env got there.
 */
const STDIO_STUB = `
const rl = require('readline').createInterface({ input: process.stdin });
const seen = [];
rl.on('line', (line) => {
  const m = JSON.parse(line);
  seen.push(m.method);
  if (m.id === undefined) return;
  if (process.env.OT_TEST_EXIT === m.method) process.exit(4);
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} };
  else if (m.method === 'tools/list') result = { tools: [{ name: 'submit' }, { name: 'a_tool' }] };
  else if (m.method === 'tools/call')
    result = { content: [{ type: 'text', text: JSON.stringify({ token: process.env.OT_TEST_TOKEN, seen }) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

async function stdioStub(): Promise<string> {
  const path = join(sandbox, 'stdio-stub.cjs');
  await writeFile(path, STDIO_STUB);
  return path;
}

describe('McpClient over stdio (N161)', () => {
  it('starts the process with its env, and runs initialize, tools/list and tools/call', async () => {
    const path = await stdioStub();
    const client = new McpClient({
      name: 'otheater',
      command: process.execPath,
      args: [path],
      env: { OT_TEST_TOKEN: 'tok-stdio' },
    });
    try {
      await client.initialize();
      expect(await client.listTools()).toEqual(['submit', 'a_tool']);
      const outcome = await client.callTool('a_tool', {});
      expect(JSON.parse(outcome.text)).toEqual({
        token: 'tok-stdio',
        seen: ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
      });
    } finally {
      await client.close();
    }
  });

  it('reports a process that ends before it answers, with its exit', async () => {
    const path = await stdioStub();
    const client = new McpClient({
      name: 'otheater',
      command: process.execPath,
      args: [path],
      env: { OT_TEST_EXIT: 'tools/list' },
    });
    try {
      await client.initialize();
      const failure = await client.listTools().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(McpClientError);
      expect((failure as McpClientError).message).toContain('exit 4');
    } finally {
      await client.close();
    }
  });

  it('the mcp-call script reaches a stdio server of the session', async () => {
    const path = await stdioStub();
    const { chunks } = await run(
      [
        {
          name: 'otheater',
          command: process.execPath,
          args: [path],
          env: [{ name: 'OT_TEST_TOKEN', value: 'from-acp' }],
        },
      ],
      '#script:mcp-call {"tool":"a_tool"}\n',
    );
    expect(chunks).toContain('tools: a_tool, submit');
    expect(chunks.join('')).toContain('"token":"from-acp"');
  });
});

describe('mcp-call script', () => {
  it('lists the tools and calls one, with the Authorization header of the session', async () => {
    const s = await stub();
    s.replies.set('a_tool', { text: '{"value":7}' });
    const { chunks, updates } = await run(
      [httpServer(s.url, 'secret-token')],
      '#script:mcp-call {"tool":"a_tool","arguments":{"k":"v"}}\n',
    );
    expect(chunks).toContain('tools: a_tool, submit');
    expect(chunks).toContain('reply: {"value":7}');
    expect(s.seen.every((call) => call.authorization === 'Bearer secret-token')).toBe(true);
    expect(s.seen.at(-1)?.params).toEqual({ name: 'a_tool', arguments: { k: 'v' } });
    const finished = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'completed' });
  });

  it('keeps the servers of session/load too', async () => {
    const s = await stub();
    const { chunks } = await run([httpServer(s.url, 'again')], '#script:mcp-call', {
      reload: true,
    });
    expect(chunks).toContain('tools: a_tool, submit');
    expect(s.seen.every((call) => call.authorization === 'Bearer again')).toBe(true);
  });

  it('says so when the session has no server of that name, and when the server refuses', async () => {
    const s = await stub();
    const none = await run([], '#script:mcp-call');
    expect(none.chunks.join('')).toContain('no MCP server "otheater" in this session');
    const other = await run([httpServer(s.url, 't', 'elsewhere')], '#script:mcp-call');
    expect(other.chunks.join('')).toContain('(has: elsewhere)');
    s.status = 401;
    const refused = await run([httpServer(s.url)], '#script:mcp-call {"tool":"a_tool"}');
    expect(refused.chunks.join('')).toContain('mcp error: MCP server answered HTTP 401');
    const failed = refused.updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed' });
  });
});

describe('submit script', () => {
  it('delivers the output of the role in one call and stops there', async () => {
    const s = await stub();
    const { chunks } = await run(
      [httpServer(s.url)],
      '#script:submit {"tool":"submit_plan","output":{"steps":["a"]},"repeat":3}\n',
    );
    expect(chunks).toEqual(['submit 1: {"ok":true}']);
    const calls = s.seen.filter((call) => call.method === 'tools/call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ name: 'submit_plan', arguments: { steps: ['a'] } });
  });

  it('calls again while the server answers an error, up to repeat', async () => {
    const s = await stub();
    s.replies.set('submit', { isError: true, text: '{"error":"invalid_output"}' });
    const { chunks, updates } = await run(
      [httpServer(s.url)],
      '#script:submit {"output":{"wrong":1},"repeat":3}\n',
    );
    expect(chunks).toEqual([
      'submit 1: {"error":"invalid_output"}',
      'submit 2: {"error":"invalid_output"}',
      'submit 3: {"error":"invalid_output"}',
    ]);
    const finished = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    expect(finished.every((u) => u.status === 'failed')).toBe(true);
  });
});
