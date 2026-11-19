// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { McpStdioLaunch } from '@otheater/core';
import { buildDaemonRegistries } from '../registries.js';
import { captureLogger } from '../test-helpers.js';
import { FrameworkMcpServer, type McpGrant } from './index.js';
import {
  SHIM_AUTHORIZATION_ENV,
  SHIM_ERROR_CODE,
  SHIM_SOCKET_ENV,
  STDIO_SHIM_PATH,
  messagesOf,
  runShim,
} from './stdio-shim.js';

/**
 * N161: the stdio shim against a real framework MCP server on a Unix socket. Unconfined, so it runs
 * on Linux and macOS alike; what Seatbelt lets through is measured in `unix-socket.test.ts` of the
 * sandbox adapter. Not on Windows: there the path of `listen` is a named pipe, and the bridge of
 * Windows is not this one.
 */
const windows = process.platform === 'win32';
const registries = buildDaemonRegistries();
const root = windows ? '' : realpathSync(mkdtempSync(join(tmpdir(), 'ot-shim-')));
const running: FrameworkMcpServer[] = [];

async function start(name = 'mcp.sock'): Promise<FrameworkMcpServer> {
  const { logger } = captureLogger();
  const server = await FrameworkMcpServer.start({
    registries,
    port: 'auto',
    submitRetries: 2,
    logger,
    version: '0.0.0-test',
    socketPath: join(root, name),
  });
  running.push(server);
  return server;
}

function grantOf(server: FrameworkMcpServer, role = 'author'): McpGrant {
  const attemptId = 'p1/d1/1';
  return server.grant({
    attemptId,
    role,
    correlation: { playId: 'p1', demandId: 'd1', attemptId },
    record: () => Promise.resolve(),
  });
}

function launchOf(grant: McpGrant): McpStdioLaunch {
  const launch = grant.server.stdio;
  if (launch === undefined) throw new Error('the grant carries no stdio shim');
  return launch;
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'shim-test', version: '0' },
  },
};
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

interface Reply {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number };
}

/** Runs the shim in this process over the lines, and returns what it wrote, one reply per line. */
async function inProcess(
  socketPath: string,
  authorization: string,
  lines: readonly string[],
): Promise<Reply[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => (written += chunk.toString('utf8')));
  const done = runShim({ socketPath, authorization, input, output });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return written
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Reply);
}

const toolNames = (reply: Reply | undefined): string[] =>
  ((reply?.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name);

beforeAll(() => {
  if (!windows) expect(existsSync(root)).toBe(true);
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

afterAll(() => {
  if (!windows) rmSync(root, { recursive: true, force: true });
});

describe('messagesOf', () => {
  it('reads a JSON body, the data of each event of a stream, and nothing of an empty body', () => {
    expect(messagesOf('application/json', '{"a":1}')).toEqual([{ a: 1 }]);
    expect(
      messagesOf(
        'text/event-stream',
        'event: message\ndata: {"a":1}\n\nid: 2\ndata: {"b":\ndata: 2}\n\n',
      ),
    ).toEqual([{ a: 1 }, { b: 2 }]);
    expect(messagesOf('text/event-stream; charset=utf-8', 'data:{"c":3}\r\n\r\n')).toEqual([
      { c: 3 },
    ]);
    expect(messagesOf('application/json', '  ')).toEqual([]);
  });
});

describe.skipIf(windows)('the stdio shim over the Unix socket of the server (N161)', () => {
  it('the server listens on the socket, and each grant carries the shim with the token', async () => {
    const server = await start();
    expect(server.socketPath).toBe(join(root, 'mcp.sock'));
    expect(existsSync(join(root, 'mcp.sock'))).toBe(true);
    const grant = grantOf(server);
    const launch = launchOf(grant);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([STDIO_SHIM_PATH]);
    expect(launch.env[SHIM_SOCKET_ENV]).toBe(server.socketPath);
    expect(launch.env[SHIM_AUTHORIZATION_ENV]).toBe(grant.server.headers?.Authorization);
    await server.stop();
    expect(existsSync(join(root, 'mcp.sock'))).toBe(false);
  });

  it('carries initialize and tools/list, and answers only the tools of the role', async () => {
    const server = await start();
    const launch = launchOf(grantOf(server, 'author'));
    const replies = await inProcess(
      launch.env[SHIM_SOCKET_ENV] ?? '',
      launch.env[SHIM_AUTHORIZATION_ENV] ?? '',
      [initialize, initialized, list].map((message) => JSON.stringify(message)),
    );
    // The notification has no reply: one per request.
    expect(replies.map((reply) => reply.id).sort()).toEqual([1, 2]);
    const tools = toolNames(replies.find((reply) => reply.id === 2));
    expect(tools).toContain('submit_plan');
    expect(tools).not.toContain('submit_critique');
  });

  it('answers an error with the id of the request for a wrong token, and nothing for a notification', async () => {
    const server = await start();
    const replies = await inProcess(server.socketPath ?? '', 'Bearer nope', [
      JSON.stringify(initialize),
      JSON.stringify(initialized),
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(1);
    expect(replies[0]?.error?.code).toBeTypeOf('number');
  });

  it('answers -32000 when the server is not there, and -32700 for a line that is not JSON', async () => {
    const replies = await inProcess(join(root, 'none.sock'), 'Bearer x', [
      JSON.stringify(list),
      'not json',
    ]);
    const byId = new Map(replies.map((reply) => [reply.id, reply.error?.code]));
    expect(byId.get(2)).toBe(SHIM_ERROR_CODE);
    expect(byId.get(null)).toBe(-32700);
  });

  it('the built shim, started as the grant says, carries a session over stdio', async () => {
    expect(
      existsSync(STDIO_SHIM_PATH),
      'pnpm build first: the client starts the shim from dist',
    ).toBe(true);
    const server = await start();
    const launch = launchOf(grantOf(server, 'critic'));
    const child = spawn(launch.command, [...launch.args], {
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
    for (const message of [initialize, initialized, list]) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.stdin.end();
    expect(await exit, stderr).toBe(0);
    const replies = stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Reply);
    expect(toolNames(replies.find((reply) => reply.id === 2))).toContain('submit_critique');
  });

  it('the built shim exits 2 without its environment', async () => {
    const child = spawn(process.execPath, [STDIO_SHIM_PATH], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(2);
    expect(stderr).toContain(SHIM_SOCKET_ENV);
  });
});
