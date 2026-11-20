// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentConnection,
  type AgentContext,
  type McpServer,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import {
  QUOTA_EXHAUSTED_CODE,
  QUOTA_SIGNAL_METHOD,
  type QuotaExhaustedData,
  type QuotaSignalParams,
} from '@otheater/protocol';
import { playEscape } from './escape-scripts.js';
import { McpClient, type SessionMcpServer } from './mcp-client.js';
import { directorHangs, directorQuotaFailure, playRolePlay } from './role-play.js';
import { parsePrompt, ScriptError, type Script } from './scripts.js';

export const FAKE_AGENT_NAME = 'otheater-fake-agent';
export const FAKE_AGENT_VERSION = '0.0.0';

export interface FakeAgentOptions {
  /** Script played by prompts without a `#script:` directive. Defaults to `echo`. */
  defaultScript?: Script;
  /**
   * Sends an `available_commands_update` while it answers `session/set_config_option`, before the
   * response, as the real clients announce things around the setup of a session. Default `false`:
   * the fake agent says nothing outside a prompt turn.
   */
  updatesOnConfig?: boolean;
}

/** The commands the fake agent announces when `updatesOnConfig` is on. */
export const FAKE_COMMANDS_ANNOUNCED = [
  { name: 'fake-command', description: 'A command announced during the setup of the session' },
] as const;

interface Session {
  cwd: string;
  /** Current value of each config option (id to value). */
  config: Map<string, string>;
  /** Aborted by `session/cancel`; present only while a prompt is running. */
  turn: AbortController | undefined;
  toolCalls: number;
  /** The MCP servers of `session/new` or `session/load`: HTTP with its headers, or stdio. */
  mcpServers: SessionMcpServer[];
}

interface TurnContext {
  client: AgentContext;
  sessionId: string;
  session: Session;
  signal: AbortSignal;
  text: string;
}

const ALLOW: PermissionOption = { optionId: 'allow', name: 'Allow', kind: 'allow_once' };
const REJECT: PermissionOption = { optionId: 'reject', name: 'Reject', kind: 'reject_once' };

/**
 * Config options the fake agent offers: id, category, values and the value a new session starts
 * with. `model` and `effort` are the ones the model catalogs read (`thought_level` is the
 * category of the effort in the real clients).
 */
const CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    values: ['fake-model', 'fake-model-2'],
    initial: 'fake-model',
  },
  { id: 'mode', name: 'Mode', category: 'mode', values: ['default', 'plan'], initial: 'default' },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    values: ['low', 'medium', 'high'],
    initial: 'medium',
  },
] as const;

function configOptionsOf(session: Session): SessionConfigOption[] {
  return CONFIG_OPTIONS.map((option) => ({
    type: 'select' as const,
    id: option.id,
    name: option.name,
    category: option.category,
    currentValue: session.config.get(option.id) ?? option.initial,
    options: option.values.map((value) => ({ value, name: value })),
  }));
}

const CANCELLED: PromptResponse = { stopReason: 'cancelled' };
const END_TURN: PromptResponse = { stopReason: 'end_turn' };

function update(turn: TurnContext, content: SessionUpdate): Promise<void> {
  return turn.client.notify(methods.client.session.update, {
    sessionId: turn.sessionId,
    update: content,
  });
}

function message(turn: TurnContext, text: string): Promise<void> {
  return update(turn, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });
}

function nextToolCallId(session: Session): string {
  session.toolCalls += 1;
  return `call-${String(session.toolCalls)}`;
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener('abort', () => {
      done();
    });
  });
}

/** Walks up to the nearest existing ancestor of `path` and resolves its symlinks. */
async function realpathOfNearestAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await stat(current);
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** True when `target` is `root` itself or lies below it. */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolves `path` against `cwd`; returns undefined when it would land outside `cwd`. */
async function resolveInsideCwd(cwd: string, path: string): Promise<string | undefined> {
  const root = await realpath(cwd);
  const target = resolve(root, path);
  if (target === root || !isWithin(root, target)) return undefined;
  // A symlink inside the cwd must not lead out of it.
  if (!isWithin(root, await realpathOfNearestAncestor(target))) return undefined;
  return target;
}

