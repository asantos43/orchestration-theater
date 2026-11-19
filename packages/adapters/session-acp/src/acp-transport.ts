// SPDX-License-Identifier: MPL-2.0
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ContentBlock as AcpContentBlock,
  type McpServer,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption as AcpConfigOption,
} from '@agentclientprotocol/sdk';
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  isOTheaterError,
  ManagedAgentSession,
  NotFound,
  PROMPT_USAGE_UPDATE,
  typedErrorOf,
  type AgentInfo,
  type ConfigValue,
  type ContentBlock,
  type OTheaterError,
  type PermissionRequest,
  type SessionConfigChoice,
  type SessionConfigChoiceGroup,
  type SessionConfigOption,
  type SessionDriver,
  type SessionExtensionHandler,
  type SessionLoadParams,
  type SessionOpenParams,
  type SessionTransport,
  type SessionWarning,
  type StopReason,
} from '@otheater/core';
import { ToolCallState, type ToolCallFields } from './tool-call-state.js';

/** How long `initialize`, `session/new`, `session/load` and the config calls may take together. [proposta] */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** ACP `resource not found`: the code a client answers `session/load` with for a conversation it does not have. */
const ACP_RESOURCE_NOT_FOUND = -32002;
/** JSON-RPC `invalid params`: what a client answers `session/set_config_option` with for an id or value it does not offer. */
const JSON_RPC_INVALID_PARAMS = -32602;

export interface AcpTransportOptions {
  /** Sent in `initialize` as `clientInfo`. Default `otheater`. */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Limit for the handshake and the session setup; on expiry the open rejects with `AdapterUnavailable`. Default {@link DEFAULT_START_TIMEOUT_MS}. */
  readonly startTimeoutMs?: number;
  /** Wait after `session/cancel` before the process tree is killed anyway. See `ManagedSessionOptions`. */
  readonly cancelGraceMs?: number;
  readonly killGraceMs?: number;
  /**
   * How long the connection of a process lives, when several sessions share it. `last_session`
   * (default): the connection closes when the last session of the process disconnects; closing it
   * stops the reading of the client's output for good, so a process that stays alive cannot serve
   * another session through this transport (a new open on it rejects with `AdapterUnavailable`).
   * `process`: the connection stays until the process ends, for a pool that keeps an idle process
   * for the next session.
   * [proposta] One session per process behaves the same in both modes.
   */
  readonly connectionLifetime?: ConnectionLifetime;
  readonly onWarning?: (warning: AcpTransportWarning) => void;
}

/** See {@link AcpTransportOptions.connectionLifetime}. */
export type ConnectionLifetime = 'last_session' | 'process';

/** Something the transport noticed and did not fail on. */
export type AcpTransportWarning =
  | SessionWarning
  | { readonly kind: 'permission_handler_threw'; readonly error: unknown }
  | { readonly kind: 'extension_handler_threw'; readonly method: string; readonly error: unknown }
  | { readonly kind: 'agent_info_handler_threw'; readonly error: unknown }
  /**
   * A `session/update` or `session/request_permission` named a session this connection never had
   * (not one it has closed, and not while a `session/new` is still answering). The message is
   * dropped, and a permission request is answered `cancelled`. [proposta]
   */
  | {
      readonly kind: 'unknown_session';
      readonly method: string;
      readonly sessionId: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a stream to its end and drops what it carries: a client that writes logs must not block on a full pipe. */
function drain(stream: ReadableStream<Uint8Array>): void {
  stream.pipeTo(new WritableStream<Uint8Array>({ write: () => undefined })).catch(() => undefined);
}

function timeoutAfter(ms: number, message: string): { promise: Promise<never>; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AdapterUnavailable(message));
    }, ms);
  });
  return {
    promise,
    stop: () => {
      clearTimeout(timer);
    },
  };
}

