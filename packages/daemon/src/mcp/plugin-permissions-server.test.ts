// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parsePluginManifest, type NewEvent } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPROVE_LABEL, DENY_LABEL, type AskApproval } from '../browser/approval.js';
import { PluginAggregator, type ActivePlugin } from '../plugins/aggregate.js';
import {
  DEFAULT_PLUGIN_PERMISSIONS,
  type PluginPermissionSettings,
} from '../plugins/permissions.js';
import { PluginProcessPool } from '../plugins/process-pool.js';
import { DEFAULT_PLUGIN_RUNTIME, type PluginNotice } from '../plugins/runtime-config.js';
import { FIXTURE_SERVER_PATH, StaticPluginSource } from '../plugins/test-plugin-fixture.js';
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
    tools?: { name: string }[];
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

/**
 * A plugin over the test server with one tool that asks by manifest (`echo`), one `external_write`
 * that asks by the policy of the daemon (`env_report`), and one plain read (`pid`).
 */
function approvalPlugin(): ActivePlugin {
  const result = parsePluginManifest({
    manifest_version: 1,
    id: 'demo',
    version: '1.0.0',
    server: { type: 'stdio', command: [process.execPath, FIXTURE_SERVER_PATH] },
    tools: [
      { name: 'echo', roles: ['author'], effects: 'read', requires_producer_approval: true },
      { name: 'env_report', roles: ['author'], effects: 'external_write' },
      { name: 'pid', roles: ['author', 'critic'], effects: 'read' },
    ],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  const { manifest } = result;
  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    dir: dirname(FIXTURE_SERVER_PATH),
    manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  };
}

interface Asked {
  scenarioId: string;
  question: string;
  labels: string[];
}

async function setup(
  options: {
    /** The label to answer with; `unavailable` and `cancelled` stand for no card and for no answer. */
    answer?: string;
    askApproval?: false;
    permissions?: Partial<PluginPermissionSettings>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'ot-mcp-plugin-perms-'));
  homes.push(home);
  const { logger } = captureLogger();
  const pool = new PluginProcessPool({
    clock: new FakeClock(),
    logger,
    runtime: () => ({ ...DEFAULT_PLUGIN_RUNTIME, startTimeoutMs: 20_000 }),
    homeRoot: home,
  });
  const plugins = new PluginAggregator({
    source: new StaticPluginSource({ p1: [approvalPlugin()] }),
    pool,
    logger,
    reservedNames: () => registries.tools.list().map((tool) => tool.name),
  });
  const asked: Asked[] = [];
  const notices: PluginNotice[] = [];
  const answer = options.answer ?? APPROVE_LABEL;
  const askApproval: AskApproval = (scenarioId, input) => {
    const question = input.questions[0];
    asked.push({
      scenarioId,
      question: question?.question ?? '',
      labels: (question?.options ?? []).map((option) => option.label),
    });
    if (answer === 'unavailable') return Promise.resolve(undefined);
    return Promise.resolve({
      decisionId: `decision-${String(asked.length)}`,
      answer:
        answer === 'cancelled' ? Promise.reject(new Error('cancelled')) : Promise.resolve(answer),
    });
  };
  const server = await FrameworkMcpServer.start({
    registries,
    port: 'auto',
    submitRetries: 2,
    handlers: new ToolHandlers(),
    logger,
    version: '0.0.0-test',
    plugins,
    projectOf: (input) =>
      Promise.resolve(input.correlation.playId === 'play-p1' ? 'p1' : undefined),
    pluginPermissions: () => ({ ...DEFAULT_PLUGIN_PERMISSIONS, ...options.permissions }),
    ...(options.askApproval === false ? {} : { askApproval }),
    onPluginNotice: (notice) => notices.push(notice),
  });
  running.push(server);
  const events: NewEvent[] = [];
  const grantFor = (role: string, pluginTools?: readonly string[]): McpGrant =>
    server.grant({
      attemptId: 'play-p1/d1/1',
      role,
      correlation: { playId: 'play-p1', demandId: 'd1', attemptId: 'play-p1/d1/1' },
      record: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      ...(pluginTools === undefined ? {} : { pluginTools }),
    });
  const call = vi.spyOn(pool, 'call');
  return { server, grantFor, asked, notices, events, call };
}