async function playEcho(turn: TurnContext): Promise<PromptResponse> {
  for (const word of turn.text.match(/\S+\s*|\s+/g) ?? []) {
    if (turn.signal.aborted) return CANCELLED;
    await message(turn, word);
  }
  return turn.signal.aborted ? CANCELLED : END_TURN;
}

async function playToolCall(
  turn: TurnContext,
  script: Extract<Script, { name: 'tool-call' }>,
): Promise<PromptResponse> {
  const toolCallId = nextToolCallId(turn.session);
  await update(turn, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: script.title,
    kind: 'other',
    status: 'in_progress',
  });
  await update(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: script.output } }],
    rawOutput: script.output,
  });
  return END_TURN;
}

/** The failed `edit` tool call a script reports for a path outside the session cwd. */
function refuseOutsideCwd(
  turn: TurnContext,
  toolCallId: string,
  title: string,
  path: string,
): Promise<void> {
  return update(turn, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind: 'edit',
    status: 'failed',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: `refused: ${path} is outside the session cwd` },
      },
    ],
  });
}

/** Writes `content` to `target` and reports the edit as completed, with the diff. */
async function writeAndReport(
  turn: TurnContext,
  toolCallId: string,
  target: string,
  content: string,
): Promise<void> {
  const oldText = await readFile(target, 'utf8').catch(() => null);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  await update(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'diff', path: target, oldText, newText: content }],
  });
}

async function playEditFile(
  turn: TurnContext,
  script: Extract<Script, { name: 'edit-file' }>,
): Promise<PromptResponse> {
  const toolCallId = nextToolCallId(turn.session);
  const title = `Write ${script.path}`;
  const target = await resolveInsideCwd(turn.session.cwd, script.path);
  if (target === undefined) {
    await refuseOutsideCwd(turn, toolCallId, title, script.path);
    return END_TURN;
  }
  const locations = [{ path: target }];
  await update(turn, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind: 'edit',
    status: 'pending',
    locations,
  });
  const permission: RequestPermissionResponse = await turn.client.request(
    methods.client.session.requestPermission,
    {
      sessionId: turn.sessionId,
      toolCall: { toolCallId, title, kind: 'edit', status: 'pending', locations },
      options: [ALLOW, REJECT],
    },
    { cancellationSignal: turn.signal, stopWaitingOnCancel: true },
  );
  if (permission.outcome.outcome === 'cancelled' || turn.signal.aborted) {
    await update(turn, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    return CANCELLED;
  }
  if (permission.outcome.optionId !== ALLOW.optionId) {
    await update(turn, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }],
    });
    return END_TURN;
  }
  await writeAndReport(turn, toolCallId, target, script.content);
  return END_TURN;
}

/**
 * [proposal] `edit-file` without the permission request: the way a real client behaves when its
 * mode already allows the edit (Claude Code in `acceptEdits`). The write cannot be refused by the
 * client's `onAsk` policy because nothing is asked.
 */
async function playWriteFile(
  turn: TurnContext,
  script: Extract<Script, { name: 'write-file' }>,
): Promise<PromptResponse> {
  const toolCallId = nextToolCallId(turn.session);
  const title = `Write ${script.path}`;
  const target = await resolveInsideCwd(turn.session.cwd, script.path);
  if (target === undefined) {
    await refuseOutsideCwd(turn, toolCallId, title, script.path);
    return END_TURN;
  }
  await update(turn, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind: 'edit',
    status: 'in_progress',
    locations: [{ path: target }],
  });
  if (turn.signal.aborted) {
    await update(turn, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    return CANCELLED;
  }
  await writeAndReport(turn, toolCallId, target, script.content);
  return END_TURN;
}

function mcpServersOf(servers: readonly McpServer[] | undefined): SessionMcpServer[] {
  const found: SessionMcpServer[] = [];
  for (const server of servers ?? []) {
    if ('url' in server) {
      // SSE is not spoken here: the framework server is Streamable HTTP.
      if ('type' in server && server.type === 'sse') continue;
      found.push({
        name: server.name,
        url: server.url,
        headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      });
      continue;
    }
    found.push({
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map((variable) => [variable.name, variable.value])),
    });
  }
  return found;
}