/** Keys of `rawInput` that hold the file a tool call touches, as the clients write them [N: not measured per client]. */
const RAW_PATH_KEYS = ['path', 'filePath', 'file_path', 'filepath'] as const;

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The marks codex-acp puts on an MCP tool call ([V] codex-acp 2.6.0, 2026-11-17). */
function isMcpMarked(params: RequestPermissionRequest, meta: Readonly<Record<string, unknown>>) {
  const own: unknown = params._meta;
  return (isRecord(own) && own.is_mcp_tool_approval === true) || meta.is_mcp_tool_call === true;
}

/**
 * The reduction of a `session/request_permission` to what the policy needs (architecture 5.8,
 * layer 2). Besides the title and the kind, what the release rules read (Phase 4, P2): the tool
 * name, the files, the command and the address the call carries. The files come from
 * `toolCall.locations` and, when the client sends none, from the path keys of `rawInput` (neither
 * measured per client for an edit [N]; the fake agent sends `locations`); the command from
 * `rawInput.command` ([V] in the Phase 0 spikes, Claude Code and OpenCode for `execute`); the tool
 * name from `_meta.claudeCode.toolName` [N]. A request that lacks the file of a write is rejected
 * (`write_target_unknown`), so what is not measured fails closed.
 *
 * `known` is what the session saw of the same `toolCallId` in its `tool_call` and
 * `tool_call_update` messages: the `toolCall` of the request is a ToolCallUpdate, so a field it
 * leaves out is the one the earlier message had, and what the request carries wins. [V] Codex
 * (codex-acp 2.6.0, 2026-11-17) sends the title, `rawInput` and `_meta` of an MCP call only in the
 * `tool_call`; the request has the id and `kind: execute`. `mcpTool` is filled only for a call
 * marked as MCP (`is_mcp_tool_approval` on the request or `is_mcp_tool_call` on the merged tool
 * call) whose `rawInput` names a server and a tool; anything else stays as it was (an `execute` is
 * the native shell). [proposta]
 */
export function permissionRequestOf(
  params: RequestPermissionRequest,
  known?: ToolCallFields,
): PermissionRequest {
  const { toolCall } = params;
  const own: unknown = toolCall.rawInput;
  const raw: unknown = own ?? known?.rawInput;
  const rawInput = isRecord(raw) ? raw : {};
  const ownMeta: unknown = toolCall._meta;
  const meta: Record<string, unknown> = { ...known?.meta, ...(isRecord(ownMeta) ? ownMeta : {}) };
  const claude = isRecord(meta.claudeCode) ? meta.claudeCode : {};
  const located = (toolCall.locations ?? []).map((location) => location.path);
  const fromRaw = RAW_PATH_KEYS.map((key) => stringOf(rawInput[key])).filter(
    (path): path is string => path !== undefined,
  );
  const locations = located.length > 0 ? located : fromRaw;
  const toolName = stringOf(claude.toolName);
  const command = stringOf(rawInput.command) ?? stringOf(rawInput.cmd);
  const url = stringOf(rawInput.url);
  const title = typeof toolCall.title === 'string' ? toolCall.title : known?.title;
  const toolKind = typeof toolCall.kind === 'string' ? toolCall.kind : known?.kind;
  const server = stringOf(rawInput.server);
  const tool = stringOf(rawInput.tool);
  const mcpTool =
    server !== undefined && tool !== undefined && isMcpMarked(params, meta)
      ? { server, tool }
      : undefined;
  return {
    toolCallId: toolCall.toolCallId,
    ...(title === undefined ? {} : { title }),
    ...(toolKind === undefined ? {} : { toolKind }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(locations.length === 0 ? {} : { locations }),
    ...(command === undefined ? {} : { command }),
    ...(url === undefined ? {} : { url }),
    ...(mcpTool === undefined ? {} : { mcpTool }),
    options: params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

/**
 * A prompt block in ACP form. The core block carries the same fields; the only difference is that
 * an absent optional field may be `undefined` there and must not be on the wire.
 */
function acpContentOf(block: ContentBlock): AcpContentBlock {
  return Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== undefined),
  ) as unknown as AcpContentBlock;
}

function choiceOf(raw: unknown): SessionConfigChoice | undefined {
  if (!isRecord(raw) || typeof raw.value !== 'string') return undefined;
  return {
    value: raw.value,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  };
}

/** The values of a select option, flat or grouped; an entry the client got wrong is left out. */
function choicesOf(raw: unknown): (SessionConfigChoice | SessionConfigChoiceGroup)[] {
  if (!Array.isArray(raw)) return [];
  const out: (SessionConfigChoice | SessionConfigChoiceGroup)[] = [];
  for (const item of raw as unknown[]) {
    if (isRecord(item) && Array.isArray(item.options)) {
      out.push({
        group: typeof item.group === 'string' ? item.group : '',
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        options: (item.options as unknown[]).flatMap((entry) => choiceOf(entry) ?? []),
      });
      continue;
    }
    const choice = choiceOf(item);
    if (choice !== undefined) out.push(choice);
  }
  return out;
}

/**
 * The config options of an ACP answer (`session/new`, `session/load`, `session/set_config_option`)
 * or of a `config_option_update`, in the neutral form of the port. What is not an object with a
 * string `id` is dropped: the list comes from a client, not from this code.
 */
function configOptionsOf(
  raw: readonly AcpConfigOption[] | readonly unknown[] | null | undefined,
): SessionConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionConfigOption[] = [];
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const boolean = item.type === 'boolean';
    const current = item.currentValue;
    out.push({
      id: item.id,
      type: boolean ? 'boolean' : 'select',
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.category === 'string' ? { category: item.category } : {}),
      ...(typeof current === 'string' || typeof current === 'boolean'
        ? { currentValue: current }
        : {}),
      ...(boolean ? {} : { options: choicesOf(item.options) }),
    });
  }
  return out;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** A session of the connection: where its messages go and what it answers. */