const callTool = (
  server: FrameworkMcpServer,
  grant: McpGrant,
  name: string,
  args: Record<string, unknown> = {},
) => rpc(server, grant, 'tools/call', { name, arguments: args });

const typesOf = (events: readonly NewEvent[]): string[] => events.map((event) => event.type);

describe('the approval card of a plugin tool (P6)', () => {
  it('asks the Producer by the project, and runs the tool only on an Allow', async () => {
    const { server, grantFor, asked, call, events } = await setup({ answer: APPROVE_LABEL });
    const grant = grantFor('author', ['demo__echo', 'demo__pid']);
    const { result } = await callTool(server, grant, 'demo__echo', { text: 'hi' });
    expect(result?.isError ?? false).toBe(false);
    expect(result?.content?.[0]?.text).toBe('echo:hi');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ scenarioId: 'p1', labels: [APPROVE_LABEL, DENY_LABEL] });
    expect(asked[0]?.question).toContain('demo__echo');
    // The card tells the keys of the arguments and never what was typed.
    expect(asked[0]?.question).toContain('text');
    expect(asked[0]?.question).not.toContain('hi');
    expect(call).toHaveBeenCalledTimes(1);
    expect(typesOf(events)).toEqual(['permission.asked', 'permission.answered']);
    expect(events[1]?.payload).toMatchObject({
      answer: 'allow',
      reason: 'plugin_tool_approved',
      rule: 'plugin:demo',
      tool: 'demo__echo',
    });
  });

  it('a Deny refuses the call and the plugin never receives it', async () => {
    const { server, grantFor, call, events, notices } = await setup({ answer: DENY_LABEL });
    const grant = grantFor('author', ['demo__echo', 'demo__pid']);
    const { result } = await callTool(server, grant, 'demo__echo', { text: 'hi' });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ error: 'approval_denied' });
    expect(call).not.toHaveBeenCalled();
    expect(events[1]?.payload).toMatchObject({ answer: 'reject', reason: 'plugin_tool_refused' });
    expect(notices).toEqual([
      {
        kind: 'tool_refused',
        plugin: 'demo',
        project: 'p1',
        tool: 'echo',
        role: 'author',
        reason: 'approval_denied',
      },
    ]);
  });

  it('asks again at the next call: an Allow holds for one call only', async () => {
    const { server, grantFor, asked } = await setup({ answer: APPROVE_LABEL });
    const grant = grantFor('author', ['demo__echo']);
    await callTool(server, grant, 'demo__echo', { text: 'a' });
    await callTool(server, grant, 'demo__echo', { text: 'b' });
    expect(asked).toHaveLength(2);
  });

  it('with nobody to ask the tool is refused, never allowed', async () => {
    for (const setupOptions of [{ askApproval: false as const }, { answer: 'unavailable' }]) {
      const { server, grantFor, call, notices } = await setup(setupOptions);
      const { result } = await callTool(server, grantFor('author', ['demo__echo']), 'demo__echo', {
        text: 'x',
      });
      expect(result?.structuredContent).toMatchObject({ error: 'approval_unavailable' });
      expect(call).not.toHaveBeenCalled();
      expect(notices[0]).toMatchObject({ reason: 'approval_unavailable' });
    }
  });

  it('a question that ends with no answer is a cancelled refusal', async () => {
    const { server, grantFor, call } = await setup({ answer: 'cancelled' });
    const { result } = await callTool(server, grantFor('author', ['demo__echo']), 'demo__echo');
    expect(result?.structuredContent).toMatchObject({ error: 'approval_cancelled' });
    expect(call).not.toHaveBeenCalled();
  });

  it('an answer that is not exactly Allow is a refusal', async () => {
    const { server, grantFor, call } = await setup({ answer: 'Maybe later' });
    const { result } = await callTool(server, grantFor('author', ['demo__echo']), 'demo__echo');
    expect(result?.structuredContent).toMatchObject({ error: 'approval_denied' });
    expect(call).not.toHaveBeenCalled();
  });

  it('external_write asks by the config even when the manifest does not; manifest mode does not', async () => {
    const asking = await setup({ answer: DENY_LABEL });
    const refused = await callTool(
      asking.server,
      asking.grantFor('author', ['demo__env_report']),
      'demo__env_report',
      { name: 'X' },
    );
    expect(refused.result?.structuredContent).toMatchObject({ error: 'approval_denied' });
    expect(asking.call).not.toHaveBeenCalled();

    const manifestOnly = await setup({
      answer: DENY_LABEL,
      permissions: { externalWriteApproval: 'manifest' },
    });
    const ran = await callTool(
      manifestOnly.server,
      manifestOnly.grantFor('author', ['demo__env_report']),
      'demo__env_report',
      { name: 'X' },
    );
    expect(ran.result?.isError ?? false).toBe(false);
    expect(manifestOnly.asked).toHaveLength(0);
    expect(manifestOnly.call).toHaveBeenCalledTimes(1);
  });

  it('approval_detail: values puts the arguments on the card', async () => {
    const { server, grantFor, asked } = await setup({ permissions: { approvalDetail: 'values' } });
    await callTool(server, grantFor('author', ['demo__echo']), 'demo__echo', { text: 'seen' });
    expect(asked[0]?.question).toContain('seen');
  });

  it('a tool that asks for nothing does not open a card', async () => {
    const { server, grantFor, asked, events } = await setup();
    const { result } = await callTool(server, grantFor('author', ['demo__pid']), 'demo__pid');
    expect(result?.isError ?? false).toBe(false);
    expect(asked).toHaveLength(0);
    expect(events).toEqual([]);
  });
});