/** A tool call the Executor made, reported to the client as one `tool_call` that already ended. */
async function reportMcpCall(
  turn: TurnContext,
  title: string,
  status: 'completed' | 'failed',
  text: string,
): Promise<void> {
  const toolCallId = nextToolCallId(turn.session);
  await update(turn, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind: 'other',
    status: 'in_progress',
  });
  await update(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    content: [{ type: 'content', content: { type: 'text', text } }],
    rawOutput: text,
  });
}

/** The client of the named MCP server of the session, or a message that says why there is none. */
async function mcpClientFor(turn: TurnContext, server: string): Promise<McpClient | undefined> {
  const found = turn.session.mcpServers.find((candidate) => candidate.name === server);
  if (found === undefined) {
    const names = turn.session.mcpServers.map((candidate) => candidate.name).join(', ');
    await message(turn, `no MCP server "${server}" in this session (has: ${names || 'none'})`);
    return undefined;
  }
  const client = new McpClient(found);
  try {
    await client.initialize();
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}

/** What the turn says about a failure of the MCP call that is not a tool result. */
async function mcpFailed(turn: TurnContext, title: string, error: unknown): Promise<void> {
  const text = error instanceof Error ? error.message : String(error);
  await reportMcpCall(turn, title, 'failed', text);
  await message(turn, `mcp error: ${text}`);
}

async function playMcpCall(
  turn: TurnContext,
  script: Extract<Script, { name: 'mcp-call' }>,
): Promise<PromptResponse> {
  const title = `MCP ${script.server}${script.tool === undefined ? '' : ` ${script.tool}`}`;
  let client: McpClient | undefined;
  try {
    client = await mcpClientFor(turn, script.server);
    if (client === undefined) return END_TURN;
    if (script.list) await message(turn, `tools: ${(await client.listTools()).sort().join(', ')}`);
    if (script.tool !== undefined) {
      const outcome = await client.callTool(script.tool, script.arguments);
      await reportMcpCall(turn, title, outcome.isError ? 'failed' : 'completed', outcome.text);
      await message(turn, `reply: ${outcome.text}`);
    }
  } catch (error) {
    await mcpFailed(turn, title, error);
  } finally {
    await client?.close();
  }
  return turn.signal.aborted ? CANCELLED : END_TURN;
}

async function playRolePlayScript(
  turn: TurnContext,
  script: Extract<Script, { name: 'role-play' }>,
): Promise<PromptResponse> {
  if (await directorHangs(turn.text)) return playHang(turn);
  const failure = await directorQuotaFailure(turn.text);
  if (failure !== undefined) {
    return playQuotaSignal(turn, { name: 'quota-signal', usedPercent: 100, ...failure });
  }
  // The quota error of an Actor that ran out midway (`exhaust`) must reach the client as it is.
  let exhausted: Error | undefined;
  let opened: McpClient | undefined;
  try {
    opened = await mcpClientFor(turn, script.server);
    if (opened === undefined) return END_TURN;
    const client = opened;
    await playRolePlay({
      text: turn.text,
      cwd: turn.session.cwd,
      signal: turn.signal,
      say: (text) => message(turn, text),
      exhaust: async (resetsAt) => {
        try {
          return await playQuotaSignal(turn, {
            name: 'quota-signal',
            usedPercent: 100,
            ...(resetsAt === undefined ? {} : { resetsAt }),
          });
        } catch (error) {
          if (error instanceof Error) exhausted = error;
          throw error;
        }
      },
      ask: (request) => askPermission(turn, request),
      call: async (tool, args) => {
        const outcome = await client.callTool(tool, args);
        await reportMcpCall(
          turn,
          `MCP ${script.server} ${tool}`,
          outcome.isError ? 'failed' : 'completed',
          outcome.text,
        );
        return outcome;
      },
    });
  } catch (error) {
    if (exhausted !== undefined) throw exhausted;
    await mcpFailed(turn, `MCP ${script.server}`, error);
  } finally {
    await opened?.close();
  }
  return turn.signal.aborted ? CANCELLED : END_TURN;
}

async function playSubmit(
  turn: TurnContext,
  script: Extract<Script, { name: 'submit' }>,
): Promise<PromptResponse> {
  const title = `MCP ${script.server} ${script.tool}`;
  let client: McpClient | undefined;
  try {
    client = await mcpClientFor(turn, script.server);
    if (client === undefined) return END_TURN;
    for (let call = 1; call <= script.repeat; call += 1) {
      if (turn.signal.aborted) return CANCELLED;
      const outcome = await client.callTool(script.tool, script.output);
      await reportMcpCall(turn, title, outcome.isError ? 'failed' : 'completed', outcome.text);
      await message(turn, `submit ${String(call)}: ${outcome.text}`);
      if (!outcome.isError) break;
    }
  } catch (error) {
    await mcpFailed(turn, title, error);
  } finally {
    await client?.close();
  }
  return turn.signal.aborted ? CANCELLED : END_TURN;
}

/** One raw TCP connection: `ok` when it connected, else the error code the system gave. */
function tryConnect(target: string): Promise<string> {
  const at = target.lastIndexOf(':');
  const host = target.slice(0, at);
  const port = Number(target.slice(at + 1));
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 5000 });
    socket.once('connect', () => {
      socket.destroy();
      done('ok');
    });
    socket.once('timeout', () => {
      socket.destroy();
      done('failed ETIMEDOUT');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(`failed ${error.code ?? error.message}`);
    });
  });
}