interface Route {
  /** Set once the session exists; updates before that (a `session/load` replays history) are dropped. */
  deliver: ((raw: unknown) => void) | undefined;
  readonly onPermission: SessionOpenParams['onPermission'];
  readonly extensions: ReadonlyMap<string, SessionExtensionHandler>;
  /** The tool calls the client announced, so a permission request can be read with their fields. */
  readonly toolCalls: ToolCallState;
  /** The open gave up (timeout, error): whatever the client still says about it is not delivered. */
  abandoned: boolean;
}

/** What `initialize` told, reduced to what the sessions of the connection need. */
interface Initialized {
  readonly canLoad: boolean;
  readonly mcpHttp: boolean | null | undefined;
  /** What the client said about itself; `undefined` when it said nothing usable (it is optional in ACP). */
  readonly agentInfo: AgentInfo | undefined;
}

/** `agentInfo` of the `initialize` response, when it carries a name and a version (both strings). */
function agentInfoOf(raw: unknown): AgentInfo | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.version !== 'string') {
    return undefined;
  }
  return {
    name: raw.name,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    version: raw.version,
  };
}

/** How many closed session ids a connection remembers, to tell a late message from a stray one. */
const REMEMBERED_CLOSED = 256;

/**
 * One connection to one client process, shared by every session on it. It owns the route table
 * (`sessionId` to session), counts the sessions that hold it and closes the connection when the
 * last one lets go (or never, in `process` lifetime). A process is recognised by its `stdin`.
 */
class SharedConnection {
  connection!: ClientConnection;
  readonly routes = new Map<string, Route>();
  /** Ids of sessions that left, in order; their late messages are dropped without a warning. */
  readonly #closed = new Set<string>();
  /** Sessions that hold the connection: starting, or open and not yet disconnected. */
  #refs = 0;
  /** `session/new` requests in flight: an update for an id not yet routed is expected, not stray. */
  starting = 0;
  initialized: Promise<Initialized> | undefined;
  readonly #lifetime: ConnectionLifetime;
  readonly #onGone: () => void;

  constructor(lifetime: ConnectionLifetime, onGone: () => void) {
    this.#lifetime = lifetime;
    this.#onGone = onGone;
  }

  retain(): void {
    this.#refs += 1;
  }

