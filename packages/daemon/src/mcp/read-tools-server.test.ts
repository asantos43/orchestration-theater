// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { buildDaemonRegistries } from '../registries.js';
import { captureLogger } from '../test-helpers.js';
import { FrameworkMcpServer, ToolHandlers, registerReadTools, type McpGrant } from './index.js';
import { seedReadTools as seed } from './read-tools-fixture.js';

const registries = buildDaemonRegistries();

function newStore(): InMemoryStore {
  return new InMemoryStore({ clock: new FakeClock(1_000) });
}
const running: FrameworkMcpServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function start(store: Store): Promise<FrameworkMcpServer> {
  const { logger } = captureLogger();
  const server = await FrameworkMcpServer.start({
    registries,
    port: 'auto',
    submitRetries: 2,
    handlers: registerReadTools(new ToolHandlers(), store),
    logger,
    version: '0.0.0-test',
  });
  running.push(server);
  return server;
}

function grantFor(server: FrameworkMcpServer, role: string, playId: string): McpGrant {
  const attemptId = `${playId}/d1/1`;
  return server.grant({
    attemptId,
    role,
    correlation: { playId, demandId: 'd1', attemptId },
    record: () => Promise.resolve(),
  });
}

async function call(
  server: FrameworkMcpServer,
  grant: McpGrant,
  name: string,
  args: unknown,
): Promise<ToolResult | undefined> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...grant.server.headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  // The answer is JSON, or one SSE `data:` frame with the JSON.
  const data = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim() ?? '{}');
  return (JSON.parse(data) as { result?: ToolResult }).result;
}

describe('the read tools through the MCP server', () => {
  it('serves the version asked for to every Executor role, as structured content', async () => {
    const store = newStore();
    await seed(store);
    const server = await start(store);
    for (const role of ['author', 'reviewer', 'scriptwriter', 'actor', 'critic']) {
      const grant = grantFor(server, role, 'p1');
      const result = await call(server, grant, 'read_blackboard', { key: 'script', version: 1 });
      expect(result?.isError ?? false, role).toBe(false);
      expect(result?.structuredContent, role).toMatchObject({ version: 1, value: { v: 1 } });
    }
    const grant = grantFor(server, 'actor', 'p1');
    const contract = await call(server, grant, 'read_contract', { id: 'c1' });
    expect(contract?.structuredContent).toMatchObject({ key: 'contract/c1', version: 2 });
    const decision = await call(server, grant, 'read_decision', { id: 'D-own' });
    expect(decision?.structuredContent).toMatchObject({ id: 'D-own' });
  });

  it('turns a miss into an error result with its code, not into internal_error', async () => {
    const store = newStore();
    await seed(store);
    const server = await start(store);
    const grant = grantFor(server, 'actor', 'p1');
    const miss = await call(server, grant, 'read_blackboard', { key: 'script', version: 7 });
    expect(miss?.isError).toBe(true);
    expect(miss?.structuredContent).toMatchObject({ error: 'not_found' });
    const foreign = await call(server, grant, 'read_decision', { id: 'D-foreign' });
    expect(foreign?.structuredContent).toMatchObject({ error: 'not_found' });
  });

  it('rejects a version that is not a positive integer before the handler runs', async () => {
    const store = newStore();
    await seed(store);
    const server = await start(store);
    const grant = grantFor(server, 'actor', 'p1');
    for (const version of [0, -1, 1.5, '1']) {
      const result = await call(server, grant, 'read_blackboard', { key: 'script', version });
      // Either a protocol error (no result) or an error result: never a read.
      expect(result === undefined || result.isError === true, String(version)).toBe(true);
      expect(result?.structuredContent?.key).toBeUndefined();
    }
  });
});