describe('the grant of the session is the door (P6)', () => {
  it('lists only the tools of the grant', async () => {
    const { server, grantFor } = await setup();
    const names = (
      (await rpc(server, grantFor('author', ['demo__pid']), 'tools/list', {})).result?.tools ?? []
    ).map((tool) => tool.name);
    expect(names).toContain('demo__pid');
    expect(names).not.toContain('demo__echo');
    expect(names).not.toContain('demo__env_report');
  });

  it('a direct call to a tool outside the grant never reaches the plugin or the card', async () => {
    const { server, grantFor, call, asked } = await setup();
    const grant = grantFor('author', ['demo__pid']);
    const { result, error } = await callTool(server, grant, 'demo__echo', { text: 'x' });
    expect(result?.isError === true || error !== undefined).toBe(true);
    expect(result?.content?.[0]?.text ?? '').not.toContain('echo:');
    expect(call).not.toHaveBeenCalled();
    expect(asked).toHaveLength(0);
  });

  it('an empty grant list gives no plugin tool even to a role the manifest lists', async () => {
    const { server, grantFor, call } = await setup();
    const grant = grantFor('author', []);
    const names = ((await rpc(server, grant, 'tools/list', {})).result?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names.filter((name) => name.startsWith('demo__'))).toEqual([]);
    await callTool(server, grant, 'demo__pid');
    expect(call).not.toHaveBeenCalled();
  });

  it('works out the tools of a role under its policy (the Critic reads, the writer needs the edit)', async () => {
    const { server } = await setup();
    const reader = {
      nativeTools: ['read', 'search'],
      nativeShell: 'none',
      network: { allow: [] },
    } as const;
    const writer = { ...reader, nativeTools: ['read', 'search', 'edit', 'write'] } as const;
    const correlation = { playId: 'play-p1', demandId: 'd1', attemptId: 'a' };
    expect(await server.pluginTools({ role: 'critic', correlation, policy: reader })).toEqual([
      'demo__pid',
    ]);
    expect(await server.pluginTools({ role: 'author', correlation, policy: reader })).toEqual([
      'demo__echo',
      'demo__pid',
    ]);
    expect(await server.pluginTools({ role: 'author', correlation, policy: writer })).toEqual([
      'demo__echo',
      'demo__env_report',
      'demo__pid',
    ]);
    // A play of no project has no plugin tool.
    expect(
      await server.pluginTools({
        role: 'author',
        correlation: { ...correlation, playId: 'other' },
        policy: writer,
      }),
    ).toEqual([]);
  });
});