  /** A session lets go: its route goes, and the connection closes if it was the last one. */
  release(sessionId: string | undefined, route: Route): void {
    if (route.abandoned) return;
    route.abandoned = true;
    if (sessionId !== undefined) this.forget(sessionId);
    this.#refs -= 1;
    if (this.#refs <= 0 && this.#lifetime === 'last_session') this.close();
  }

  forget(sessionId: string): void {
    this.routes.delete(sessionId);
    this.#closed.add(sessionId);
    if (this.#closed.size > REMEMBERED_CLOSED) {
      const oldest = this.#closed.values().next();
      if (oldest.done !== true) this.#closed.delete(oldest.value);
    }
  }

  wasClosed(sessionId: string): boolean {
    return this.#closed.has(sessionId);
  }

  close(): void {
    this.#onGone();
    this.connection.close();
  }
}

class AcpDriver implements SessionDriver {
  readonly #shared: SharedConnection;
  readonly #route: Route;
  readonly #sessionId: string;
  #released = false;

  constructor(shared: SharedConnection, route: Route, sessionId: string) {
    this.#shared = shared;
    this.#route = route;
    this.#sessionId = sessionId;
  }

  get #connection(): ClientConnection {
    return this.#shared.connection;
  }

  async runTurn(blocks: readonly ContentBlock[]): Promise<StopReason> {
    const prompt = blocks.map(acpContentOf);
    try {
      const response = await this.#connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.#sessionId,
        prompt,
      });
      // P25 (N156): the token counts of the turn, when the client gives them (an unstable field
      // of ACP; [N] whether OpenCode sends it). The normalizer of the client decides what it is.
      const usage = (response as { usage?: unknown }).usage;
      if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
        try {
          this.#route.deliver?.({ sessionUpdate: PROMPT_USAGE_UPDATE, usage });
        } catch {
          // A listener that fails must not fail a turn that ended well.
        }
      }
      return response.stopReason;
    } catch (error) {
      throw this.#classified(error);
    }
  }

  async requestCancel(): Promise<void> {
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#sessionId,
    });
  }

  async applyConfig(id: string, value: ConfigValue): Promise<SessionConfigOption[] | undefined> {
    try {
      const answer = await this.#connection.agent.request(
        methods.agent.session.setConfigOption,
        typeof value === 'boolean'
          ? { sessionId: this.#sessionId, configId: id, type: 'boolean', value }
          : { sessionId: this.#sessionId, configId: id, value },
      );
      // An answer with no list (not what ACP says) leaves the snapshot as it was.
      return Array.isArray(answer.configOptions)
        ? configOptionsOf(answer.configOptions)
        : undefined;
    } catch (error) {
      if (error instanceof RequestError && error.code === JSON_RPC_INVALID_PARAMS) {
        throw new InvalidInput(
          `the client does not accept ${id}=${String(value)}: ${error.message}`,
          {
            cause: error,
          },
        );
      }
      throw this.#classified(error);
    }
  }

  /** Lets go of the connection; it closes only when no other session of the process holds it. Idempotent. */
  disconnect(): void {
    if (this.#released) return;
    this.#released = true;
    this.#shared.release(this.#sessionId, this.#route);
  }

  /** A closed connection is a client that is gone; an answer of the client goes up as it came, for the normalizer. */
  #classified(error: unknown): unknown {
    if (error instanceof RequestError || isOTheaterError(error)) return error;
    if (this.#connection.signal.aborted) {
      return new AdapterUnavailable('the connection to the client closed', { cause: error });
    }
    return error;
  }
}

