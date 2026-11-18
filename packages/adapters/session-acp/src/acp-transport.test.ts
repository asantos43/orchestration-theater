// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchedProcess, SessionNormalizer, SessionOpenParams } from '@otheater/core';
import { normalizeFakeError, normalizeFakeUpdate } from '@otheater/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@otheater/core';
import { AcpTransport, permissionRequestOf, type AcpTransportWarning } from './acp-transport.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';
import { removeDir } from './testing/remove-dir.js';

// `AcpTransport` against a stub agent: a few lines of plain Node that speak raw JSON-RPC on stdio,
// so each test can make the agent say exactly what it needs (no `loadSession`, `session/load` that
// answers not-found, silence, an agent that ignores `session/cancel` and leaves a grandchild).

const STUB = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const cfg = JSON.parse(process.env.STUB_CONFIG ?? '{}');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const record = (method, params) => {
  if (cfg.recordTo) appendFileSync(cfg.recordTo, JSON.stringify({ method, params }) + '\n');
};
if (cfg.grandchild) {
  // Same process group (POSIX) or process tree (Windows) as the stub: a tree kill has to reach it.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  record('grandchild', { pid: grandchild.pid });
}
// cfg.script: on session/prompt the stub plays these steps in order, then ends the turn. A step
// { update } is sent as a session/update; a step { permission } is a session/request_permission
// that the stub waits to be answered (the answer is recorded as "permission-answer").
const waiting = new Map();
let asked = 0;
async function play(sessionId, promptId) {
  for (const step of cfg.script) {
    if (step.update) {
      send({ method: 'session/update', params: { sessionId, update: step.update } });
    } else if (step.permission) {
      asked += 1;
      const id = 'p' + asked;
      const answered = new Promise((resolve) => waiting.set(id, resolve));
      send({ id, method: 'session/request_permission', params: { sessionId, ...step.permission } });
      record('permission-answer', (await answered).result);
    }
  }
  send({ id: promptId, result: { stopReason: 'end_turn' } });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message);
    return;
  }
  record(message.method, message.params);
  switch (message.method) {
    case 'initialize':
      if (cfg.silent) return;
      send({
        id: message.id,
        result: {
          protocolVersion: cfg.protocolVersion ?? message.params.protocolVersion,
          agentCapabilities: {
            loadSession: cfg.loadSession === true,
            mcpCapabilities: { http: cfg.http === true },
          },
          ...(cfg.agentInfo === undefined ? {} : { agentInfo: cfg.agentInfo }),
          authMethods: [],
        },
      });
      return;
    case 'session/new':
      send({
        id: message.id,
        result: { sessionId: 'stub-1', ...(cfg.configOptions ? { configOptions: cfg.configOptions } : {}) },
      });
      return;
    case 'session/set_config_option':
      send({ id: message.id, result: { configOptions: cfg.afterSet ?? [] } });
      return;
    case 'session/prompt':
      if (cfg.script) {
        void play(message.params.sessionId, message.id);
        return;
      }
      // With updateOnPrompt the client reports a changed option list, then never answers.
      if (cfg.updateOnPrompt) {
        send({
          method: 'session/update',
          params: {
            sessionId: message.params.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions: cfg.updateOnPrompt },
          },
        });
      }
      return;
    case 'session/load':
      send({ id: message.id, error: { code: -32002, message: 'session not found' } });
      return;
    default:
      // session/prompt never answers; session/cancel is ignored on purpose.
      return;
  }
});
`;

const normalizer: SessionNormalizer = {
  normalizeUpdate: normalizeFakeUpdate,
  normalizeError: normalizeFakeError,
};

let dir: string;
let stubPath: string;
const launcher = new NodeProcessLauncher();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otheater-acp-stub-'));
  stubPath = join(dir, 'stub-agent.mjs');
  await writeFile(stubPath, STUB);
});

afterAll(async () => {
  expect(launcher.aliveGroups()).toBe(0);
  await removeDir(dir);
});

const launched: LaunchedProcess[] = [];
afterEach(async () => {
  await Promise.all(launched.splice(0).map((process) => process.killTree({ graceMs: 200 })));
});

interface StubOptions {
  readonly config?: Record<string, unknown>;
  readonly mcpServers?: SessionOpenParams['mcpServers'];
  readonly meta?: unknown;
  readonly configOptions?: Record<string, string>;
}

async function params(
  name: string,
  options: StubOptions = {},
): Promise<{ open: SessionOpenParams; record: string }> {
  const record = join(dir, `${name}.jsonl`);
  const process = await launcher.launch({
    cmd: globalThis.process.execPath,
    args: [stubPath],
    cwd: dir,
    env: { STUB_CONFIG: JSON.stringify({ recordTo: record, ...options.config }) },
  });
  launched.push(process);
  return {
    record,
    open: {
      process,
      cwd: dir,
      setup: {
        via: 'acp',
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        configOptions: options.configOptions ?? {},
      },
      mcpServers: options.mcpServers ?? [],
      normalizer,
      onPermission: () => ({ outcome: 'cancelled' }),
    },
  };
}

/** True while a process with this pid exists (signal 0 only probes). */
function pidAlive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function recorded(file: string): Promise<{ method: string; params: unknown }[]> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { method: string; params: unknown });
}

describe('AcpTransport against a stub agent', () => {
  it('has the id acp', () => {
    expect(new AcpTransport().id).toBe('acp');
  });

  it('announces NO fs and NO terminal capability in initialize', async () => {
    const { open, record } = await params('capabilities');
    const session = await new AcpTransport({ clientVersion: '9.9.9' }).open(open);
    const [initialize] = await recorded(record);
    expect(initialize?.method).toBe('initialize');
    expect(initialize?.params).toMatchObject({
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'otheater', version: '9.9.9' },
    });
    await session.close();
  });

  describe('agentInfo of the initialize (N63)', () => {
    const seen = async (config: Record<string, unknown>, name: string) => {
      const { open } = await params(name, { config });
      const infos: unknown[] = [];
      const warnings: AcpTransportWarning[] = [];
      const session = await new AcpTransport({
        onWarning: (warning) => warnings.push(warning),
      }).open({
        ...open,
        onAgentInfo: (info) => infos.push(info),
      });
      await session.close();
      return { infos, warnings };
    };

    it('hands the name and version the client reported to the open', async () => {
      const { infos } = await seen(
        { agentInfo: { name: 'stub-acp', title: 'Stub', version: '1.2.3', extra: 1 } },
        'info-open',
      );
      expect(infos).toEqual([{ name: 'stub-acp', title: 'Stub', version: '1.2.3' }]);
    });

    it('says nothing when the client sent no agentInfo', async () => {
      expect((await seen({}, 'info-absent')).infos).toEqual([]);
    });

    it.each([
      ['no version', { name: 'stub-acp' }],
      ['a number as version', { name: 'stub-acp', version: 3 }],
      ['no name', { version: '1.0.0' }],
      ['a string', 'stub-acp 1.0.0'],
    ])('ignores an agentInfo with %s', async (label, agentInfo) => {
      expect((await seen({ agentInfo }, `info-bad-${label}`.replace(/ /g, '-'))).infos).toEqual([]);
    });

    it('hands it to load as well', async () => {
      const { open } = await params('info-load', {
        config: { loadSession: true, agentInfo: { name: 'stub-acp', version: '2.0.0' } },
      });
      const infos: unknown[] = [];
      // The stub answers session/load with not-found, but the handshake (and the callback) comes first.
      await expect(
        new AcpTransport().load({ ...open, sessionId: 'x', onAgentInfo: (i) => infos.push(i) }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(infos).toEqual([{ name: 'stub-acp', version: '2.0.0' }]);
    });

    it('a callback that throws does not fail the open; it becomes a warning', async () => {
      const { open } = await params('info-throws', {
        config: { agentInfo: { name: 'stub-acp', version: '1.0.0' } },
      });
      const warnings: AcpTransportWarning[] = [];
      const session = await new AcpTransport({ onWarning: (w) => warnings.push(w) }).open({
        ...open,
        onAgentInfo: () => {
          throw new Error('boom');
        },
      });
      expect(session.sessionId).toBe('stub-1');
      expect(warnings.map((w) => w.kind)).toEqual(['agent_info_handler_threw']);
      await session.close();
    });
  });

  it('sends cwd, the MCP servers and _meta in session/new', async () => {
    const { open, record } = await params('new', {
      config: { http: true },
      meta: { claudeCode: { options: { settingSources: [] } } },
      mcpServers: [{ name: 'docs', url: 'http://127.0.0.1:9/mcp', headers: { 'x-a': 'b' } }],
    });
    const session = await new AcpTransport().open(open);
    expect(session.sessionId).toBe('stub-1');
    expect(session.canLoad).toBe(false);
    const created = (await recorded(record)).find((entry) => entry.method === 'session/new');
    expect(created?.params).toMatchObject({
      cwd: dir,
      mcpServers: [
        {
          type: 'http',
          name: 'docs',
          url: 'http://127.0.0.1:9/mcp',
          headers: [{ name: 'x-a', value: 'b' }],
        },
      ],
      _meta: { claudeCode: { options: { settingSources: [] } } },
    });
    await session.close();
  });

  describe('config options', () => {
    const effort = (current: string) => ({
      type: 'select',
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: current,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High', description: 'Thinks longer' },
      ],
    });

    it('exposes the options of session/new in the neutral form: groups, booleans, nulls, junk', async () => {
      const { open } = await params('options-new', {
        config: {
          configOptions: [
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              description: null,
              currentValue: 'a',
              options: [
                { group: 'g1', name: 'Group', options: [{ value: 'a', name: 'A' }] },
                { value: 'b', name: 'B', description: null },
                { name: 'no value' },
              ],
            },
            { type: 'boolean', id: 'brave', name: 'Brave', category: null, currentValue: true },
            { type: 'select', name: 'no id' },
            'not an object',
          ],
        },
      });
      const session = await new AcpTransport().open(open);
      expect(session.configOptions).toEqual([
        {
          id: 'model',
          type: 'select',
          name: 'Model',
          category: 'model',
          currentValue: 'a',
          options: [
            { group: 'g1', name: 'Group', options: [{ value: 'a', name: 'A' }] },
            { value: 'b', name: 'B' },
          ],
        },
        { id: 'brave', type: 'boolean', name: 'Brave', currentValue: true },
      ]);
      await session.close();
    });

    it('is empty when the client announces none', async () => {
      const { open } = await params('options-none');
      const session = await new AcpTransport().open(open);
      expect(session.configOptions).toEqual([]);
      await session.close();
    });

    it('follows the answer of the setup config calls and of setConfig', async () => {
      const { open } = await params('options-set', {
        config: { configOptions: [effort('low')], afterSet: [effort('high')] },
        configOptions: { effort: 'high' },
      });
      const session = await new AcpTransport().open(open);
      // The setup applied effort=high at open: the snapshot is the answer of that call.
      expect(session.configOptions[0]).toMatchObject({ id: 'effort', currentValue: 'high' });
      await session.close();
    });

    it('is replaced by a config_option_update of the client', async () => {
      const { open } = await params('options-update', {
        config: { configOptions: [effort('low')], updateOnPrompt: [effort('high')] },
      });
      const session = await new AcpTransport({ killGraceMs: 500 }).open(open);
      expect(session.configOptions[0]).toMatchObject({ currentValue: 'low' });
      const running = session.prompt([{ type: 'text', text: 'go' }]).then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.waitFor(() => {
        expect(session.configOptions[0]).toMatchObject({ currentValue: 'high' });
      });
      await session.close();
      expect(await running).toBe('rejected');
    });
  });

  it('refuses MCP servers when the client did not announce HTTP', async () => {
    const { open } = await params('no-http', {
      mcpServers: [{ name: 'docs', url: 'http://127.0.0.1:9/mcp' }],
    });
    await expect(new AcpTransport().open(open)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('load rejects with AdapterUnavailable when the client did not announce loadSession', async () => {
    const { open } = await params('no-load');
    await expect(new AcpTransport().load({ ...open, sessionId: 'any' })).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('load of an unknown conversation rejects with NotFound', async () => {
    const { open } = await params('not-found', { config: { loadSession: true } });
    await expect(new AcpTransport().load({ ...open, sessionId: 'gone' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects with AdapterUnavailable when the protocol version is not the one offered', async () => {
    const { open } = await params('version', { config: { protocolVersion: 99 } });
    await expect(new AcpTransport().open(open)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('rejects with AdapterUnavailable when the client stays silent past startTimeoutMs', async () => {
    const { open } = await params('silent', { config: { silent: true } });
    const started = Date.now();
    await expect(new AcpTransport({ startTimeoutMs: 200 }).open(open)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects with AdapterUnavailable when the process ends before answering', async () => {
    const { open } = await params('dies', { config: { silent: true } });
    const opening = new AcpTransport({ startTimeoutMs: 5000 }).open(open);
    const failure = opening.then(
      () => undefined,
      (error: unknown) => error,
    );
    await open.process.killTree({ graceMs: 100 });
    expect(await failure).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('cancel does not trust the client: the tree is killed, grandchild included', async () => {
    const warnings: AcpTransportWarning[] = [];
    const { open, record } = await params('ignores-cancel', { config: { grandchild: true } });
    const session = await new AcpTransport({
      cancelGraceMs: 100,
      killGraceMs: 500,
      onWarning: (warning) => warnings.push(warning),
    }).open(open);
    const running = session.prompt([{ type: 'text', text: 'hang' }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.cancel();
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(launcher.aliveGroups()).toBe(0);
    // The group/tree check above sees the root (Windows) or the group (POSIX); the grandchild
    // itself is checked by its own pid, on both.
    const grandchild = (await recorded(record)).find((entry) => entry.method === 'grandchild');
    const { pid } = grandchild?.params as { pid: number };
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(pidAlive(pid)).toBe(false);
    });
    expect(warnings).toEqual([]);
  });

  it('close ends the process even though the client never answered a prompt', async () => {
    const { open } = await params('close');
    const session = await new AcpTransport({ killGraceMs: 500 }).open(open);
    const running = session.prompt([{ type: 'text', text: 'hang' }]).then(
      () => 'resolved',
      () => 'rejected',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.close();
    expect(await running).toBe('rejected');
    expect(launcher.aliveGroups()).toBe(0);
  });
});

// The pair codex-acp 2.6.0 sends for an MCP call, as measured in the Phase 0 spike (2026-11-17).
const MCP_TOOL_CALL = {
  sessionUpdate: 'tool_call',
  toolCallId: 'exec-1',
  kind: 'execute',
  title: 'mcp.spike.ping',
  status: 'pending',
  rawInput: { server: 'spike', tool: 'ping', arguments: {} },
  _meta: { is_mcp_tool_call: true },
};
const CODEX_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
];
const MCP_REQUEST = {
  toolCall: { toolCallId: 'exec-1', kind: 'execute', status: 'pending' },
  options: CODEX_OPTIONS,
  _meta: { is_mcp_tool_approval: true },
};

describe('AcpTransport, the tool call that a permission request leaves out', () => {
  async function ask(script: unknown[], name: string): Promise<PermissionRequest[]> {
    const seen: PermissionRequest[] = [];
    const { open, record } = await params(name, { config: { script } });
    const session = await new AcpTransport().open({
      ...open,
      onPermission: (request) => {
        seen.push(request);
        return { outcome: 'selected', optionId: 'allow_once' };
      },
    });
    await session.prompt([{ type: 'text', text: 'go' }]);
    const answers = (await recorded(record)).filter(
      (entry) => entry.method === 'permission-answer',
    );
    expect(answers).toHaveLength(script.filter((step) => 'permission' in (step as object)).length);
    await session.close();
    return seen;
  }

  it('hands the policy the server and the tool of an MCP call, found in the tool_call', async () => {
    const [request] = await ask(
      [{ update: MCP_TOOL_CALL }, { permission: MCP_REQUEST }],
      'mcp-merge',
    );
    expect(request).toMatchObject({
      toolCallId: 'exec-1',
      toolKind: 'execute',
      title: 'mcp.spike.ping',
      mcpTool: { server: 'spike', tool: 'ping' },
    });
    expect(request?.command).toBeUndefined();
  });

  it('a tool_call_update that arrives in between only overwrites what it brings', async () => {
    const [request] = await ask(
      [
        { update: MCP_TOOL_CALL },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'exec-1',
            status: 'in_progress',
            title: 'ping',
          },
        },
        { permission: MCP_REQUEST },
      ],
      'mcp-update',
    );
    expect(request).toMatchObject({ title: 'ping', mcpTool: { server: 'spike', tool: 'ping' } });
  });

  it('forgets a call that ended: a later request with the same id has nothing to merge', async () => {
    const [request] = await ask(
      [
        { update: MCP_TOOL_CALL },
        {
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed' },
        },
        { permission: MCP_REQUEST },
      ],
      'mcp-ended',
    );
    expect(request?.mcpTool).toBeUndefined();
    expect(request?.title).toBeUndefined();
  });

  it('does not take the tool call of another id for its own', async () => {
    const [request] = await ask(
      [{ update: { ...MCP_TOOL_CALL, toolCallId: 'exec-2' } }, { permission: MCP_REQUEST }],
      'mcp-other-id',
    );
    expect(request?.mcpTool).toBeUndefined();
  });
});

describe('permissionRequestOf, the merge with the tool call seen before', () => {
  const requestOf = (toolCall: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ sessionId: 's', toolCall, options: CODEX_OPTIONS, ...extra }) as never;
  const known = {
    title: 'mcp.spike.ping',
    kind: 'execute',
    rawInput: { server: 'spike', tool: 'ping', arguments: {} },
    meta: { is_mcp_tool_call: true },
  };

  it('takes what the request leaves out from the tool call', () => {
    const merged = permissionRequestOf(requestOf({ toolCallId: 'a' }), known);
    expect(merged).toMatchObject({
      title: 'mcp.spike.ping',
      toolKind: 'execute',
      mcpTool: { server: 'spike', tool: 'ping' },
    });
  });

  it('lets the request win where it brings a field', () => {
    const merged = permissionRequestOf(
      requestOf({
        toolCallId: 'a',
        title: 'Other',
        kind: 'read',
        rawInput: { server: 'x', tool: 'y' },
      }),
      known,
    );
    expect(merged).toMatchObject({
      title: 'Other',
      toolKind: 'read',
      mcpTool: { server: 'x', tool: 'y' },
    });
  });

  it('marks an MCP call by the request alone, with no tool_call seen', () => {
    const merged = permissionRequestOf(
      requestOf(
        { toolCallId: 'a', kind: 'execute', rawInput: { server: 's', tool: 't' } },
        { _meta: { is_mcp_tool_approval: true } },
      ),
    );
    expect(merged.mcpTool).toEqual({ server: 's', tool: 't' });
  });

  it('leaves mcpTool out without the MCP mark, even when rawInput has the two names', () => {
    const merged = permissionRequestOf(requestOf({ toolCallId: 'a', kind: 'execute' }), {
      ...known,
      meta: {},
    });
    expect(merged.mcpTool).toBeUndefined();
    const none = permissionRequestOf(
      requestOf({ toolCallId: 'a', kind: 'execute', rawInput: { server: 's', tool: 't' } }),
    );
    expect(none.mcpTool).toBeUndefined();
    // A mark that is not exactly true does not count.
    const loose = permissionRequestOf(
      requestOf(
        { toolCallId: 'a', kind: 'execute', rawInput: { server: 's', tool: 't' } },
        { _meta: { is_mcp_tool_approval: 'true' } },
      ),
    );
    expect(loose.mcpTool).toBeUndefined();
  });

  it('leaves mcpTool out when a name is missing, empty or not a string', () => {
    for (const rawInput of [
      { server: 's' },
      { tool: 't' },
      { server: '', tool: 't' },
      { server: 's', tool: '' },
      { server: 1, tool: 't' },
    ]) {
      const merged = permissionRequestOf(requestOf({ toolCallId: 'a', rawInput }), known);
      expect(merged.mcpTool).toBeUndefined();
    }
  });

  it('without a tool_call or a mark an execute stays what it was: no mcpTool, the command kept', () => {
    const merged = permissionRequestOf(
      requestOf({ toolCallId: 'a', kind: 'execute', rawInput: { command: 'ls' } }),
    );
    expect(merged).toMatchObject({ toolKind: 'execute', command: 'ls' });
    expect(merged.mcpTool).toBeUndefined();
  });
});
