// SPDX-License-Identifier: MPL-2.0
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLogger } from '../test-helpers.js';
import {
  connectPluginServer,
  PluginStartRefused,
  type PluginConnectSpec,
  type PluginConnection,
} from './mcp-client.js';
import { fixtureManifest, FIXTURE_SERVER_PATH } from './test-plugin-fixture.js';

const open: PluginConnection[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

function specFor(
  args: readonly string[] = [],
  patch: Partial<PluginConnectSpec> = {},
): PluginConnectSpec {
  return {
    server: fixtureManifest({ args }).server,
    dir: dirname(FIXTURE_SERVER_PATH),
    env: { PATH: process.env.PATH ?? '', HOME: '/tmp/plugin-home-that-does-not-exist' },
    startTimeoutMs: 20_000,
    http: 'loopback',
    logger: captureLogger().logger,
    ...patch,
  };
}

async function connect(args: readonly string[] = [], patch: Partial<PluginConnectSpec> = {}) {
  const connection = await connectPluginServer(specFor(args, patch));
  open.push(connection);
  return connection;
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? '').join('');
}

describe('connectPluginServer (stdio, real process)', () => {
  it('connects, lists the tools with their schemas, and calls one', async () => {
    const connection = await connect();
    expect(connection.pid).toBeGreaterThan(0);
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'crash',
      'echo',
      'env_report',
      'pid',
      'slow',
    ]);
    expect(tools.find((tool) => tool.name === 'echo')?.inputSchema).toMatchObject({
      type: 'object',
    });
    const result = await connection.callTool(
      'echo',
      { text: 'hi' },
      {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      },
    );
    expect(textOf(result)).toBe('echo:hi');
  });

  it('the process does not see the environment of the daemon', async () => {
    vi.stubEnv('OTHEATER_DAEMON_SECRET', 'do-not-leak');
    try {
      const connection = await connect();
      const result = await connection.callTool(
        'env_report',
        { name: 'OTHEATER_DAEMON_SECRET' },
        {
          signal: new AbortController().signal,
          timeoutMs: 10_000,
        },
      );
      const report = JSON.parse(textOf(result)) as { keys: string[]; value: string | null };
      expect(report.value).toBeNull();
      expect(report.keys).not.toContain('OTHEATER_DAEMON_SECRET');
      for (const key of ['SHELL', 'USER', 'LOGNAME', 'TERM']) {
        if (process.env[key] !== undefined) expect(report.keys).not.toContain(key);
      }
      expect(report.keys).toContain('HOME');
      const home = await connection.callTool(
        'env_report',
        { name: 'HOME' },
        {
          signal: new AbortController().signal,
          timeoutMs: 10_000,
        },
      );
      expect((JSON.parse(textOf(home)) as { value: string }).value).toBe(
        '/tmp/plugin-home-that-does-not-exist',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('runs in the folder of the plugin', async () => {
    const connection = await connect();
    const result = await connection.callTool(
      'env_report',
      {},
      {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      },
    );
    const report = JSON.parse(textOf(result)) as { cwd: string };
    expect(report.cwd).toBe(dirname(FIXTURE_SERVER_PATH));
  });

  it('gives back a tool error as a result, not as a rejection', async () => {
    const connection = await connect(['--no-exit']);
    const result = await connection.callTool(
      'crash',
      {},
      {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      },
    );
    expect(result.isError).toBe(true);
  });

  it('reports a process that dies, once, and a listener given late hears of it too', async () => {
    const connection = await connect();
    const reasons: string[] = [];
    connection.onUnexpectedClose((reason) => reasons.push(reason));
    await expect(
      connection.callTool('crash', {}, { signal: new AbortController().signal, timeoutMs: 10_000 }),
    ).rejects.toBeDefined();
    await vi.waitFor(() => {
      expect(reasons).toHaveLength(1);
    });
    const late: string[] = [];
    connection.onUnexpectedClose((reason) => late.push(reason));
    expect(late).toHaveLength(1);
  });

  it('a close() asked for is not reported as a death', async () => {
    const connection = await connect();
    const reasons: string[] = [];
    connection.onUnexpectedClose((reason) => reasons.push(reason));
    await connection.close();
    await connection.close();
    expect(reasons).toEqual([]);
  });

  it('a call aborted by its signal rejects', async () => {
    const connection = await connect();
    const abort = new AbortController();
    const pending = connection.callTool(
      'slow',
      { ms: 20_000 },
      { signal: abort.signal, timeoutMs: 30_000 },
    );
    abort.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it('a server that exits at once makes the start fail', async () => {
    await expect(connectPluginServer(specFor(['--crash-on-start']))).rejects.toBeDefined();
  });

  it('refuses a cwd outside the folder of the plugin', async () => {
    const server = fixtureManifest().server;
    if (server.type !== 'stdio') throw new Error('the fixture is stdio');
    await expect(
      connectPluginServer(specFor([], { server: { ...server, cwd: '../..' } })),
    ).rejects.toBeInstanceOf(PluginStartRefused);
  });
});

describe('connectPluginServer (http)', () => {
  const http = (url: string): PluginConnectSpec['server'] => ({ type: 'http', url });

  it('refuses http when plugins.http is off', async () => {
    await expect(
      connectPluginServer(specFor([], { server: http('http://127.0.0.1:9/mcp'), http: 'off' })),
    ).rejects.toThrow(/plugins\.http/);
  });

  it('refuses an http server outside the loopback', async () => {
    for (const url of [
      'https://example.com/mcp',
      'http://10.0.0.5:8080/mcp',
      'http://127.evil.com/mcp',
    ]) {
      await expect(connectPluginServer(specFor([], { server: http(url) }))).rejects.toBeInstanceOf(
        PluginStartRefused,
      );
    }
  });
});
