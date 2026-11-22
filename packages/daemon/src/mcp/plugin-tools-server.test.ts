// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginAggregator } from '../plugins/aggregate.js';
import { PluginProcessPool } from '../plugins/process-pool.js';
import { DEFAULT_PLUGIN_RUNTIME, type PluginRuntimeConfig } from '../plugins/runtime-config.js';
import { fixturePlugin, StaticPluginSource } from '../plugins/test-plugin-fixture.js';
import { buildDaemonRegistries } from '../registries.js';
import { captureLogger } from '../test-helpers.js';
import { FrameworkMcpServer, ToolHandlers, type McpGrant } from './index.js';

const registries = buildDaemonRegistries();
const running: FrameworkMcpServer[] = [];
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

interface Rpc {
  result?: {
    tools?: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
    isError?: boolean;
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  error?: { message: string };
}

async function rpc(
  server: FrameworkMcpServer,
  grant: McpGrant,
  method: string,
  params: unknown,
): Promise<Rpc> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...grant.server.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const data = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim() ?? '{}');
  return JSON.parse(data) as Rpc;
}

async function setup(
  options: {
    project?: string;
    runtime?: Partial<PluginRuntimeConfig>;
    args?: string[];
    withPlugins?: boolean;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'ot-mcp-plugins-'));
  homes.push(home);
  const { logger } = captureLogger();
  const clock = new FakeClock();
  const source = new StaticPluginSource({
    p1: [fixturePlugin(options.args === undefined ? {} : { args: options.args })],
  });
  const pool = new PluginProcessPool({
    clock,
    logger,
    runtime: () => ({ ...DEFAULT_PLUGIN_RUNTIME, startTimeoutMs: 20_000, ...options.runtime }),
    homeRoot: home,
  });
  const plugins = new PluginAggregator({
    source,
    pool,
    logger,
    reservedNames: () => registries.tools.list().map((tool) => tool.name),
  });
  const server = await FrameworkMcpServer.start({
    registries,
    port: 'auto',
    submitRetries: 2,
    handlers: new ToolHandlers(),
    logger,
    version: '0.0.0-test',
    ...(options.withPlugins === false ? {} : { plugins }),
    projectOf: (input) =>
      Promise.resolve(input.correlation.playId === 'play-p1' ? 'p1' : undefined),
  });
  running.push(server);
  const grantFor = (role: string, playId = 'play-p1', project?: string): McpGrant =>
    server.grant({
      attemptId: `${playId}/d1/1`,
      role,
      correlation: { playId, demandId: 'd1', attemptId: `${playId}/d1/1` },
      record: () => Promise.resolve(),
      ...(project === undefined ? {} : { project }),
    });
  return { server, pool, clock, grantFor };
}

const listNames = async (server: FrameworkMcpServer, grant: McpGrant): Promise<string[]> =>
  ((await rpc(server, grant, 'tools/list', {})).result?.tools ?? []).map((tool) => tool.name);