/** What the operating system says to a write, a read and a connection (for the sandbox tests). */
async function playProbe(
  turn: TurnContext,
  script: Extract<Script, { name: 'probe' }>,
): Promise<PromptResponse> {
  const code = (error: unknown): string =>
    `failed ${(error as NodeJS.ErrnoException).code ?? String(error)}`;
  for (const path of script.write) {
    const result = await writeFile(path, 'written by the fake agent\n').then(() => 'ok', code);
    await message(turn, `probe write ${path}: ${result}`);
  }
  for (const path of script.read) {
    const result = await readFile(path).then((bytes) => `ok ${String(bytes.length)} bytes`, code);
    await message(turn, `probe read ${path}: ${result}`);
  }
  for (const target of script.connect) {
    await message(turn, `probe connect ${target}: ${await tryConnect(target)}`);
  }
  return END_TURN;
}

/** What a tool call asks permission for (the escape script and the `#actor-refused` marker). */
interface PermissionRequestSpec {
  readonly kind: 'edit' | 'execute' | 'fetch' | 'switch_mode';
  readonly title: string;
  readonly locations?: readonly string[] | undefined;
  readonly rawInput?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Announces a tool call and asks the client for permission (`session/request_permission`), as a
 * client does before a write it does not own. Says what came back: the option that was selected,
 * or `cancelled` when the turn was cancelled or no option was taken.
 */
async function askPermission(
  turn: TurnContext,
  { kind, title, locations, rawInput }: PermissionRequestSpec,
): Promise<'allowed' | 'rejected' | 'cancelled'> {
  const toolCallId = nextToolCallId(turn.session);
  const places = locations?.map((path) => ({ path }));
  await update(turn, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind,
    status: 'pending',
    ...(places === undefined ? {} : { locations: places }),
    ...(rawInput === undefined ? {} : { rawInput }),
  });
  const permission: RequestPermissionResponse = await turn.client.request(
    methods.client.session.requestPermission,
    {
      sessionId: turn.sessionId,
      toolCall: {
        toolCallId,
        title,
        kind,
        status: 'pending',
        ...(places === undefined ? {} : { locations: places }),
        ...(rawInput === undefined ? {} : { rawInput }),
      },
      options: [ALLOW, REJECT],
    },
    { cancellationSignal: turn.signal, stopWaitingOnCancel: true },
  );
  if (permission.outcome.outcome === 'cancelled' || turn.signal.aborted) return 'cancelled';
  return permission.outcome.optionId === ALLOW.optionId ? 'allowed' : 'rejected';
}