/**
 * ACP over the standard streams of the client process: the `SessionTransport` with `id: 'acp'`
 * (architecture 5.2, "Casca de agente"). One connection per process, shared by the sessions on it.
 *
 * What it does, in order, for `open` and `load`:
 * 1. `initialize` (once per connection), offering NO `fs` and NO `terminal` capability: the client
 *    does its own file work and runs its own shell, and the daemon answers neither (architecture
 *    5.8, layers 1 and 3 hold the line, not a delegated tool). Any `fs/*` or `terminal/*` request
 *    gets `method not found`.
 * 2. `session/new` with the worktree, the HTTP MCP servers and the `_meta` of the setup, or
 *    `session/load` when the client announced `loadSession`.
 * 3. `session/set_config_option` for each config option of the setup.
 *
 * Then `session/update` goes through `normalizer.normalizeUpdate` to the listeners,
 * `session/request_permission` goes to `onPermission` (layer 2), a failure goes through
 * `normalizer.normalizeError` and comes out as the typed error, and `cancel` sends
 * `session/cancel` and, after a short grace period, ends the process tree. The contract of the
 * `AgentSession` itself lives in `ManagedAgentSession`, shared with every process-based transport.
 *
 * Several sessions on one process (`processModel: 'multi-session'`): the transport recognises the
 * process by its `stdin` stream object, so every session of a process must be opened with a
 * `LaunchedProcess` that exposes the same streams (the lease views of `SharedProcessRegistry` and
 * of the daemon pool do). `initialize` runs once; `session/update`, `session/request_permission`
 * and the `_otheater/*` requests are routed by the `sessionId` they carry, each to its own
 * session. [proposta] A message for a session this connection does not have is dropped (a
 * permission request is answered `cancelled`) and reported once through `onWarning` as
 * `unknown_session`; a late message of a session that already left is dropped without a warning.
 * `disconnect()` of a session closes the connection only when it was the last one, unless
 * `connectionLifetime` is `process`.
 *
 * The transport never reads the environment and never starts a process: the `LaunchedProcess`
 * arrives already running, started by the `ClientAdapter` through the `ProcessLauncher`.
 */
export class AcpTransport implements SessionTransport {
  readonly id = 'acp';
  readonly #options: AcpTransportOptions;
  /** One connection per client process, found by the process's input stream. */
  readonly #connections = new WeakMap<WritableStream<Uint8Array>, SharedConnection>();

  constructor(options: AcpTransportOptions = {}) {
    this.#options = options;
  }

  open(params: SessionOpenParams): Promise<ManagedAgentSession> {
    return this.#start(params, undefined);
  }

  load(params: SessionLoadParams): Promise<ManagedAgentSession> {
    return this.#start(params, params.sessionId);
  }