describe('the tools of the plugins in the otheater server', () => {
  it('shows a declared tool to the right role and not to the others', async () => {
    const { server, grantFor } = await setup();
    const author = await listNames(server, grantFor('author'));
    expect(author).toEqual(expect.arrayContaining(['demo__echo', 'demo__pid', 'demo__slow']));
    const reviewer = await listNames(server, grantFor('reviewer'));
    expect(reviewer).toContain('demo__echo');
    expect(reviewer).not.toContain('demo__pid');
    const consultant = await listNames(server, grantFor('consultant'));
    expect(consultant.filter((name) => name.startsWith('demo__'))).toEqual([]);
    // The framework tools stay where they were.
    expect(author.some((name) => !name.startsWith('demo__'))).toBe(true);
  });

  it('gives the schema the server of the plugin declared', async () => {
    const { server, grantFor } = await setup();
    const { result } = await rpc(server, grantFor('reviewer'), 'tools/list', {});
    const echo = result?.tools?.find((tool) => tool.name === 'demo__echo');
    expect(echo?.inputSchema).toMatchObject({ type: 'object', properties: { text: {} } });
  });

  it('the call goes to the plugin and comes back', async () => {
    const { server, grantFor } = await setup();
    const grant = grantFor('reviewer');
    const { result } = await rpc(server, grant, 'tools/call', {
      name: 'demo__echo',
      arguments: { text: 'hello' },
    });
    expect(result?.isError ?? false).toBe(false);
    expect(result?.content?.[0]?.text).toBe('echo:hello');
  });

  it('a role that does not see the tool cannot call it', async () => {
    const { server, grantFor } = await setup();
    const { result, error } = await rpc(server, grantFor('critic'), 'tools/call', {
      name: 'demo__echo',
      arguments: { text: 'hello' },
    });
    expect(result?.isError === true || error !== undefined).toBe(true);
    expect(result?.content?.[0]?.text ?? '').not.toContain('echo:');
  });

  it('a call that outlives the deadline is a tool error', async () => {
    const { server, grantFor, clock } = await setup({
      runtime: { callTimeoutMs: 300, idleTimeoutMs: null },
    });
    const grant = grantFor('author');
    await listNames(server, grant);
    const pending = rpc(server, grant, 'tools/call', {
      name: 'demo__slow',
      arguments: { ms: 30_000 },
    });
    await vi.waitFor(
      () => {
        expect(clock.pendingSleeps).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    await clock.advance(300);
    const { result } = await pending;
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ error: 'plugin_timeout' });
  });

  it('survives a crash: the call fails, and the next use after the wait is served', async () => {
    const { server, grantFor, clock, pool } = await setup({
      runtime: { idleTimeoutMs: null, restartBackoff: { initialMs: 1_000, maxMs: 1_000 } },
    });
    const grant = grantFor('author');
    await listNames(server, grant);
    const crashed = await rpc(server, grant, 'tools/call', { name: 'demo__crash', arguments: {} });
    expect(crashed.result?.isError).toBe(true);
    await vi.waitFor(() => {
      expect(pool.status('p1', 'demo').phase).toBe('stopped');
    });
    const waiting = await rpc(server, grant, 'tools/call', { name: 'demo__pid', arguments: {} });
    expect(waiting.result?.structuredContent).toMatchObject({ error: 'plugin_unavailable' });
    await clock.advance(1_000);
    const back = await rpc(server, grant, 'tools/call', { name: 'demo__pid', arguments: {} });
    expect(back.result?.isError ?? false).toBe(false);
  });

  it('the process stops when idle and comes back on the next call', async () => {
    const { server, grantFor, clock, pool } = await setup({ runtime: { idleTimeoutMs: 2_000 } });
    const grant = grantFor('reviewer');
    await rpc(server, grant, 'tools/call', { name: 'demo__echo', arguments: { text: 'a' } });
    expect(pool.running).toBe(1);
    await clock.advance(2_000);
    expect(pool.running).toBe(0);
    const again = await rpc(server, grant, 'tools/call', {
      name: 'demo__echo',
      arguments: { text: 'b' },
    });
    expect(again.result?.content?.[0]?.text).toBe('echo:b');
    expect(pool.running).toBe(1);
  });

  it('the process does not see the environment of the daemon', async () => {
    vi.stubEnv('OTHEATER_DAEMON_SECRET', 'do-not-leak');
    try {
      const { server, grantFor } = await setup();
      const { result } = await rpc(server, grantFor('author'), 'tools/call', {
        name: 'demo__env_report',
        arguments: { name: 'OTHEATER_DAEMON_SECRET' },
      });
      const body = JSON.parse(result?.content?.[0]?.text ?? '{}') as {
        value: unknown;
        keys: string[];
      };
      expect(body.value).toBeNull();
      expect(body.keys).not.toContain('OTHEATER_DAEMON_SECRET');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a grant of another project, or of none, gets no plugin tool', async () => {
    const { server, grantFor } = await setup();
    expect(await listNames(server, grantFor('author', 'play-other'))).not.toContain('demo__echo');
    expect(await listNames(server, grantFor('author', 'play-other', 'p1'))).toContain('demo__echo');
  });

  it('a server without plugins has the framework tools only', async () => {
    const { server, grantFor } = await setup({ withPlugins: false });
    const names = await listNames(server, grantFor('author'));
    expect(names.some((name) => name.startsWith('demo__'))).toBe(false);
    expect(names.length).toBeGreaterThan(0);
  });

  it('stopping the server stops the processes of the plugins', async () => {
    const { server, grantFor, pool } = await setup();
    await listNames(server, grantFor('reviewer'));
    expect(pool.running).toBe(1);
    await server.stop();
    expect(pool.running).toBe(0);
  });
});