/** The escape script (P5): the ACP side of its host; the steps are in `escape-scripts.ts`. */
async function playEscapeScript(
  turn: TurnContext,
  script: Extract<Script, { name: 'escape' }>,
): Promise<PromptResponse> {
  const clients = new Map<string, McpClient | undefined>();
  try {
    await playEscape(
      {
        cwd: turn.session.cwd,
        signal: turn.signal,
        say: (text) => message(turn, text),
        ask: (request) => askPermission(turn, request),
        callTool: async (server, tool, args) => {
          if (!clients.has(server)) clients.set(server, await mcpClientFor(turn, server));
          const client = clients.get(server);
          if (client === undefined) return undefined;
          const outcome = await client.callTool(tool, { ...args });
          await reportMcpCall(
            turn,
            `MCP ${server} ${tool}`,
            outcome.isError ? 'failed' : 'completed',
            outcome.text,
          );
          return { isError: outcome.isError, text: outcome.text };
        },
        tryConnect,
      },
      script,
    );
  } finally {
    await Promise.all(
      [...clients.values()].flatMap((client) => (client === undefined ? [] : [client.close()])),
    );
  }
  return turn.signal.aborted ? CANCELLED : END_TURN;
}

async function playHang(turn: TurnContext): Promise<PromptResponse> {
  // The chunk tells the client the turn is running, so a cancel sent after it is never lost.
  await message(turn, 'hanging until session/cancel');
  await untilAborted(turn.signal);
  return CANCELLED;
}

/**
 * A client that does not honour `session/cancel`: the turn never ends by itself. With `child`, a
 * tool of the turn is left running (a process that sleeps for a minute at most) and its pid is
 * announced, so a test can prove that ending the process tree reaches it.
 */
async function playDeaf(
  turn: TurnContext,
  script: Extract<Script, { name: 'deaf' }>,
): Promise<PromptResponse> {
  if (script.child) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    child.unref();
    await message(turn, `child pid ${String(child.pid)}`);
  }
  await message(turn, 'ignoring session/cancel');
  return new Promise<PromptResponse>(() => undefined);
}

async function playQuotaSignal(
  turn: TurnContext,
  script: Extract<Script, { name: 'quota-signal' }>,
): Promise<never> {
  const resetsAt = script.resetsAt === undefined ? {} : { resetsAt: script.resetsAt };
  const signals: QuotaSignalParams['signal'][] = [
    { kind: 'window', window: '5h', usedPercent: script.usedPercent, ...resetsAt },
    { kind: 'limit_hit', source: 'fake-agent', ...resetsAt },
  ];
  for (const signal of signals) {
    const params: QuotaSignalParams = { sessionId: turn.sessionId, signal };
    await turn.client.notify(QUOTA_SIGNAL_METHOD, params);
  }
  const data: QuotaExhaustedData = { type: 'QuotaExhausted', ...resetsAt };
  throw new RequestError(QUOTA_EXHAUSTED_CODE, 'quota exhausted', data);
}

/**
 * Reports the consumption of the turn as `usage` quota signals, then ends the turn normally: the
 * consumption data a real client attaches to its answer (architecture 5.6).
 */
async function playUsageSignal(
  turn: TurnContext,
  script: Extract<Script, { name: 'usage-signal' }>,
): Promise<PromptResponse> {
  const cost = script.costUsd === undefined ? {} : { costUsd: script.costUsd };
  for (let sent = 0; sent < script.repeat; sent += 1) {
    if (turn.signal.aborted) return CANCELLED;
    const params: QuotaSignalParams = {
      sessionId: turn.sessionId,
      signal: {
        kind: 'usage',
        model: script.model,
        inputTokens: script.inputTokens,
        outputTokens: script.outputTokens,
        ...cost,
      },
    };
    await turn.client.notify(QUOTA_SIGNAL_METHOD, params);
  }
  return END_TURN;
}

function play(turn: TurnContext, script: Script): Promise<PromptResponse> {
  switch (script.name) {
    case 'echo':
      return playEcho(turn);
    case 'tool-call':
      return playToolCall(turn, script);
    case 'edit-file':
      return playEditFile(turn, script);
    case 'write-file':
      return playWriteFile(turn, script);
    case 'mcp-call':
      return playMcpCall(turn, script);
    case 'submit':
      return playSubmit(turn, script);
    case 'role-play':
      return playRolePlayScript(turn, script);
    case 'fail':
      return Promise.reject(new RequestError(-32603, script.message, { script: 'fail' }));
    case 'probe':
      return playProbe(turn, script);
    case 'escape':
      return playEscapeScript(turn, script);
    case 'hang':
      return playHang(turn);
    case 'deaf':
      return playDeaf(turn, script);
    case 'quota-signal':
      return playQuotaSignal(turn, script);
    case 'usage-signal':
      return playUsageSignal(turn, script);
  }
}