  async #start(
    params: SessionOpenParams,
    loadId: string | undefined,
  ): Promise<ManagedAgentSession> {
    if (params.setup.via !== 'acp') {
      throw new InvalidInput(`the acp transport needs an acp setup, got ${params.setup.via}`);
    }
    const { meta, configOptions } = params.setup;
    if (meta !== undefined && !isRecord(meta)) {
      throw new InvalidInput('the _meta of the session setup must be an object');
    }
    const shared = this.#sharedFor(params);
    const route: Route = {
      deliver: undefined,
      onPermission: params.onPermission,
      extensions: new Map((params.extensions ?? []).map((handler) => [handler.method, handler])),
      toolCalls: new ToolCallState(),
      abandoned: false,
    };
    shared.retain();
    // The id the route is known by, once it is registered: only then does a failure have to forget it.
    const known: { sessionId: string | undefined } = { sessionId: undefined };
    const timeout = timeoutAfter(
      this.#options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      'the client did not finish starting the session in time',
    );
    try {
      return await Promise.race([
        this.#handshake(shared, params, route, known, loadId, meta, configOptions),
        timeout.promise,
      ]);
    } catch (error) {
      shared.release(known.sessionId, route);
      throw this.#typedStartError(error, shared.connection, params, loadId !== undefined);
    } finally {
      timeout.stop();
    }
  }

  /** The connection of this process, created on its first session. */
  #sharedFor(params: SessionOpenParams): SharedConnection {
    const key = params.process.stdin;
    const existing = this.#connections.get(key);
    if (existing !== undefined && !existing.connection.signal.aborted) return existing;
    drain(params.process.stderr);
    const shared = new SharedConnection(this.#options.connectionLifetime ?? 'last_session', () => {
      if (this.#connections.get(key) === shared) this.#connections.delete(key);
    });
    shared.connection = this.#connect(shared, params);
    this.#connections.set(key, shared);
    void shared.connection.closed.then(() => {
      if (this.#connections.get(key) === shared) this.#connections.delete(key);
    });
    return shared;
  }

  #connect(shared: SharedConnection, params: SessionOpenParams): ClientConnection {
    const options = this.#options;
    /** The route of a message, or `undefined` after saying (once, and only if it is stray) why not. */
    const routeOf = (method: string, sessionId: string): Route | undefined => {
      const route = shared.routes.get(sessionId);
      if (route !== undefined) return route;
      if (!shared.wasClosed(sessionId) && shared.starting === 0) {
        options.onWarning?.({ kind: 'unknown_session', method, sessionId });
      }
      return undefined;
    };
    const app = client({ name: options.clientName ?? 'otheater' })
      .onRequest(methods.client.session.requestPermission, ({ params: request }) => {
        const route = routeOf(methods.client.session.requestPermission, request.sessionId);
        if (route === undefined) return CANCELLED;
        try {
          const answer = route.onPermission(
            permissionRequestOf(request, route.toolCalls.get(request.toolCall.toolCallId)),
          );
          return answer.outcome === 'selected'
            ? { outcome: { outcome: 'selected' as const, optionId: answer.optionId } }
            : CANCELLED;
        } catch (error) {
          // A handler that breaks must not leave a tool allowed: refuse, and say so.
          options.onWarning?.({ kind: 'permission_handler_threw', error });
          return CANCELLED;
        }
      })
      .onNotification(methods.client.session.update, ({ params: notification }) => {
        const route = routeOf(methods.client.session.update, notification.sessionId);
        if (route === undefined) return;
        // Remembered even before the session is delivered to (a load replays its history).
        route.toolCalls.record(notification.update);
        route.deliver?.(notification.update);
      })
      // `_otheater/*` is the only extension space the shell answers; the request names the session.
      .onRequest('*', async ({ method, params: request }) => {
        const sessionId =
          isRecord(request) && typeof request.sessionId === 'string'
            ? request.sessionId
            : undefined;
        const handler =
          sessionId === undefined
            ? undefined
            : shared.routes.get(sessionId)?.extensions.get(method);
        if (handler === undefined) throw RequestError.methodNotFound(method);
        try {
          return (await handler.handle(request)) ?? null;
        } catch (error) {
          if (error instanceof RequestError) throw error;
          options.onWarning?.({ kind: 'extension_handler_threw', method, error });
          throw RequestError.internalError(undefined, 'the extension handler failed');
        }
      });
    return app.connect(ndJsonStream(params.process.stdin, params.process.stdout));
  }

  /** `initialize` once per connection; the sessions after the first reuse the answer. */
  #initialize(shared: SharedConnection): Promise<Initialized> {
    const options = this.#options;
    shared.initialized ??= shared.connection.agent
      .request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // Explicitly nothing: no file system and no terminal for the client to call back into.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: {
          name: options.clientName ?? 'otheater',
          version: options.clientVersion ?? '0.0.0',
        },
      })
      .then((initialized) => {
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new AdapterUnavailable(
            `the client speaks ACP version ${String(initialized.protocolVersion)}, this transport speaks ${String(PROTOCOL_VERSION)}`,
          );
        }
        return {
          canLoad: initialized.agentCapabilities?.loadSession === true,
          mcpHttp: initialized.agentCapabilities?.mcpCapabilities?.http,
          agentInfo: agentInfoOf(initialized.agentInfo),
        };
      })
      .catch((error: unknown) => {
        // A failed `initialize` is not kept: the next session asks again.
        shared.initialized = undefined;
        throw error;
      });
    return shared.initialized;
  }

  async #handshake(
    shared: SharedConnection,
    params: SessionOpenParams,
    route: Route,
    known: { sessionId: string | undefined },
    loadId: string | undefined,
    meta: unknown,
    configOptions: Readonly<Record<string, string>>,
  ): Promise<ManagedAgentSession> {
    const options = this.#options;
    const { connection } = shared;
    const { canLoad, mcpHttp, agentInfo } = await this.#initialize(shared);
    if (agentInfo !== undefined) this.#announce(params, agentInfo);
    const mcpServers = this.#mcpServers(params, mcpHttp);
    const metaField = meta === undefined ? {} : { _meta: meta as Record<string, unknown> };

    let sessionId: string;
    let announced: SessionConfigOption[];
    if (loadId === undefined) {
      shared.starting += 1;
      let created: NewSessionResponse;
      try {
        created = await connection.agent.request(methods.agent.session.new, {
          cwd: params.cwd,
          mcpServers,
          ...metaField,
        });
      } finally {
        shared.starting -= 1;
      }
      sessionId = created.sessionId;
      announced = configOptionsOf(created.configOptions);
      this.#register(shared, route, known, sessionId);
    } else {
      if (!canLoad) {
        throw new AdapterUnavailable('the client did not announce loadSession');
      }
      sessionId = loadId;
      this.#register(shared, route, known, sessionId);
      const loaded = await connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: params.cwd,
        mcpServers,
        ...metaField,
      });
      announced = configOptionsOf(loaded.configOptions);
    }

    const session = new ManagedAgentSession({
      sessionId,
      canLoad,
      configOptions: announced,
      driver: new AcpDriver(shared, route, sessionId),
      process: params.process,
      normalizer: params.normalizer,
      ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
    for (const [configId, value] of Object.entries(configOptions)) {
      const answer = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
      });
      if (Array.isArray(answer.configOptions)) {
        session.updateConfigOptions(configOptionsOf(answer.configOptions));
      }
    }
    if (route.abandoned) throw new AdapterUnavailable('the session start was given up');
    // From here on the updates reach the session (and, through it, the listeners).
    route.deliver = (raw) => {
      // The client sends the full list again when an option changes by itself (a mode that
      // moves the model, say): the snapshot of the session follows before the listeners hear.
      if (isRecord(raw) && raw.sessionUpdate === 'config_option_update') {
        if (Array.isArray(raw.configOptions)) {
          session.updateConfigOptions(configOptionsOf(raw.configOptions));
        }
      }
      session.deliver(raw);
    };
    return session;
  }

  /** Tells the caller who the client is (N63). A callback that throws must not fail the open. */
  #announce(params: SessionOpenParams, agentInfo: AgentInfo): void {
    try {
      params.onAgentInfo?.(agentInfo);
    } catch (error) {
      this.#options.onWarning?.({ kind: 'agent_info_handler_threw', error });
    }
  }

  /** Puts the session in the route table; two sessions of one connection never share an id. */
  #register(
    shared: SharedConnection,
    route: Route,
    known: { sessionId: string | undefined },
    sessionId: string,
  ): void {
    if (route.abandoned) throw new AdapterUnavailable('the session start was given up');
    if (shared.routes.has(sessionId)) {
      throw new Conflict(`this connection already serves the session ${sessionId}`);
    }
    shared.routes.set(sessionId, route);
    known.sessionId = sessionId;
  }

  /** The HTTP MCP servers of the role, in ACP form; refuses what the client said it cannot take. */
  #mcpServers(params: SessionOpenParams, http: boolean | null | undefined): McpServer[] {
    if (params.mcpServers.length === 0) return [];
    if (http !== true) {
      throw new AdapterUnavailable(
        'the role names MCP servers and the client did not announce HTTP MCP support',
      );
    }
    return params.mcpServers.map((server) => ({
      type: 'http' as const,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
    }));
  }

  #typedStartError(
    error: unknown,
    connection: ClientConnection,
    params: SessionOpenParams,
    loading: boolean,
  ): OTheaterError {
    if (isOTheaterError(error)) return error;
    if (error instanceof RequestError) {
      if (loading && error.code === ACP_RESOURCE_NOT_FOUND) {
        return new NotFound(`the client has no such conversation: ${error.message}`, {
          cause: error,
        });
      }
      try {
        return typedErrorOf(params.normalizer.normalizeError(error));
      } catch (cause) {
        return new AdapterUnavailable('the client failed and its error could not be normalized', {
          cause,
        });
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    return new AdapterUnavailable(
      connection.signal.aborted
        ? 'the connection to the client closed before the session was ready'
        : `the client session could not be started: ${reason}`,
      { cause: error },
    );
  }
}