/**
 * Builds the fake agent: an ACP agent (the `agent()` side of the SDK) that plays deterministic
 * scripts. It is not connected to anything yet; use {@link connectToStreams}, {@link serveStdio} or
 * pass it straight to `client().connectWith(...)`.
 */
export function createFakeAgent(options: FakeAgentOptions = {}): AgentApp {
  const sessions = new Map<string, Session>();
  let created = 0;

  const open = (sessionId: string, cwd: string, mcpServers: readonly McpServer[]): void => {
    sessions.set(sessionId, {
      cwd,
      config: new Map(),
      turn: undefined,
      toolCalls: 0,
      mcpServers: mcpServersOf(mcpServers),
    });
  };
  const find = (sessionId: string): Session => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw RequestError.sessionNotFound(sessionId);
    return session;
  };

  return agent({ name: FAKE_AGENT_NAME })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      // `mcpCapabilities.http`: the client takes the framework MCP server of 5.3 over HTTP; stdio,
      // the shim of N161, every ACP agent takes.
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        mcpCapabilities: { http: true },
      },
      agentInfo: {
        name: FAKE_AGENT_NAME,
        title: 'OTheater fake agent',
        version: FAKE_AGENT_VERSION,
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.new, ({ params }) => {
      created += 1;
      const sessionId = `fake-session-${String(created)}`;
      open(sessionId, params.cwd, params.mcpServers);
      return { sessionId, configOptions: configOptionsOf(find(sessionId)) };
    })
    .onRequest(methods.agent.session.load, ({ params }) => {
      // No history to replay: the fake agent only recreates the session state.
      open(params.sessionId, params.cwd, params.mcpServers);
      return { configOptions: configOptionsOf(find(params.sessionId)) };
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params, client }) => {
      const session = find(params.sessionId);
      const option = CONFIG_OPTIONS.find((candidate) => candidate.id === params.configId);
      if (option === undefined) {
        throw RequestError.invalidParams(undefined, `unknown config option: ${params.configId}`);
      }
      const value = params.value;
      if (typeof value !== 'string' || !(option.values as readonly string[]).includes(value)) {
        throw RequestError.invalidParams(
          undefined,
          `invalid value for ${option.id}: ${String(value)}`,
        );
      }
      session.config.set(option.id, value);
      if (options.updatesOnConfig === true) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: FAKE_COMMANDS_ANNOUNCED.map((command) => ({ ...command })),
          },
        });
      }
      return { configOptions: configOptionsOf(session) };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, signal, client }) => {
      const session = find(params.sessionId);
      if (session.turn !== undefined) {
        throw RequestError.invalidRequest(undefined, 'a prompt is already running in this session');
      }
      const raw = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
      let parsed: ReturnType<typeof parsePrompt>;
      try {
        parsed = parsePrompt(raw);
      } catch (error) {
        if (error instanceof ScriptError)
          throw RequestError.invalidParams(undefined, error.message);
        throw error;
      }
      const script = parsed.script ?? options.defaultScript ?? ({ name: 'echo' } as const);
      const controller = new AbortController();
      session.turn = controller;
      try {
        return await play(
          {
            client,
            sessionId: params.sessionId,
            session,
            signal: AbortSignal.any([controller.signal, signal]),
            text: parsed.text,
          },
          script,
        );
      } finally {
        session.turn = undefined;
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.turn?.abort();
    });
}

/** Connects an agent to a pair of byte streams carrying newline-delimited JSON-RPC. */
export function connectToStreams(
  app: AgentApp,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): AgentConnection {
  return app.connect(ndJsonStream(output, input));
}

/** Serves the agent over this process's stdin and stdout. Stdout carries only the protocol. */
export async function serveStdio(app: AgentApp = createFakeAgent()): Promise<void> {
  const { Readable, Writable } = await import('node:stream');
  const connection = connectToStreams(
    app,
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  await connection.closed;
}
